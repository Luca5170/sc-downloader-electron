// 5.01.24 -> 7.01.24 -> 17.02.24

// Download of a m3u8 video: segments in parallel, decrypted, joined by ffmpeg with the audio

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const http = require('../util/http');
const storage = require('../util/storage');
const paths = require('../paths');
const m3u8 = require('./m3u8');
const ffmpeg = require('./ffmpeg');
const { getHeaders } = require('../util/headers');
const { console } = require('../util/console');
const { DownloadCancelled } = require('../util/cancel');
const {
  DownloadError, DiskFullError, isDiskFull, isNetworkError, isOnline, waitOnline, describeResponse, step, sleep,
} = require('../util/errors');

const MAX_WORKER = 12;          // Cdn of the site answer 503 when it gets too many segments together
const MIN_WORKER = 2;
const RETRY_WORKER = 2;         // Used for the segments that failed the first time
const BUSY_CODES = new Set([429, 500, 502, 503, 504]);
const MIN_FREE_SPACE = 2 * 1024 ** 3;           // Needed to start a download
const MIN_FREE_SPACE_JOIN = 200 * 1024 ** 2;    // Below this a failed join is a full disk
const COPY_CHUNK = 8 * 1024 * 1024;             // Pieces of a video copied to another disk


// [ helpers ]
function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 10);
}

function removeFolder(folder) {
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    // Removed at the next start
  }
}

/**
 * Move a file to its folder. On another disk it is copied without stopping the program (the page and the player are served
 * by this same thread), there it takes its name only when it is complete
 */
async function moveFile(source, target, progress = null) {
  fs.mkdirSync(path.dirname(target), { recursive: true });

  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }

  const tempPath = `${target}.parte`;
  const total = fs.statSync(source).size;
  let done = 0;

  try {
    await pipeline(fs.createReadStream(source, { highWaterMark: COPY_CHUNK }), async function* report(chunks) {
      for await (const chunk of chunks) {
        done += chunk.length;
        if (progress) progress(done, total);
        yield chunk;
      }
    }, fs.createWriteStream(tempPath));

    fs.renameSync(tempPath, target);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    throw error;
  }

  fs.unlinkSync(source);
}

/** Raise DiskFullError when the disk has less free space than needed */
function checkDisk(folder, needed = null) {
  let free;

  try {
    let existing = path.resolve(folder);
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    const stats = fs.statfsSync(existing);
    free = stats.bavail * stats.bsize;
  } catch {
    return;
  }

  if (free < (needed === null ? MIN_FREE_SPACE_JOIN : needed)) throw new DiskFullError(folder);
}

function decrypt(key, iv, data) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return m3u8.unpad(Buffer.concat([decipher.update(data), decipher.final()]));
}


/**
 * Limit how many segments are asked at the same time.
 * The cdn answers 503 when they are too many, so the limit goes down alone and comes back up slowly.
 */
class Throttle {
  constructor(limit = MAX_WORKER) {
    this.limit = limit;
    this.max = limit;
    this.active = 0;
    this.good = 0;
    this.waiters = [];
  }

  async acquire() {
    while (this.active >= this.limit) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((waiter) => waiter !== done);
          resolve();
        };
        const timer = setTimeout(done, 500);
        this.waiters.push(done);
      });
    }
    this.active++;
  }

  release() {
    this.active--;
    this.notify();
  }

  notify() {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  slowDown() {
    this.limit = Math.max(MIN_WORKER, Math.floor(this.limit / 2));
    this.good = 0;
  }

  speedUp() {
    this.good++;

    if (this.good >= 25 && this.limit < Math.max(this.max, MAX_WORKER)) {
      this.limit++;
      this.good = 0;
      this.notify();
    }
  }
}


class M3U8Segments {
  constructor(url, key = null, progressCallback = null, cacheName = null, offlineCallback = null) {
    this.url = url;
    this.key = key;
    this.progressCallback = progressCallback;
    this.offlineCallback = offlineCallback;
    this.playlist = null;
    this.segments = [];

    // Every download has its own folder. The name does not change when the download is started again,
    // so after a power cut or a lost connection the segments already saved are used again
    this.name = cacheName || md5(url);
    this.tempFolder = paths.tmp('segments', this.name);
    fs.mkdirSync(this.tempFolder, { recursive: true });

    this.progressTimeout = 60;
    this.maxRetry = 5;
    this.failedSegments = [];
    this.failureReasons = [];
    this.throttle = new Throttle();

    // Set when the download is stopped, every worker stops at its next step and the requests are interrupted
    this.stopped = false;
    this.abort = new AbortController();
    this.fatal = null;
    this.offlineWaiters = 0;
    this.saved = 0;

    // Bytes arrived from the network, the gui shows the speed of the download with them
    this.received = 0;

    // One user agent and one session for the whole download
    this.session = new http.Session({ 'user-agent': getHeaders() });
  }

  parseData(content) {
    this.playlist = m3u8.parse(content, this.url);

    // A playlist with vtt inside is a subtitle, its segments are not video
    this.entries = this.playlist.segments.map((segment, index) => ({ ...segment, index })).filter((segment) => !segment.uri.includes('vtt'));
    this.segments = this.entries.map((segment) => segment.uri);
  }

  /** Make req to index m3u8 */
  async getInfo(check = null) {
    const response = await http.get(this.url, { session: this.session, wait: true, check });

    if (!response.ok) throw new DownloadError(describeResponse(response, 'Il server del video'));

    this.parseData(response.text);

    if (!this.segments.length) throw new DownloadError('Il video non ha segmenti da scaricare');

    this.checkCache();
  }

  /** The playlist without its token, the same video gives the same identity also with a new token */
  getIdentity() {
    const address = new URL(this.url);
    const query = [...address.searchParams.entries()].filter(([name]) => !['token', 'expires', 'edge', 'h'].includes(name)).sort();
    return `${address.host}${address.pathname}?${new URLSearchParams(query)}|${this.segments.length}`;
  }

  /** Segments saved before are kept only if they are of this same video and quality */
  checkCache() {
    const metaPath = path.join(this.tempFolder, 'meta.json');
    const identity = this.getIdentity();
    const saved = storage.readJson(metaPath, {});

    if (!storage.isObject(saved) || saved.identity !== identity) {
      removeFolder(this.tempFolder);
      fs.mkdirSync(this.tempFolder, { recursive: true });
      storage.writeJson(metaPath, { identity });
    } else {
      const ready = this.segments.filter((_, index) => fs.existsSync(this.segmentPath(index))).length;
      if (ready) console.log(`Resume: ${ready} of ${this.segments.length} segments already saved`);
    }
  }

  segmentPath(index) {
    return path.join(this.tempFolder, `${index}.ts`);
  }

  /** Send the progress, raise DownloadCancelled if the download has been stopped */
  check() {
    if (this.stopped) throw this.fatal || new DownloadCancelled();

    // The callback of the gui raises DownloadCancelled when the user cancels
    if (this.progressCallback) this.progressCallback(this.saved, this.segments.length, this.received);
  }

  /** Sleep before a new attempt, but stop at once if the download is cancelled */
  async wait(seconds) {
    const end = Date.now() + seconds * 1000;

    while (Date.now() < end) {
      this.check();
      await sleep(Math.max(0, Math.min(500, end - Date.now())));
    }
  }

  /** Internet is missing: the download stops here until it comes back, nothing is lost */
  async waitOnline() {
    if (await isOnline()) return;

    // Many workers wait together, the gui and the console hear it once
    this.offlineWaiters++;
    if (this.offlineWaiters === 1) {
      console.log('Connection lost, waiting for it to come back');
      if (this.offlineCallback) this.offlineCallback(true);
    }

    try {
      if (!(await waitOnline(() => this.check()))) {
        throw new DownloadError('Connessione a internet assente da troppo tempo, il download riprenderà più tardi');
      }
    } finally {
      this.offlineWaiters--;
      if (this.offlineWaiters === 0) {
        console.log('Connection is back, the download goes on');
        if (this.offlineCallback) this.offlineCallback(false);
      }
    }
  }

  /** Single req to a ts file to get content, retry when the server is busy */
  async getReqTs(tsUrl) {
    let reason = null;
    let attempt = 0;

    while (attempt <= this.maxRetry) {
      this.check();

      try {
        let response;
        await this.throttle.acquire();

        try {
          response = await http.send('GET', tsUrl, {
            session: this.session,
            timeout: 20,
            signal: this.abort.signal,
            onChunk: (size) => { this.received += size; },
          });
        } finally {
          this.throttle.release();
        }

        if (response.status === 200) {
          const expected = response.headers.get('content-length');

          // A connection closed in the middle gives a shorter segment
          if (expected && /^\d+$/.test(expected) && !response.headers.get('content-encoding') && response.content.length !== Number(expected)) {
            throw Object.assign(new Error('segmento incompleto'), { code: 'ECONNRESET' });
          }

          this.throttle.speedUp();
          return response.content;
        }

        reason = `HTTP ${response.status}`;

        // Too many segments asked together, everyone slows down
        if (BUSY_CODES.has(response.status)) {
          this.throttle.slowDown();

        // Expired link: trying again does not help, the download is started again with a new link
        } else if ([401, 403, 404, 410].includes(response.status) && attempt >= 1) {
          break;
        }

      } catch (error) {
        if (this.stopped) throw this.fatal || new DownloadCancelled();
        if (!isNetworkError(error)) throw error;

        reason = error.code || error.name;

        // Without internet the attempts are not wasted, the download waits for the connection
        if (!(await isOnline())) {
          await this.waitOnline();
          continue;
        }
      }

      attempt++;
      if (attempt <= this.maxRetry) await this.wait(Math.min(2 ** attempt, 20) + Math.random());
    }

    this.failureReasons.push(reason);
    return null;
  }

  /** Save ts file and decrypt if there is a key */
  async saveTs(index) {
    this.check();

    const tsFilename = this.segmentPath(index);

    if (!fs.existsSync(tsFilename)) {
      try {
        let content = await this.getReqTs(this.segments[index]);

        // A segment that is not saved is not progress, it is asked again later
        if (content === null) {
          this.failedSegments.push(index);
          return;
        }

        const segment = this.entries[index];
        if (this.key && segment.key) content = decrypt(this.key, m3u8.getIv(this.playlist, segment.index), content);

        // The segment gets its name only when it is complete, a power cut never leaves half a segment
        const tempFilename = `${tsFilename}.part`;
        await fs.promises.writeFile(tempFilename, content);
        await fs.promises.rename(tempFilename, tsFilename);

      } catch (error) {
        if (error instanceof DownloadCancelled || error instanceof DownloadError) throw error;
        if (isDiskFull(error)) throw new DiskFullError(this.tempFolder);

        // Any other problem (a segment that cant be decrypted...) is a missing segment, never a hole in the video
        this.failedSegments.push(index);
        this.failureReasons.push(error.code || error.name);
        return;
      }
    }

    this.saved++;
    this.check();
  }

  /** Download every segment, the ones refused by the server are asked again slowly */
  async downloadTs() {
    this.saved = 0;

    try {
      await this.downloadPass([...this.segments.keys()], MAX_WORKER);

      if (this.failedSegments.length) {
        const missing = [...new Set(this.failedSegments)].sort((a, b) => a - b);
        this.failedSegments = [];
        console.log(`Retry of ${missing.length} segments with ${RETRY_WORKER} connections`);

        this.throttle = new Throttle(RETRY_WORKER);
        await this.downloadPass(missing, RETRY_WORKER);
      }

    } catch (error) {
      // Nothing of a cancelled download is kept, unless the program is only closing
      if (error instanceof DownloadCancelled && !error.keepFiles) this.clean();
      throw error;
    }

    // The segments saved stay in tmp: the next attempt downloads only the missing ones
    if (this.failedSegments.length) {
      const missing = new Set(this.failedSegments).size;
      throw new DownloadError(`${missing} segmenti su ${this.segments.length} non scaricati (${this.getFailures()}), il download riprenderà da qui`);
    }
  }

  /** Download a group of segments and wait for all of them */
  async downloadPass(indexes, workers) {
    const queue = [...indexes];
    let lastCount = this.saved;
    let lastChange = Date.now();
    let failure = null;

    const stop = (error) => {
      if (failure) return;
      failure = error;
      if (error instanceof DownloadError) this.fatal = error;
      this.stopped = true;
      this.abort.abort(error);
    };

    // Warn when no segment is saved for a while, and see a cancel also when nothing arrives
    const timer = setInterval(() => {
      if (this.saved !== lastCount) {
        lastCount = this.saved;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > this.progressTimeout * 1000) {
        console.log(`No segment saved in the last ${this.progressTimeout} seconds, the server is busy`);
        lastChange = Date.now();
      }

      try {
        if (!this.stopped) this.check();
      } catch (error) {
        stop(error);
      }
    }, 500);

    const worker = async () => {
      while (queue.length && !failure) {
        const index = queue.shift();

        try {
          await this.saveTs(index);
        } catch (error) {
          if (error instanceof DownloadCancelled || error instanceof DownloadError) {
            stop(error);
          } else {
            console.log(`Segment error: ${error.message}`);
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));
    } finally {
      clearInterval(timer);
    }

    if (failure) throw failure;
  }

  clean() {
    removeFolder(this.tempFolder);
  }

  /** Most common reasons of the segments that are still missing */
  getFailures() {
    const counts = new Map();
    for (const reason of this.failureReasons) counts.set(reason, (counts.get(reason) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${reason}: ${count}`).join(', ');
  }

  /** Join all segments file to a mp4 file name */
  async join(outputFilename, check = null) {
    // A video with a hole is worse than no video: every segment must be there
    const missing = this.segments.filter((_, index) => !fs.existsSync(this.segmentPath(index)));
    if (missing.length) throw new DownloadError(`${missing.length} segmenti mancanti, il download riprenderà da qui`);

    // Segments of this playlist in their order, the list stays in the same folder
    const fileListPath = path.join(this.tempFolder, 'file_list.txt');
    fs.writeFileSync(fileListPath, this.segments.map((_, index) => `file '${index}.ts'\n`).join(''));

    console.log('Start join all file');
    try {
      await ffmpeg.run(['-f', 'concat', '-safe', '0', '-i', fileListPath, '-c', 'copy', '-loglevel', 'error', '-y', outputFilename], check);

    } catch (error) {
      if (error instanceof DownloadCancelled) {
        if (!error.keepFiles) this.clean();
        throw error;
      }
      if (!(error instanceof ffmpeg.FfmpegError)) throw error;

      console.log(`FFmpeg: ${error.stderr}`);
      checkDisk(path.dirname(outputFilename));
      throw new DownloadError('FFmpeg non è riuscito a unire i segmenti del video');
    }

    console.log('Clean ...');
    this.clean();
  }
}


class M3U8Downloader {
  constructor(m3u8Url, m3u8Audio = null, key = null, outputFilename = 'output.mp4', progressCallback = null, subtitles = null) {
    this.m3u8Url = m3u8Url;
    this.m3u8Audio = m3u8Audio;
    this.key = key;
    this.videoPath = outputFilename;
    this.progressCallback = progressCallback;
    this.subtitles = subtitles || [];

    // The file is built in tmp and reaches its folder only when it is complete.
    // The name does not change with the folder of the videos, the segments saved before are used again
    this.name = md5(path.resolve(paths.stableVideoPath(outputFilename)));
    this.workFolder = paths.tmp('output', this.name);
    this.tempVideo = path.join(this.workFolder, 'video.mp4');
    this.tempAudio = path.join(this.workFolder, 'audio.mp4');
    this.tempMerged = path.join(this.workFolder, 'merged.mp4');
    this.tempSubtitled = path.join(this.workFolder, 'subtitled.mp4');
  }

  /**
   * Notify progress of current stage (video, join_video, audio, join_audio, merge, save),
   * with the bytes received in the stage when there are some.
   * The callback raises DownloadCancelled to stop the download.
   */
  updateProgress(stage, done = 0, total = 0, received = null) {
    if (this.progressCallback) this.progressCallback(stage, done, total, received);
  }

  /** The gui shows that the download waits for the connection */
  setOffline(offline) {
    // A cancel is seen by the next check of the workers, not here
    try {
      if (this.progressCallback) this.progressCallback(offline ? 'offline' : 'online', 0, 0);
    } catch (error) {
      if (!(error instanceof DownloadCancelled)) throw error;
    }
  }

  async start() {
    // Half files of a join stopped by a power cut
    removeFolder(this.workFolder);
    checkDisk(paths.tmp(), MIN_FREE_SPACE);

    // The folder of the videos can be on another disk, better to know it before downloading
    checkDisk(path.dirname(this.videoPath), MIN_FREE_SPACE);
    fs.mkdirSync(this.workFolder, { recursive: true });

    try {
      const result = await this.download();
      await step('Salvataggio del file', () => moveFile(result, this.videoPath, (done, total) => this.updateProgress('save', done, total, done)));

    } catch (error) {
      if (isDiskFull(error)) throw new DiskFullError(this.workFolder);
      throw error;

    } finally {
      // Segments stay in tmp/segments for the next attempt, the half built files never
      removeFolder(this.workFolder);
    }
  }

  /** Download video and audio, return the complete file inside the work folder */
  async download() {
    const video = new M3U8Segments(this.m3u8Url, this.key, (done, total, received) => this.updateProgress('video', done, total, received),
      `${this.name}_video`, (offline) => this.setOffline(offline));

    console.log('Download video ts');
    await step('Download del video', async () => {
      await video.getInfo(() => this.updateProgress('video'));
      await video.downloadTs();
    });
    this.updateProgress('join_video');
    await step('Unione dei segmenti del video', () => video.join(this.tempVideo, () => this.updateProgress('join_video')));

    if (!this.m3u8Audio) return this.addSubtitles(this.tempVideo);

    const audio = new M3U8Segments(this.m3u8Audio, this.key, (done, total, received) => this.updateProgress('audio', done, total, received),
      `${this.name}_audio`, (offline) => this.setOffline(offline));

    console.log('Download audio ts');
    await step("Download dell'audio", async () => {
      await audio.getInfo(() => this.updateProgress('audio'));
      await audio.downloadTs();
    });
    this.updateProgress('join_audio');
    await step("Unione dei segmenti dell'audio", () => audio.join(this.tempAudio, () => this.updateProgress('join_audio')));

    this.updateProgress('merge');
    const merged = await step('Unione di audio e video', () => this.joinAudio());

    return this.addSubtitles(merged);
  }

  /** Put the subtitles inside the file, return the file to keep: a problem with them never costs the video */
  async addSubtitles(videoPath) {
    if (!this.subtitles.length) return videoPath;

    this.updateProgress('merge');

    return step('Aggiunta dei sottotitoli', async () => {
      const inputs = ['-i', videoPath];
      const options = ['-map', '0', '-c', 'copy', '-c:s', 'mov_text'];

      this.subtitles.forEach((track, index) => {
        const subtitlePath = path.join(this.workFolder, `subtitle_${index}.vtt`);
        fs.writeFileSync(subtitlePath, track.text);

        const flags = ['default', 'forced'].filter((name) => track[name]);

        // The format is told to ffmpeg: this file comes from the site, it must not guess what it is.
        // In a mp4 the name of a track is its handler, a title would not be saved
        inputs.push('-f', 'webvtt', '-i', subtitlePath);
        options.push('-map', `${index + 1}:s`,
          `-metadata:s:s:${index}`, `language=${track.language}`,
          `-metadata:s:s:${index}`, `handler_name=${track.title}`,
          `-disposition:s:${index}`, flags.join('+') || '0');
      });

      try {
        await ffmpeg.run(['-y', '-loglevel', 'error', ...inputs, ...options, this.tempSubtitled], () => this.updateProgress('merge'));

      } catch (error) {
        if (!(error instanceof ffmpeg.FfmpegError)) throw error;
        checkDisk(this.workFolder);
        console.log(`Subtitles not added to the video: ${error.stderr}`);
        return videoPath;
      }

      console.print(`Subtitles added: ${this.subtitles.map((track) => track.title).join(', ')}`);
      return this.tempSubtitled;
    });
  }

  /** Join audio with video and sync it, return the file to keep */
  async joinAudio() {
    try {
      await ffmpeg.run([
        '-i', this.tempVideo, '-i', this.tempAudio, '-map', '0:v', '-map', '1:a',
        '-vcodec', 'copy', '-acodec', 'copy', '-shortest', '-strict', 'experimental', '-loglevel', 'error', '-y', this.tempMerged,
      ], () => this.updateProgress('merge'));

    } catch (error) {
      if (!(error instanceof ffmpeg.FfmpegError)) throw error;
      checkDisk(this.workFolder);

      // Audio is kept apart, next to the video
      const audioPath = this.videoPath.replace(/\.[^.\\/]+$/, '') + '.audio.mp4';
      await moveFile(this.tempAudio, audioPath);
      console.log(`Error merging audio, audio saved in ${audioPath}: ${error.stderr}`);
      return this.tempVideo;
    }

    console.print('Merge completed successfully.');
    return this.tempMerged;
  }
}


async function downloadM3u8({ m3u8Index, m3u8Audio = null, subtitles = null, key = null, outputFilename, progressCallback = null }) {
  // Get byte of key
  const keyBytes = key ? Buffer.from(key, 'hex') : null;

  await step('Creazione della cartella dei video', async () => fs.mkdirSync(path.dirname(outputFilename), { recursive: true }));
  await new M3U8Downloader(m3u8Index, m3u8Audio, keyBytes, outputFilename, progressCallback, subtitles).start();
}

module.exports = { downloadM3u8, M3U8Downloader, M3U8Segments, Throttle, checkDisk, moveFile, decrypt };

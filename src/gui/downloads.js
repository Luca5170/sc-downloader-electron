// 15.09.26

const fs = require('fs');
const anime = require('../api/anime');
const film = require('../api/film');
const tv = require('../api/tv');
const nas = require('../lib/nas');
const history = require('../util/history');
const storage = require('../util/storage');
const { DownloadCancelled } = require('../util/cancel');
const { console } = require('../util/console');
const { AppError, DownloadError, describeAsync, isDiskFull, isOnline, sleep, step } = require('../util/errors');
const { logError } = require('../util/log');
const { AsyncQueue } = require('../util/pool');

const JOBS_FILE = 'downloads.json';
const MAX_SAVED_JOBS = 300;
const ACTIVE = ['queued', 'running', 'waiting'];
const RETRY_DELAYS = [30, 120, 600];    // Seconds before the automatic attempts after an error
const NAS_RETRY_INTERVAL = 120;         // How often the files the nas refused are tried again
const MAX_AUTO_UPLOADS = 5;
const SPEED_WINDOW = 5;                 // Seconds of the speed shown, short enough to follow the changes
const TRANSIENT = ['cancel', 'stage', 'done', 'total', 'waiting'];

class ApiError extends AppError {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function now() {
  return Date.now() / 1000;
}

function parseInt_(value, name) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (value === null || value === undefined || String(value).trim() === '' || !Number.isInteger(number)) {
    throw new ApiError(`Parametro non valido: ${name}`);
  }
  return number;
}

function parseSlug(value) {
  // Slug is used in urls and file names
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_+-]+$/u.test(value)) throw new ApiError('Parametro non valido: slug');
  return value;
}

function isFile(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}


/**
 * Queue of downloads, executed one at a time.
 * The queue is saved on disk: after a crash or a power cut the downloads go on from where they were.
 */
class DownloadManager {
  constructor(site) {
    this.site = site;
    this.jobs = [];
    this.queue = new AsyncQueue();
    this.nextId = 1;
    this.speeds = new Map();    // Bytes of the running job along the time, the base of the speed shown
    this.load();

    this.worker();
    this.scheduler();
  }

  // [ saved queue ]
  /** Downloads of the last time: the ones not finished start again by themselves */
  load() {
    const saved = storage.readJson(JOBS_FILE, {});
    const jobs = storage.isObject(saved) && Array.isArray(saved.jobs) ? saved.jobs : [];
    let resumed = 0;

    for (const value of jobs) {
      if (!storage.isObject(value) || !Number.isInteger(value.id)) continue;

      const job = { ...this.emptyJob(), ...value, cancel: false, stage: null, done: 0, total: 0, waiting: null };

      if (ACTIVE.includes(job.status)) {
        // An upload whose file is gone cant go on
        if (job.upload_only && !isFile(job.output)) {
          Object.assign(job, { status: 'error', error: "Il file da caricare non c'è più", upload_only: false });
        } else {
          Object.assign(job, { status: 'queued', retry_at: null });
          resumed++;
        }
      } else if (!['done', 'error', 'cancelled'].includes(job.status)) {
        continue;
      }

      this.jobs.push(job);
    }

    this.jobs = this.jobs.slice(-MAX_SAVED_JOBS);
    this.nextId = Math.max(0, ...this.jobs.map((job) => job.id)) + 1;

    for (const job of this.jobs) if (job.status === 'queued') this.queue.put(job);

    if (resumed) console.print(`Resumed ${resumed} downloads of the last time`);
  }

  /** Write the queue on disk, a full disk is not a reason to stop the downloads */
  save() {
    const jobs = this.jobs.filter((job) => job.status !== 'removed')
      .map((job) => Object.fromEntries(Object.entries(job).filter(([key]) => !TRANSIENT.includes(key))));

    try {
      storage.writeJson(JOBS_FILE, { jobs: jobs.slice(-MAX_SAVED_JOBS) }, 2);
    } catch (error) {
      logError('Downloads queue not saved', error);
    }
  }

  // [ jobs ]
  emptyJob() {
    return {
      id: null,
      source: 'sc',
      title_id: null,
      slug: null,
      name: null,
      type: 'movie',
      year: null,
      poster: null,
      season: null,
      episode_id: null,
      episode_number: null,
      episode_name: null,
      status: 'queued',
      stage: null,
      done: 0,
      total: 0,
      error: null,
      warning: null,
      output: null,
      remote: null,
      upload_only: false,
      cancel: false,
      attempt: 0,               // Automatic attempts after an error
      retry_at: null,
      waiting: null,            // 'offline' while the connection is missing
      auto_uploads: 0,
      upload_cancelled: false,
    };
  }

  makeJob(item) {
    if (!storage.isObject(item)) throw new ApiError('Elemento da scaricare non valido');

    const job = {
      ...this.emptyJob(),
      source: item.source === 'anime' ? 'anime' : 'sc',
      title_id: parseInt_(item.id, 'id'),
      slug: parseSlug(item.slug),
      name: String(item.name || item.slug),
      type: item.type === 'tv' ? 'tv' : 'movie',
      year: item.year ? String(item.year).slice(0, 4) : null,
      poster: typeof item.poster === 'string' ? item.poster : null,
    };

    if (job.source === 'anime') {
      // Films of anime have a single episode, it is found when the download starts
      if (job.type === 'tv') {
        job.episode_id = parseInt_(item.episode_id, 'episode_id');
        job.episode_number = String(item.episode_number ?? '');
      }
    } else if (job.type === 'tv') {
      job.season = parseInt_(item.season, 'season');
      job.episode_id = parseInt_(item.episode_id, 'episode_id');
      job.episode_number = parseInt_(item.episode_number, 'episode_number');
      job.episode_name = String(item.episode_name || '');
    }

    return job;
  }

  add(items) {
    const jobs = items.map((item) => this.makeJob(item));
    const added = [];

    for (const job of jobs) {
      // Ids of the two sites can be the same number
      const duplicate = this.jobs.find((other) => ACTIVE.includes(other.status)
        && other.source === job.source && other.title_id === job.title_id && other.episode_id === job.episode_id);

      if (!duplicate) {
        job.id = this.nextId++;
        this.jobs.push(job);
        this.queue.put(job);
        added.push(job);
      }
    }

    this.save();
    return added.map((job) => ({ ...job }));
  }

  // [ worker ]
  /** Nothing can stop the queue: an unexpected error ends only its download */
  async worker() {
    for (;;) {
      const job = await this.queue.get();

      try {
        await this.run(job);
      } catch (error) {
        logError(`Unexpected error in the downloads queue (${job.name})`, error);
        if (job.status === 'running') Object.assign(job, { status: 'error', error: await describeAsync(error), waiting: null });
        this.save();
      }
    }
  }

  async run(job) {
    if (job.status !== 'queued') return;
    Object.assign(job, { status: 'running', waiting: null, retry_at: null, stage: null, done: 0, total: 0 });

    this.save();
    console.print(`\nGUI download => ${job.name}`);
    const progress = (stage, done, total, received = null) => this.update(job, stage, done, total, received);
    const uploadOnly = job.upload_only;
    let output = null;
    let remote = null;
    let warning = null;
    let status = 'done';
    let error = null;
    let retry = false;

    try {
      const result = uploadOnly ? await nas.finalize(job.output, this.getMedia(job), progress) : await this.download(job, progress);

      // A nas that does not answer leaves the file here, with a warning
      ({ path: output, remote, warning } = result);

    } catch (failure) {
      if (failure instanceof DownloadCancelled) {
        if (failure.keepFiles) {
          // The program is closing: the download goes on at the next start
          status = 'queued';
          console.print(`GUI download paused => ${job.name}`);
        } else {
          status = 'cancelled';
          console.print(`GUI download cancelled => ${job.name}`);
        }
      } else {
        status = 'error';
        error = await describeAsync(failure);
        retry = this.canRetry(failure);
        console.print(`GUI download failed => ${job.name}: ${error}`);
        logError(`Download failed (${job.name})`, failure);
      }
    }

    // Past downloads are the base of the recommendations, a history not saved is not a failed download
    if (status === 'done' && !uploadOnly) {
      try {
        history.add(job.title_id, job.slug, job.name, job.type, job.year, null, job.source);
      } catch (failure) {
        logError('History not saved', failure);
      }
    }

    const userCancel = job.cancel === true;
    this.speeds.delete(job.id);

    if (status === 'error' && retry && job.attempt < RETRY_DELAYS.length && !job.cancel) {
      // Tried again later by itself, the segments already saved are kept
      const delay = RETRY_DELAYS[job.attempt];
      job.attempt += 1;
      Object.assign(job, { status: 'waiting', error, retry_at: now() + delay, waiting: null });
      console.print(`New attempt in ${delay} seconds => ${job.name}`);

    } else {
      Object.assign(job, { status, error, waiting: null, cancel: false });

      if (status !== 'queued') {
        // A failed upload keeps its file on the pc, a failed download has no file
        const kept = uploadOnly ? job.output : null;
        Object.assign(job, { output: status === 'done' ? output : kept, remote, warning, upload_only: false });
      }

      if (status === 'done') {
        job.attempt = 0;
        job.upload_cancelled = Boolean(warning && userCancel);
      }
    }

    this.save();
  }

  /** Errors that can go away by themselves: connection, site busy, expired links */
  canRetry(error) {
    if (error instanceof DownloadError) return error.retry;
    if (['EACCES', 'EPERM'].includes(error?.code) || isDiskFull(error)) return false;
    return true;
  }

  /** Start again the downloads waiting for a new attempt, and upload the files the nas refused */
  async scheduler() {
    let lastNasCheck = Date.now();

    for (;;) {
      await sleep(2000);

      try {
        await this.resumeWaiting();

        if (Date.now() - lastNasCheck > NAS_RETRY_INTERVAL * 1000) {
          lastNasCheck = Date.now();
          await this.retryPendingUploads();
        }
      } catch (error) {
        logError('Scheduler of the downloads', error);
      }
    }
  }

  async resumeWaiting() {
    const time = now();
    const ready = this.jobs.filter((job) => job.status === 'waiting' && job.retry_at && job.retry_at <= time);

    // Without internet the attempt would fail again at once
    if (!ready.length || !(await isOnline())) return;

    for (const job of ready) {
      if (job.status === 'waiting') {
        Object.assign(job, { status: 'queued', retry_at: null });
        this.queue.put(job);
      }
    }

    this.save();
  }

  /** Files left on the pc because the nas was off go there when it comes back */
  async retryPendingUploads() {
    const config = nas.loadConfig();
    if (!nas.isEnabled(config)) return;

    const pending = this.jobs.filter((job) => job.status === 'done' && job.warning && !job.upload_cancelled
      && job.auto_uploads < MAX_AUTO_UPLOADS && isFile(job.output));

    if (!pending.length || !(await nas.isReachable(config))) return;

    for (const job of pending) {
      job.auto_uploads += 1;
      console.print(`NAS is back, upload of ${job.name}`);
      this.retryUpload(job.id);
    }
  }

  /** Data used to name the file and to build the path on the nas */
  getMedia(job) {
    if (job.source === 'anime') {
      return { name: job.name, year: job.year, type: 'anime', single: job.type === 'movie', episode_number: job.episode_number };
    }

    const media = { name: job.name, year: job.year, type: job.type };
    if (job.type === 'tv') Object.assign(media, { season: job.season, episode_number: job.episode_number, episode_name: job.episode_name });

    return media;
  }

  async download(job, progress) {
    const media = this.getMedia(job);
    this.checkCancel(job);

    if (job.source === 'anime') return this.downloadAnime(job, progress, media);

    // The site is asked again at every attempt, it could have changed domain version meanwhile
    if (this.site.version === null) await step('Collegamento al sito', () => this.site.connect());

    const domain = this.site.domain;

    if (job.type === 'movie') return film.mainDwFilm(job.title_id, job.slug, domain, progress, media);

    const { episodes, index, token } = await step("Ricerca dell'episodio sul sito", async () => {
      const props = await this.site.request((site, version) => tv.getSeason(job.title_id, job.slug, site, version, job.season));
      const list = props.loadedSeason.episodes.map((episode) => ({ id: episode.id, n: episode.number, name: episode.name }));
      const found = list.findIndex((episode) => episode.id === job.episode_id);

      if (found < 0) throw new DownloadError(`La stagione ${job.season} non contiene più questo episodio`, false);

      return { episodes: list, index: found, token: await tv.getToken(job.title_id, domain) };
    });

    this.checkCancel(job);
    return tv.dwSingleEp(job.title_id, episodes, index, domain, token, job.slug, job.season, progress, media);
  }

  async downloadAnime(job, progress, media) {
    let episodeId = job.episode_id;
    let number = job.episode_number;

    // A film of anime is its first and only episode
    if (episodeId === null) {
      const episodes = await step('Ricerca del film su AnimeUnity', () => anime.client.getEpisodes(job.title_id, 1, 1));

      if (!episodes.length) throw new DownloadError('AnimeUnity non ha nessun episodio per questo titolo', false);

      episodeId = parseInt(episodes[0].id, 10);
      number = String(episodes[0].number);
    }

    this.checkCancel(job);
    return anime.dwEpisode(job.title_id, job.slug, episodeId, number, progress, media);
  }

  /** Progress of a job, it stops the download when the user cancels it */
  update(job, stage, done, total, received = null) {
    this.checkCancel(job);

    // Waiting for the connection is shown without losing the progress
    if (stage === 'offline' || stage === 'online') {
      job.waiting = stage === 'offline' ? 'offline' : null;
    } else {
      Object.assign(job, { stage, done, total });
      // The upload counts the bytes sent to the nas
      this.sampleSpeed(job.id, stage, stage === 'upload' ? done : received);
    }
  }

  /** Bytes moved until now */
  sampleSpeed(jobId, stage, amount) {
    // Joining and merging move nothing on the network
    if (amount === null || amount === undefined) {
      this.speeds.delete(jobId);
      return;
    }

    const time = now();
    const speed = this.speeds.get(jobId);

    // Every stage counts its bytes from zero
    if (!speed || speed.stage !== stage || amount < speed.samples[speed.samples.length - 1][1]) {
      this.speeds.set(jobId, { stage, samples: [[time, amount]] });
      return;
    }

    const samples = speed.samples;

    // The progress arrives many times a second, one sample every half second is enough
    if (samples.length > 1 && time - samples[samples.length - 2][0] < 0.5) samples[samples.length - 1] = [time, amount];
    else samples.push([time, amount]);

    // The oldest sample kept is the start of the window
    while (samples.length > 2 && samples[1][0] <= time - SPEED_WINDOW) samples.shift();
  }

  /** Bytes per second of the last seconds, null while there is nothing to measure */
  getSpeed(jobId, time) {
    const speed = this.speeds.get(jobId);
    if (!speed) return null;

    const [start, first] = speed.samples[0];
    const [end, last] = speed.samples[speed.samples.length - 1];

    // Too soon after the start of the stage to tell
    if (time - start < 1) return null;

    // A download that does not move goes down to zero by itself
    if (time - end > SPEED_WINDOW) return 0;
    return Math.round((last - first) / (time - start));
  }

  checkCancel(job) {
    if (job.cancel) throw new DownloadCancelled(job.cancel === 'shutdown');
  }

  /**
   * The program is closing: the running download stops but keeps its segments,
   * the queue stays saved and goes on at the next start
   */
  async stop(timeout = 15) {
    for (const job of this.jobs) if (job.status === 'running') job.cancel = 'shutdown';

    const end = Date.now() + timeout * 1000;
    while (Date.now() < end && this.jobs.some((job) => job.status === 'running')) await sleep(200);

    this.save();
  }

  /** Stop a running download, or take a waiting one out of the queue */
  cancel(jobId) {
    const job = this.jobs.find((item) => item.id === jobId);

    if (!job || !ACTIVE.includes(job.status)) return false;

    if (['queued', 'waiting'].includes(job.status)) {
      // Worker skip removed jobs still in queue
      job.status = 'removed';
      this.jobs.splice(this.jobs.indexOf(job), 1);
    } else {
      job.cancel = true;
    }

    this.save();
    return true;
  }

  isBusy() {
    return this.jobs.some((job) => ACTIVE.includes(job.status));
  }

  list() {
    const time = now();
    // A failed upload can be retried, the file is still here
    const enabled = nas.isEnabled();

    return this.jobs.map((value) => {
      const job = { ...value };
      job.speed = job.status === 'running' && !job.waiting ? this.getSpeed(job.id, time) : null;
      job.can_upload = Boolean(enabled && (job.warning || job.status === 'error') && isFile(job.output));
      job.retry_in = job.status === 'waiting' && job.retry_at ? Math.max(0, Math.round(job.retry_at - time)) : null;
      job.cancel = Boolean(job.cancel);
      return job;
    });
  }

  retryUpload(jobId) {
    const job = this.jobs.find((item) => item.id === jobId && item.output && ['done', 'error'].includes(item.status) && (item.warning || item.status === 'error'));

    if (!job) return false;

    Object.assign(job, { status: 'queued', stage: null, done: 0, total: 0, error: null, warning: null, upload_only: true, cancel: false, upload_cancelled: false });
    this.queue.put(job);

    this.save();
    return true;
  }

  remove(jobId) {
    const job = this.jobs.find((item) => item.id === jobId && item.status !== 'running');

    if (!job) return false;

    // Worker skip removed jobs still in queue
    job.status = 'removed';
    this.jobs.splice(this.jobs.indexOf(job), 1);

    this.save();
    return true;
  }

  clear() {
    this.jobs = this.jobs.filter((job) => ACTIVE.includes(job.status));
    this.save();
  }

  getOutput(jobId) {
    return this.jobs.find((job) => job.id === jobId)?.output || null;
  }
}

module.exports = { DownloadManager, ApiError, ACTIVE, parseInt: parseInt_, parseSlug };

// 20.10.26

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nas = require('../lib/nas');
const checks = require('../lib/torrent/checks');
const torrentConfig = require('../lib/torrent/config');
const jackett = require('../lib/torrent/jackett');
const plugins = require('../lib/torrent/plugins');
const probe = require('../lib/torrent/probe');
const qbittorrent = require('../lib/torrent/qbittorrent');
const release = require('../lib/torrent/release');
const storage = require('../util/storage');
const platform = require('../platform');
const { DownloadCancelled } = require('../util/cancel');
const { console } = require('../util/console');
const { AppError, describe, sleep } = require('../util/errors');
const { logError } = require('../util/log');
const { AsyncQueue, Wake } = require('../util/pool');

const ITEMS_FILE = 'torrents.json';
const MAX_RESULTS = 3000;               // Results of the searches kept, the page asks for them by id
const MAX_ITEMS = 200;
const POLL_ACTIVE = 2;                  // Seconds between two questions to qbittorrent while something moves
const POLL_IDLE = 15;
const METADATA_TIMEOUT = 180;           // A magnet nobody shares never gets its list of files
const PIECES_TIMEOUT = 600;
const INSPECT_MAX_AGE = 30 * 60;        // A scheda tecnica never turned into a download is thrown away
const HEAD_BYTES = 12 * 1024 * 1024;    // Start of the video read by ffprobe: header and tracks
const MAX_HEAD_BYTES = 96 * 1024 * 1024;
const MISSING_GRACE = 60;               // Seconds a torrent just added can take to appear in qbittorrent
const NAS_RETRY_INTERVAL = 120;
const MAX_AUTO_UPLOADS = 5;
const NO_ETA = 8640000;                 // Eta of qbittorrent when it cant tell
const LIVE_PHASES = ['inspect', 'download', 'upload', 'done', 'discard'];

class TorrentError extends AppError {}

/** The scheda tecnica is not wanted anymore: discarded or turned into a download */
class InspectStopped extends Error {}

function now() {
  return Date.now() / 1000;
}


/**
 * Torrents sent to qbittorrent from the app: the scheda tecnica before the download,
 * the progress while qbittorrent downloads, and the upload to the nas at the end.
 */
class TorrentManager {
  constructor() {
    this.results = new Map();
    this.items = [];
    this.nextId = 1;
    this.live = new Map();              // Last state of each torrent in qbittorrent, by item id
    this.uploadState = new Map();       // Upload running, by item id
    this.uploads = new AsyncQueue();
    this.client = null;
    this.clientError = null;
    this.stopping = false;
    this.wake = new Wake();
    this.load();

    this.poller();
    this.uploader();
  }

  // [ saved list ]
  load() {
    const saved = storage.readJson(ITEMS_FILE, {});
    const items = storage.isObject(saved) && Array.isArray(saved.items) ? saved.items : [];

    for (const item of items) {
      if (!storage.isObject(item) || !Number.isInteger(item.id) || ![...LIVE_PHASES, 'error'].includes(item.phase)) continue;

      // The scheda tecnica of the last time has nobody waiting for it
      if (item.phase === 'inspect') item.phase = 'discard';
      if (item.phase === 'upload') this.uploads.put(item.id);

      this.items.push(item);
    }

    this.nextId = Math.max(0, ...this.items.map((item) => item.id)) + 1;
  }

  save() {
    try {
      storage.writeJson(ITEMS_FILE, { items: this.items.slice(-MAX_ITEMS) }, 2);
    } catch (error) {
      logError('Torrents list not saved', error);
    }
  }

  get(itemId) {
    return this.items.find((item) => item.id === itemId) || null;
  }

  // [ qbittorrent ]
  getClient() {
    if (!this.client) this.client = new qbittorrent.Client(torrentConfig.loadConfig());
    return this.client;
  }

  resetClient() {
    this.client = null;
    this.clientError = null;
    this.wake.set();
  }

  async findTorrent(client, item) {
    const found = item.hash ? await client.torrents({ hashes: item.hash }) : await client.torrents({ tag: item.tag });
    const torrent = found[0] || null;

    if (torrent && !item.hash) {
      item.hash = torrent.hash;
      this.save();
    }

    return torrent;
  }

  /** Give a result of the search to qbittorrent */
  async send(client, raw, tag, paused = false, sequential = false) {
    const config = torrentConfig.loadConfig();
    const options = { tag, savePath: config.save_path, paused, sequential };

    if (raw.magnet) return client.add({ magnet: raw.magnet, ...options });

    const [kind, payload] = await this.fetch(raw);
    if (kind === 'magnet') return client.add({ magnet: payload, ...options });
    return client.add({ torrent: payload, ...options });
  }

  /** Without the web ui the torrent is opened by qbittorrent like a double click */
  async openWithSystem(raw) {
    if (process.platform !== 'win32') {
      throw new TorrentError('Senza la Web UI di qBittorrent il torrent si apre solo sul PC Windows: attivala nelle impostazioni, scheda Torrent');
    }

    if (raw.magnet) {
      await platform.openExternal(raw.magnet);
      return;
    }

    const [kind, payload] = await this.fetch(raw);
    if (kind === 'magnet') {
      await platform.openExternal(payload);
      return;
    }

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc_torrent_')), 'download.torrent');
    fs.writeFileSync(file, payload);
    await platform.openPath(file);
  }

  /** The torrent of a result that is not a magnet, from the source that found it */
  fetch(raw) {
    const config = torrentConfig.loadConfig();
    if (raw.source === 'plugin') return plugins.fetch(config, raw.engine, raw.link);
    return jackett.fetch(config, raw.link);
  }

  /** Where a file of the torrent is on this pc, while downloading it can have the .!qB extension */
  filePath(torrent, file) {
    const config = torrentConfig.loadConfig();

    for (const base of [torrent.download_path, torrent.save_path]) {
      if (!base) continue;

      const local = torrentConfig.toLocalPath(config, `${base.replace(/[/\\]+$/, '')}/${file.name}`);
      for (const candidate of [local, `${local}.!qB`]) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  // [ search ]
  /** Jackett and the search plugins of qbittorrent together: a source that fails does not stop the other */
  async search(query, category) {
    const config = torrentConfig.loadConfig();
    const sources = [];

    if (config.jackett_url && torrentConfig.getJackettKey(config)) sources.push(['jackett', jackett.search]);
    if (config.plugins !== 'off') sources.push(['plugins', plugins.search]);

    if (!sources.length) {
      throw new TorrentError('Nessuna fonte per cercare: imposta Jackett o attiva i plugin di qBittorrent nelle impostazioni, scheda Torrent');
    }

    const found = {};
    const errors = {};

    await Promise.all(sources.map(async ([name, action]) => {
      try {
        found[name] = await action(config, query, category);
      } catch (error) {
        if (!(error instanceof AppError)) logError(`Torrent search on ${name}`, error);
        errors[name] = error instanceof AppError ? error.message : describe(error);
      }
    }));

    if (!Object.keys(found).length) throw new TorrentError(Object.values(errors)[0]);

    const fromJackett = found.jackett;
    const fromPlugins = found.plugins;
    const failed = fromJackett ? [...fromJackett.failed] : [];
    if (errors.jackett) failed.push(`Jackett (${errors.jackett})`);
    if (errors.plugins) failed.push(`plugin di qBittorrent (${errors.plugins})`);
    else if (fromPlugins?.failed) failed.push('alcuni plugin di qBittorrent (sito bloccato o cambiato)');

    // The same torrent found by two sources: the one with more seeds, a magnet if possible
    const unique = [];
    for (const raw of [...(fromJackett?.results || []), ...(fromPlugins?.results || [])]) {
      const index = unique.findIndex((other) => isSame(raw, other));

      if (index < 0) {
        unique.push(raw);
      } else {
        const other = unique[index];
        if (raw.seeders > other.seeders || (raw.seeders === other.seeders && Boolean(raw.magnet) && !other.magnet)) unique[index] = raw;
      }
    }

    const results = unique.map((raw) => {
      const resultId = crypto.createHash('sha1').update(raw.magnet || raw.link).digest('hex').slice(0, 16);
      this.results.delete(resultId);
      this.results.set(resultId, raw);
      const guess = release.parse(raw.title, raw.categories);

      // Links of jackett have its key inside, the page gets only the id
      return {
        id: resultId,
        title: raw.title,
        tracker: raw.tracker,
        source: raw.source || null,
        size: raw.size,
        seeders: raw.seeders,
        peers: raw.peers,
        date: raw.date,
        category: raw.category,
        details: raw.details.startsWith('http') && !raw.details.toLowerCase().includes('apikey') ? raw.details : null,
        guess,
        check: checks.checkResult(raw.title, raw.size, guess),
      };
    });

    while (this.results.size > MAX_RESULTS) this.results.delete(this.results.keys().next().value);

    return {
      results,
      indexers: fromJackett ? fromJackett.indexers : 0,
      plugins: fromPlugins ? fromPlugins.engines : 0,
      failed,
    };
  }

  getResult(resultId) {
    const raw = this.results.get(resultId);
    if (!raw) throw new TorrentError('Risultato scaduto: cerca di nuovo');
    return raw;
  }

  // [ items ]
  newItem(raw, media, phase, resultId) {
    const item = {
      id: this.nextId++,
      result: resultId,
      tag: `scd-${crypto.randomBytes(5).toString('hex')}`,
      hash: null,
      title: raw.title,
      tracker: raw.tracker,
      size: raw.size,
      media,
      phase,
      created: now(),
      touched: now(),
      files: null,              // Indexes of the files chosen, null for all
      selection: false,         // Priorities still to give once the list of files is known
      inspect: null,
      uploads: [],
      warning: null,
      error: null,
      auto_uploads: 0,
      note: null,
    };
    this.items.push(item);

    // The oldest finished torrents leave the list
    const finished = this.items.filter((other) => ['done', 'error'].includes(other.phase));
    for (const other of finished.slice(0, Math.max(0, this.items.length - MAX_ITEMS))) this.items.splice(this.items.indexOf(other), 1);

    this.save();
    return item;
  }

  removeItem(item) {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
  }

  /** Scheda tecnica: qbittorrent downloads only the start of the video, ffprobe reads its tracks */
  async inspect(resultId, value) {
    if (!probe.isAvailable()) throw new TorrentError('ffprobe non trovato: reinstalla il programma per la scheda tecnica');
    if (!torrentConfig.loadConfig().qbit_url) {
      throw new TorrentError('La scheda tecnica ha bisogno della Web UI di qBittorrent: attivala nelle impostazioni, scheda Torrent');
    }

    const media = readMedia(value);
    const raw = this.getResult(resultId);
    const client = this.getClient();
    const item = this.newItem(raw, media, 'inspect', resultId);
    item.inspect = { status: 'adding', have: 0, need: 0, info: null, message: null };

    try {
      await this.send(client, raw, item.tag, false, true);
    } catch (error) {
      this.removeItem(item);
      this.save();
      throw error;
    }

    this.runInspect(item.id);
    this.wake.set();
    return this.view(item);
  }

  /** A result goes to qbittorrent, or a scheda tecnica becomes a download */
  async download(body) {
    const media = readMedia(body.media);
    const files = Array.isArray(body.files) ? body.files.filter(Number.isInteger) : null;
    const resultId = String(body.result || '');
    let itemId = body.item;

    // The same torrent already in qbittorrent: qbittorrent would refuse it a second time
    const same = this.items.find((item) => resultId && item.result === resultId && ['inspect', 'download', 'upload'].includes(item.phase));

    if (same && same.phase !== 'inspect') throw new TorrentError('Questo torrent è già nella lista dei tuoi torrent');
    if (same) itemId = same.id;

    if (itemId !== undefined && itemId !== null) {
      const item = this.get(parseInt(itemId, 10));
      if (!item || item.phase !== 'inspect') throw new TorrentError("Questa scheda tecnica non c'è più: cerca di nuovo il torrent");

      // The scheda tecnica has done its job, the saved list does not need it
      Object.assign(item, { phase: 'download', media, files, selection: true, touched: now(), inspect: null });

      this.save();
      this.wake.set();
      return { item: this.view(item), message: 'Inviato a qBittorrent' };
    }

    const raw = this.getResult(resultId);

    if (!torrentConfig.loadConfig().qbit_url) {
      await this.openWithSystem(raw);
      return { item: null, message: 'Aperto con qBittorrent' };
    }

    const client = this.getClient();
    const item = this.newItem(raw, media, 'download', resultId);
    item.selection = true;

    try {
      await this.send(client, raw, item.tag);
    } catch (error) {
      this.removeItem(item);
      this.save();
      throw error;
    }

    this.wake.set();
    return { item: this.view(item), message: 'Inviato a qBittorrent' };
  }

  /** Torrent and files removed from qbittorrent, done by the poller */
  discard(itemId) {
    const item = this.get(itemId);
    if (!item || ['upload', 'discard'].includes(item.phase)) return false;

    // Already finished: only the line of the list goes away, the files stay where they are
    if (['done', 'error'].includes(item.phase)) this.removeItem(item);
    else item.phase = 'discard';

    this.save();
    this.wake.set();
    return true;
  }

  touch(itemId) {
    const item = this.get(itemId);
    if (item) item.touched = now();
    return item;
  }

  async setPaused(itemId, paused) {
    const item = this.get(itemId);
    if (!item || item.phase !== 'download' || !item.hash) throw new TorrentError('Questo torrent non si può mettere in pausa ora');

    const client = this.getClient();
    if (paused) await client.pause(item.hash);
    else await client.resume(item.hash);
    this.wake.set();
  }

  retryUpload(itemId) {
    const item = this.get(itemId);
    if (!item || item.phase !== 'done' || !item.warning) throw new TorrentError('Questo torrent non ha nulla da caricare');

    Object.assign(item, { phase: 'upload', warning: null });
    this.uploads.put(itemId);
    this.save();
  }

  getFolder(itemId) {
    const torrent = this.live.get(itemId);
    if (!torrent) return null;

    return torrentConfig.toLocalPath(torrentConfig.loadConfig(), torrent.content_path || torrent.save_path);
  }

  isBusy() {
    return this.items.some((item) => item.phase === 'upload');
  }

  /** The program is closing: an upload stops and goes on at the next start */
  async stop(timeout = 15) {
    this.stopping = true;
    const end = Date.now() + timeout * 1000;

    while (Date.now() < end && this.uploadState.size) await sleep(200);

    this.save();
  }

  // [ scheda tecnica ]
  setInspect(item, values) {
    if (item.inspect) Object.assign(item.inspect, values);
  }

  checkInspect(item) {
    if (item.phase !== 'inspect' || this.stopping) throw new InspectStopped();
  }

  async runInspect(itemId) {
    const item = this.get(itemId);

    try {
      const info = await this.inspectSteps(item);
      this.setInspect(item, { status: 'ready', info, message: null });

    } catch (error) {
      if (error instanceof InspectStopped) return;
      if (!(error instanceof AppError)) logError(`Scheda tecnica of ${item.title}`, error);
      this.setInspect(item, { status: 'error', message: describe(error) });
    }

    // The rest is downloaded only if the user wants it
    try {
      if (item.phase === 'inspect' && item.hash) await this.getClient().pause(item.hash);
    } catch {
      // The torrent is discarded later anyway
    }
  }

  async inspectSteps(item) {
    const client = this.getClient();
    let start = Date.now();
    let torrent;

    // [ list of the files ]
    this.setInspect(item, { status: 'metadata' });
    for (;;) {
      this.checkInspect(item);
      torrent = await this.findTorrent(client, item);

      if (torrent && qbittorrent.hasMetadata(torrent)) break;
      if (Date.now() - start > METADATA_TIMEOUT * 1000) {
        throw new TorrentError("Nessuno condivide questo torrent: in 3 minuti non è arrivato nemmeno l'elenco dei file. Prova un risultato con più seed");
      }
      await sleep(1000);
    }

    const files = (await client.files(torrent.hash)).map((file, position) => ({ ...file, index: file.index ?? position }));
    const guess = release.parse(item.title);
    const fileCheck = checks.checkFiles(files, guess);
    const info = { files: describeFiles(files), check: fileCheck, probe: null, main: null };

    // Junk: nothing to read, and nothing more is downloaded
    const videos = checks.getVideos(files);
    if (!videos.length) return info;

    const main = videos.reduce((best, file) => (file.size > best.size ? file : best));
    info.main = main.index;

    // Only the start and the end of the main video
    await client.setFilePriority(torrent.hash, files.filter((file) => file !== main).map((file) => file.index), 0);
    await client.setSequential(torrent, true);

    const pieceSize = (await client.properties(torrent.hash)).piece_size || 0;
    const [first, last] = main.piece_range || [0, 0];
    if (!pieceSize) throw new TorrentError('qBittorrent non dice la dimensione dei pezzi del torrent');

    let head = HEAD_BYTES;
    start = Date.now();

    for (;;) {
      const needed = new Set([last]);
      for (let piece = first; piece <= Math.min(last, first + Math.ceil(head / pieceSize)); piece++) needed.add(piece);
      this.setInspect(item, { status: 'pieces', have: 0, need: needed.size });

      for (;;) {
        this.checkInspect(item);
        const states = await client.pieceStates(torrent.hash);
        const have = [...needed].filter((piece) => piece < states.length && states[piece] === 2).length;
        this.setInspect(item, { have });

        if (have === needed.size) break;
        if (Date.now() - start > PIECES_TIMEOUT * 1000) {
          throw new TorrentError('Il torrent scarica troppo lentamente: in 10 minuti non sono arrivati i primi MB del video');
        }
        await sleep(1000);
      }

      this.setInspect(item, { status: 'probe' });
      torrent = (await this.findTorrent(client, item)) || torrent;
      const file = this.filePath(torrent, main);

      if (!file) {
        throw new TorrentError('Il video scaricato non si trova sul PC: se usi Docker imposta le cartelle nelle impostazioni, scheda Torrent');
      }

      try {
        info.probe = probe.describe(await probe.run(file));
        info.check = checks.merge(fileCheck, checks.checkProbe(info.probe, guess, main.size));
        return info;

      } catch (error) {
        if (!(error instanceof probe.ProbeError)) throw error;

        // Some files keep their tracks further on: a few more MB, up to a limit
        if (head >= MAX_HEAD_BYTES || last - first <= Math.ceil(head / pieceSize)) {
          throw new TorrentError(`Il formato del video non si legge dai primi MB (${error.message})`);
        }
        head *= 2;
      }
    }
  }

  // [ poller ]
  async poller() {
    let lastNasCheck = Date.now();

    for (;;) {
      let busy = false;

      try {
        busy = await this.poll();

        if (Date.now() - lastNasCheck > NAS_RETRY_INTERVAL * 1000) {
          lastNasCheck = Date.now();
          await this.retryPendingUploads();
        }
      } catch (error) {
        logError('Poller of the torrents', error);
      }

      await this.wake.wait((busy ? POLL_ACTIVE : POLL_IDLE) * 1000);
    }
  }

  /** Progress of the torrents, the ones complete go to the nas */
  async poll() {
    const tracked = this.items.filter((item) => ['inspect', 'download', 'discard', 'done', 'upload'].includes(item.phase));

    if (!tracked.length || !torrentConfig.loadConfig().qbit_url) return false;

    let client;
    let torrents;

    try {
      client = this.getClient();
      torrents = await client.torrents();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (this.clientError !== error.message) console.log(`qBittorrent: ${error.message}`);
      this.clientError = error.message;
      return true;
    }

    this.clientError = null;
    const byHash = new Map(torrents.map((torrent) => [torrent.hash, torrent]));
    const byTag = new Map();
    for (const torrent of torrents) {
      for (const tag of (torrent.tags || '').split(',')) if (tag.trim()) byTag.set(tag.trim(), torrent);
    }

    let changed = false;
    const time = now();

    for (const item of tracked) {
      const torrent = byHash.get(item.hash) || byTag.get(item.tag) || null;

      if (torrent && item.hash !== torrent.hash) {
        item.hash = torrent.hash;
        changed = true;
      }

      this.live.set(item.id, torrent);

      try {
        changed = (await this.updateItem(client, item, torrent, time)) || changed;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        console.log(`Torrent ${item.title}: ${error.message}`);
      }
    }

    if (changed) this.save();

    return tracked.some((item) => ['inspect', 'download', 'upload', 'discard'].includes(item.phase));
  }

  /** Return true when the item has changed */
  async updateItem(client, item, torrent, time) {
    const phase = item.phase;

    if (phase === 'discard') {
      if (torrent) {
        await client.delete(torrent.hash, true);

      // Just added, qbittorrent could still be making it
      } else if (time - item.created < MISSING_GRACE) {
        return false;
      }

      this.removeItem(item);
      this.live.delete(item.id);
      return true;
    }

    if (phase === 'inspect') {
      if (time - item.touched > INSPECT_MAX_AGE) {
        item.phase = 'discard';
        return true;
      }
      return false;
    }

    if (phase !== 'download') return false;

    if (!torrent) {
      if (time - item.created > MISSING_GRACE) {
        Object.assign(item, { phase: 'error', error: "Il torrent non c'è più in qBittorrent: è stato rimosso da lì" });
        return true;
      }
      return false;
    }

    if (item.selection && qbittorrent.hasMetadata(torrent)) {
      await this.applySelection(client, item, torrent);
      return true;
    }

    if (qbittorrent.isComplete(torrent) && !item.selection) {
      if (nas.isEnabled()) {
        item.phase = 'upload';
        this.uploads.put(item.id);
      } else {
        item.phase = 'done';
      }

      console.print(`Torrent completato => ${item.title}`);
      return true;
    }

    return false;
  }

  /**
   * Files chosen in the scheda tecnica (or the videos when nobody chose), then a normal download from where it was.
   * A torrent with nothing to watch is thrown away, a program inside is never downloaded.
   */
  async applySelection(client, item, torrent) {
    const files = (await client.files(torrent.hash)).map((file, position) => ({ ...file, index: file.index ?? position }));
    const junk = checks.getJunk(files);

    if (junk) {
      await client.delete(torrent.hash, true);
      Object.assign(item, { phase: 'error', selection: false, error: `Torrent falso, l'ho cancellato: ${junk}` });
      console.print(`Torrent falso cancellato => ${item.title}`);
      return;
    }

    const chosen = new Set(item.files !== null && item.files !== undefined ? item.files : checks.defaultFiles(files));
    const programs = files.filter(checks.isProgram);
    for (const file of programs) chosen.delete(file.index);

    if (programs.length) item.note = `Ho escluso un programma nascosto nel torrent (${programs[0].name.split('/').pop()})`;

    await client.setFilePriority(torrent.hash, files.filter((file) => chosen.has(file.index)).map((file) => file.index), 1);
    await client.setFilePriority(torrent.hash, files.filter((file) => !chosen.has(file.index)).map((file) => file.index), 0);
    await client.setSequential(torrent, false);
    await client.resume(torrent.hash);

    item.selection = false;
  }

  // [ nas ]
  /** One upload at a time, nothing can stop the queue */
  async uploader() {
    for (;;) {
      const itemId = await this.uploads.get();

      try {
        await this.upload(itemId);

      } catch (error) {
        if (!(error instanceof DownloadCancelled)) {
          logError(`Upload of a torrent to the nas (${itemId})`, error);
          const item = this.get(itemId);
          if (item) {
            Object.assign(item, { phase: 'done', warning: describe(error) });
            this.save();
          }
        }

      } finally {
        this.uploadState.delete(itemId);
      }
    }
  }

  finish(item, warning) {
    Object.assign(item, { phase: 'done', warning });
    this.save();
  }

  async upload(itemId) {
    const item = this.get(itemId);
    if (!item || item.phase !== 'upload') return;

    const config = nas.loadConfig();
    if (!nas.isEnabled(config)) {
      this.finish(item, item.warning || null);
      return;
    }

    const client = this.getClient();
    const torrent = await this.findTorrent(client, item);

    if (!torrent) {
      this.finish(item, "Il torrent non c'è più in qBittorrent: niente da caricare");
      return;
    }

    let files = (await client.files(torrent.hash)).filter((file) => (file.priority ?? 1) > 0
      && release.isVideo(file.name) && !release.isSample(file.name, file.size));

    // A film is its biggest video, the others are extras
    if (item.media.type === 'movie' && files.length) files = [files.reduce((best, file) => (file.size > best.size ? file : best))];

    if (!files.length) {
      this.finish(item, "Nel torrent non c'è nessun video da caricare");
      return;
    }

    const plan = [];
    for (const file of files) {
      const local = this.filePath(torrent, file);
      if (!local) {
        this.finish(item, `File non trovato sul PC: ${file.name} (se usi Docker imposta le cartelle nelle impostazioni)`);
        return;
      }
      plan.push([file, local, getRemotePath(config, item.media, file)]);
    }

    const total = plan.reduce((sum, [file]) => sum + file.size, 0);
    let sentBefore = 0;

    for (const [position, [file, local, remotePath]] of plan.entries()) {
      if (item.uploads.includes(remotePath)) {
        sentBefore += file.size;
        continue;
      }

      console.print(`Upload to nas => ${remotePath}`);
      const progress = this.makeProgress(itemId, sentBefore, total, path.posix.basename(remotePath), position + 1, plan.length);

      try {
        await nas.upload(config, local, remotePath, null, nas.makeProgress(progress));
      } catch (error) {
        if (!(error instanceof nas.NasError)) throw error;
        this.finish(item, error.message);
        return;
      }

      item.uploads.push(remotePath);
      this.save();
      sentBefore += file.size;
    }

    // Everything is on the nas: qbittorrent can forget the torrent, or keep sharing it
    if (torrentConfig.loadConfig().after_upload === 'remove') {
      try {
        await client.delete(torrent.hash, true);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        console.log(`Torrent caricato, ma non rimosso da qBittorrent: ${error.message}`);
      }
    }

    this.finish(item, null);
  }

  makeProgress(itemId, sentBefore, total, name, index, count) {
    const started = Date.now();

    return (stage, sent) => {
      if (this.stopping) throw new DownloadCancelled(true);

      const elapsed = (Date.now() - started) / 1000;
      this.uploadState.set(itemId, {
        done: sentBefore + sent,
        total,
        file: name,
        index,
        count,
        speed: elapsed > 1 ? Math.round(sent / elapsed) : null,
      });
    };
  }

  /** Files the nas refused go there when it comes back */
  async retryPendingUploads() {
    const config = nas.loadConfig();
    if (!nas.isEnabled(config)) return;

    const pending = this.items.filter((item) => item.phase === 'done' && item.warning && item.auto_uploads < MAX_AUTO_UPLOADS && item.hash);

    if (!pending.length || !(await nas.isReachable(config))) return;

    for (const item of pending) {
      item.auto_uploads += 1;
      Object.assign(item, { phase: 'upload', warning: null });
      this.uploads.put(item.id);
    }

    this.save();
  }

  // [ page ]
  view(item) {
    const torrent = this.live.get(item.id) || null;
    const upload = this.uploadState.get(item.id) || null;
    const state = torrent ? torrent.state : null;
    const eta = torrent ? torrent.eta ?? NO_ETA : NO_ETA;

    return {
      id: item.id,
      title: item.title,
      tracker: item.tracker,
      size: (torrent ? torrent.size : null) || item.size,
      media: item.media,
      phase: item.phase,
      created: item.created,
      inspect: item.phase === 'inspect' ? item.inspect : null,
      warning: item.warning,
      error: item.error,
      note: item.note || null,
      uploaded: item.uploads.length,
      remote: item.uploads[0] || null,
      progress: torrent ? torrent.progress ?? null : null,
      speed: torrent ? torrent.dlspeed ?? null : null,
      eta: torrent && eta >= 0 && eta < NO_ETA ? eta : null,
      seeds: torrent ? torrent.num_seeds ?? null : null,
      peers: torrent ? torrent.num_leechs ?? null : null,
      state,
      paused: qbittorrent.PAUSED_STATES.has(state),
      stalled: state === 'stalledDL',
      problem: qbittorrent.ERROR_STATES.has(state) ? 'Errore in qBittorrent: file mancanti o disco non raggiungibile' : null,
      in_client: torrent !== null,
      upload,
    };
  }

  list() {
    return this.items.filter((item) => !['inspect', 'discard'].includes(item.phase)).reverse().map((item) => this.view(item));
  }

  async status() {
    const config = torrentConfig.loadConfig();

    return {
      mode: config.qbit_url ? 'webui' : 'app',
      jackett_url: config.jackett_url,
      jackett_key: Boolean(torrentConfig.getJackettKey(config)),
      plugins: await countPlugins(config),
      client_error: this.clientError,
      nas: nas.isEnabled(),
      probe: probe.isAvailable(),
      system_open: process.platform === 'win32',
    };
  }
}


// [ helpers ]
async function countPlugins(config) {
  if (config.plugins === 'off') return 0;

  try {
    return Object.keys((await plugins.getEngines(config))[1]).length;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return 0;
  }
}

function plainName(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getHash(raw) {
  const match = /btih:([0-9a-zA-Z]+)/.exec(raw.magnet || '');
  return match ? match[1].toLowerCase() : null;
}

/**
 * The same torrent found twice. Sites without magnet (LimeTorrents) give no hash and round the weight:
 * the same name with almost the same weight is the same release.
 */
function isSame(raw, other) {
  if (getHash(raw) && getHash(raw) === getHash(other)) return true;

  const sizes = [raw.size || 0, other.size || 0];
  return plainName(raw.title) === plainName(other.title) && Math.min(...sizes) > 0 && Math.min(...sizes) / Math.max(...sizes) > 0.98;
}

/** Name, year and kind the file takes on the nas */
function readMedia(value) {
  const media = storage.isObject(value) ? value : {};
  const name = String(media.name || '').trim().slice(0, 200);
  if (!name) throw new TorrentError('Scrivi il titolo con cui salvarlo');

  const kind = ['movie', 'tv', 'anime'].includes(media.type) ? media.type : 'movie';
  const year = String(media.year || '').trim();
  const season = String(media.season ?? '');

  return {
    name,
    year: /^(19|20)\d\d$/.test(year) ? year : null,
    type: kind,
    season: /^\d+$/.test(season) && Number(season) > 0 ? Number(season) : (kind !== 'movie' ? 1 : null),
  };
}

function describeFiles(files) {
  return [...files].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)).map((file) => ({
    index: file.index,
    name: file.name,
    size: file.size,
    video: release.isVideo(file.name),
    sample: release.isSample(file.name, file.size),
    dangerous: checks.isProgram(file),
  }));
}

/** Path on the nas of a file of the torrent, a pack of episodes keeps each episode apart */
function getRemotePath(config, media, file) {
  const info = release.parseFile(file.name);
  const extension = release.extension(file.name);

  if (media.type === 'movie') return nas.getRemotePath(config, { name: media.name, year: media.year, type: 'movie' }, extension);

  const target = media.type === 'anime'
    ? { name: media.name, year: media.year, type: 'anime', single: false, episode_number: info.episode }
    : { name: media.name, year: media.year, type: 'tv', season: info.season || media.season || 1, episode_number: info.episode, episode_name: null };

  if (info.episode !== null) return nas.getRemotePath(config, target, extension);

  // No episode in the name: the file keeps its name in the folder of the season
  const folder = path.posix.dirname(nas.getRemotePath(config, { ...target, episode_number: 0 }, extension));
  const base = path.basename(file.name.replaceAll('\\', '/'), path.extname(file.name));
  return path.posix.join(folder, (nas.cleanName(base) || 'Senza nome') + extension);
}

module.exports = { TorrentManager, TorrentError };

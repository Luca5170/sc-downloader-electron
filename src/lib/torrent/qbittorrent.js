// 20.10.26

const http = require('../../util/http');
const torrentConfig = require('./config');
const { AppError } = require('../../util/errors');

const TIMEOUT = 20;
const CATEGORY = 'SC Downloader';       // Every torrent of the program is in this category of qbittorrent

// States of qbittorrent, the names changed in version 5 (paused became stopped)
const DONE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP']);
const BUSY_STATES = new Set(['checkingDL', 'checkingUP', 'checkingResumeData', 'moving', 'metaDL', 'forcedMetaDL', 'allocating']);
const ERROR_STATES = new Set(['error', 'missingFiles']);
const PAUSED_STATES = new Set(['pausedDL', 'stoppedDL', 'pausedUP', 'stoppedUP']);

class QbitError extends AppError {}


/** Web api of qbittorrent, the login is done again when the session expires */
class Client {
  constructor(config, password = null) {
    if (!config.qbit_url) {
      throw new QbitError("Web UI di qBittorrent non impostata: attivala e inserisci l'indirizzo nelle impostazioni, scheda Torrent");
    }

    this.base = config.qbit_url.replace(/\/+$/, '');
    this.user = config.qbit_user;
    this.password = password !== null ? password : torrentConfig.getPassword(config);

    // The web ui refuses requests whose origin is another site
    this.session = new http.Session({ referer: this.base, origin: this.base });
    this.logging = null;
  }

  // [ requests ]
  async login() {
    if (!this.user) {
      throw new QbitError('qBittorrent chiede l\'accesso: inserisci utente e password della Web UI, oppure attiva "Salta l\'autenticazione per i client su localhost"');
    }

    const response = await this.send('POST', '/api/v2/auth/login', { data: { username: this.user, password: this.password || '' } }, false);

    if (response.status === 403) throw new QbitError("qBittorrent ha bloccato l'accesso per troppi tentativi sbagliati: aspetta qualche minuto");
    if (response.text.trim() !== 'Ok.') throw new QbitError('Accesso a qBittorrent rifiutato: controlla utente e password della Web UI');
  }

  async send(method, path, options = {}, login = true) {
    let response;

    try {
      response = await http.send(method, this.base + path, { ...options, session: this.session, timeout: TIMEOUT });
    } catch (error) {
      if (error.code === 'ETIMEDOUT') throw new QbitError('qBittorrent non ha risposto in tempo');
      if (error.name === 'RequestError') throw new QbitError(`qBittorrent non risponde su ${this.base}: è aperto, con la Web UI attiva?`);
      throw new QbitError(`qBittorrent non ha risposto come previsto (${error.message})`);
    }

    // Without the session cookie the web ui answers forbidden, unless localhost can skip the login
    if (login && [401, 403].includes(response.status)) {
      if (!this.logging) this.logging = this.login().finally(() => { this.logging = null; });
      await this.logging;
      return this.send(method, path, options, false);
    }

    return response;
  }

  async call(method, path, options = {}) {
    const response = await this.send(method, path, options);

    if (response.status === 404) throw new QbitError('Torrent non trovato in qBittorrent');
    if (response.status === 415) throw new QbitError('qBittorrent non ha accettato il torrent: il file non è valido');
    if (!response.ok) throw new QbitError(`qBittorrent ha risposto con errore ${response.status}`);

    return response;
  }

  async get(path, params = {}) {
    return (await this.call('GET', path, { params })).json();
  }

  post(path, data = {}) {
    return this.call('POST', path, { data });
  }

  /** Calls renamed in qbittorrent 5 (pause became stop): the new name first */
  async postAny(paths, data = {}) {
    for (const path of paths.slice(0, -1)) {
      const response = await this.send('POST', path, { data });
      if (response.status !== 404) {
        if (!response.ok) throw new QbitError(`qBittorrent ha risposto con errore ${response.status}`);
        return response;
      }
    }

    return this.post(paths[paths.length - 1], data);
  }

  // [ app ]
  async version() {
    return (await this.call('GET', '/api/v2/app/version')).text.trim();
  }

  preferences() {
    return this.get('/api/v2/app/preferences');
  }

  async ensureCategory() {
    const response = await this.send('POST', '/api/v2/torrents/createCategory', { data: { category: CATEGORY, savePath: '' } });

    // 409: the category is already there
    if (!response.ok && response.status !== 409) {
      throw new QbitError(`Categoria "${CATEGORY}" non creata in qBittorrent (errore ${response.status})`);
    }
  }

  // [ torrents ]
  async add({ magnet = null, torrent = null, tag = null, savePath = '', paused = false, sequential = false } = {}) {
    await this.ensureCategory();

    const data = {
      category: CATEGORY,
      tags: tag || '',
      paused: paused ? 'true' : 'false',
      stopped: paused ? 'true' : 'false',
      sequentialDownload: sequential ? 'true' : 'false',
      firstLastPiecePrio: sequential ? 'true' : 'false',
    };
    if (savePath) data.savepath = savePath;

    let response;
    if (magnet) {
      response = await this.call('POST', '/api/v2/torrents/add', { data: { ...data, urls: magnet } });
    } else {
      const form = new FormData();
      for (const [key, value] of Object.entries(data)) form.append(key, value);
      form.append('torrents', new Blob([torrent], { type: 'application/x-bittorrent' }), 'download.torrent');
      response = await this.call('POST', '/api/v2/torrents/add', { form });
    }

    if (response.text.trim().startsWith('Fails')) {
      throw new QbitError("qBittorrent non ha accettato il torrent (forse c'è già, fuori da questa app)");
    }
  }

  torrents(filters = {}) {
    return this.get('/api/v2/torrents/info', { category: CATEGORY, ...filters });
  }

  files(hash) {
    return this.get('/api/v2/torrents/files', { hash });
  }

  properties(hash) {
    return this.get('/api/v2/torrents/properties', { hash });
  }

  pieceStates(hash) {
    return this.get('/api/v2/torrents/pieceStates', { hash });
  }

  async setFilePriority(hash, indexes, priority) {
    if (indexes.length) await this.post('/api/v2/torrents/filePrio', { hash, id: indexes.join('|'), priority });
  }

  /** The web api only toggles: the state of the torrent says if it is needed */
  async setSequential(torrent, enabled) {
    if (Boolean(torrent.seq_dl) !== enabled) await this.post('/api/v2/torrents/toggleSequentialDownload', { hashes: torrent.hash });
    if (Boolean(torrent.f_l_piece_prio) !== enabled) await this.post('/api/v2/torrents/toggleFirstLastPiecePrio', { hashes: torrent.hash });
  }

  pause(hash) {
    return this.postAny(['/api/v2/torrents/stop', '/api/v2/torrents/pause'], { hashes: hash });
  }

  resume(hash) {
    return this.postAny(['/api/v2/torrents/start', '/api/v2/torrents/resume'], { hashes: hash });
  }

  delete(hash, deleteFiles = true) {
    return this.post('/api/v2/torrents/delete', { hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' });
  }
}


// [ state of a torrent ]
function isComplete(torrent) {
  return (torrent.progress || 0) >= 1 && DONE_STATES.has(torrent.state);
}

function hasMetadata(torrent) {
  // A magnet without metadata has no size yet
  return !['metaDL', 'forcedMetaDL'].includes(torrent.state) && (torrent.total_size || torrent.size || 0) > 0;
}

module.exports = { Client, QbitError, CATEGORY, DONE_STATES, BUSY_STATES, ERROR_STATES, PAUSED_STATES, isComplete, hasMetadata };

// 15.09.26

const fs = require('fs');
const http = require('http');
const path = require('path');
const Page = require('../api/page');
const anime = require('../api/anime');
const film = require('../api/film');
const tv = require('../api/tv');
const vixcloud = require('../api/vixcloud');
const ffmpeg = require('../lib/ffmpeg');
const nas = require('../lib/nas');
const torrentConfig = require('../lib/torrent/config');
const jackett = require('../lib/torrent/jackett');
const plugins = require('../lib/torrent/plugins');
const qbittorrent = require('../lib/torrent/qbittorrent');
const history = require('../util/history');
const storage = require('../util/storage');
const watchProgress = require('../util/progress');
const videos = require('../util/videos');
const paths = require('../paths');
const platform = require('../platform');
const remote = require('./remote');
const { AnimeSource } = require('./anime_source');
const { AnimeRecommender } = require('./anime_recommend');
const { DownloadManager, ApiError, parseInt: parseInt_, parseSlug } = require('./downloads');
const { Recommender } = require('./recommend');
const { Streams, SegmentError } = require('./player');
const { TorrentManager } = require('./torrents');
const { console } = require('../util/console');
const { AppError, HttpError, describe, describeAsync, lowerFirst } = require('../util/errors');
const { logError } = require('../util/log');

const WEB_FOLDER = path.join(__dirname, '..', '..', 'web');
const DATA_FILE = 'data.json';
const DEFAULT_PORT = 8765;
const ADDRESS_ENV = 'SC_ADDRESS';       // Address shown in the qr code, used when the pc is not the machine of the app
const REMOTE_HOST = '0.0.0.0';          // Every network card of the pc, the private addresses protect it
const SEGMENTS_MAX_AGE = 7 * 24 * 3600 * 1000;  // Segments of a download not resumed for a week are removed
const MAX_BODY = 4 * 1024 * 1024;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};


// [ site ]
/** Domain and inertia version of the site, shared by every request */
class Site {
  constructor() {
    // The old versions saved only the extension: it becomes the whole address
    this.domain = Page.getHost(this.readData().domain || '');
    this.version = null;
  }

  readData() {
    const data = storage.readJson(DATA_FILE, {});
    return storage.isObject(data) ? data : {};
  }

  /** Get version of the site and save the domain if it works */
  async connect(value = null) {
    const domain = Page.getHost(value === null ? this.domain : value);

    if (!domain) throw new ApiError("Inserisci l'indirizzo del sito");

    let version;
    try {
      version = await Page.getVersion(domain);
    } catch (error) {
      // The reason is shown in the settings: missing domain, blocked by the provider, site moved...
      console.log(`Site ${domain} not reachable: ${error.message}`);
      throw new ApiError(await describeAsync(error), 502);
    }

    this.domain = domain;
    this.version = version;

    // The site works also if the domain cant be saved, it is asked again at the next start
    try {
      storage.writeJson(DATA_FILE, { ...this.readData(), domain });
    } catch (error) {
      console.log(`Domain not saved: ${error.message}`);
    }
  }

  async status() {
    let error = null;

    if (this.domain && this.version === null) {
      try {
        await this.connect();
      } catch (failure) {
        if (!(failure instanceof ApiError)) throw failure;
        error = failure.message;
      }
    }

    return {
      domain: this.domain,
      site_name: Page.SITE_NAME,
      site: this.domain || null,
      connected: this.version !== null,
      ffmpeg: ffmpeg.isAvailable(),
      nas: nas.isEnabled(),
      error,
    };
  }

  /** Call fetch(domain, version), getting the new version if the site has been updated */
  async request(fetch) {
    if (this.version === null) await this.connect();

    try {
      return await fetch(this.domain, this.version);
    } catch (error) {
      // Inertia answer 409 when the version of the site is changed
      if (!(error instanceof HttpError) || error.response.status !== 409) throw error;

      await this.connect();
      return fetch(this.domain, this.version);
    }
  }
}


// [ format ]
function getImage(cdnUrl, images, ...types) {
  for (const type of types) {
    for (const image of images || []) {
      if (image.type === type && image.filename) return `${cdnUrl}/images/${image.filename}`;
    }
  }

  return null;
}

function formatTitle(title, cdnUrl) {
  const images = title.images;
  const date = title.release_date || title.last_air_date || '';

  return {
    id: title.id,
    slug: title.slug,
    name: title.name,
    source: 'sc',
    type: title.type,
    score: title.score ?? null,
    year: date.slice(0, 4) || null,
    age: title.age ?? null,
    seasons_count: title.seasons_count ?? null,
    sub_ita: Boolean(title.sub_ita),
    poster: getImage(cdnUrl, images, 'poster', 'cover_mobile'),
    backdrop: getImage(cdnUrl, images, 'background', 'cover'),
    logo: getImage(cdnUrl, images, 'logo'),
  };
}

function formatDetail(props) {
  const title = props.title;

  return {
    ...formatTitle(title, props.cdn_url),
    plot: title.plot ?? null,
    original_name: title.original_name ?? null,
    runtime: title.runtime ?? null,
    quality: title.quality ?? null,
    genres: (title.genres || []).map((genre) => genre.name),
    actors: (title.main_actors || []).map((actor) => actor.name).slice(0, 6),
    directors: (title.main_directors || []).map((director) => director.name).slice(0, 3),
    seasons: (title.seasons || []).map((season) => season.number),
  };
}

function formatEpisode(episode, cdnUrl) {
  return {
    id: episode.id,
    number: episode.number,
    name: episode.name || `Episodio ${episode.number}`,
    plot: episode.plot ?? null,
    duration: episode.duration ?? null,
    cover: getImage(cdnUrl, episode.images, 'cover'),
  };
}

function text(value) {
  return String(value ?? '').trim();
}

/** Nas settings sent by the gui, the password is kept apart */
function readNas(body) {
  return {
    enabled: Boolean(body.enabled),
    host: text(body.host),
    port: parseInt_(body.port || 22, 'port'),
    user: text(body.user),
    film_path: text(body.film_path).replace(/\/+$/, ''),
    tv_path: text(body.tv_path).replace(/\/+$/, ''),
    anime_path: text(body.anime_path).replace(/\/+$/, ''),
  };
}

/** Torrent settings sent by the gui, the key of jackett and the password are never sent back */
function readTorrentConfig(body, saved) {
  const keys = ['jackett_url', 'qbit_url', 'qbit_user', 'save_path', 'after_upload', 'path_from', 'path_to', 'plugins', 'plugins_path'];
  const values = Object.fromEntries(keys.map((key) => [key, text(body[key])]));
  values.jackett_key = text(body.jackett_key) || saved.jackett_key;

  // An address written without http
  for (const key of ['jackett_url', 'qbit_url']) {
    const url = values[key].replace(/\/+$/, '');
    values[key] = url && !/^https?:\/\//i.test(url) ? `http://${url}` : url;
  }

  return { ...saved, ...values };
}

function parseSeconds(value, name) {
  const seconds = typeof value === 'number' ? value : Number(String(value ?? '').trim());

  if (value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(seconds) || seconds < 0 || seconds >= 100 * 3600) {
    throw new ApiError(`Parametro non valido: ${name}`);
  }

  return seconds;
}

/** A film or an episode watched in the app, with what the row of the home needs to show it */
function readWatchItem(item) {
  if (!storage.isObject(item)) throw new ApiError('Video non valido');

  const optionalInt = (key) => (item[key] !== null && item[key] !== undefined ? parseInt_(item[key], key) : null);
  const textOf = (key) => (typeof item[key] === 'string' && item[key] ? item[key] : null);

  return {
    source: item.source === 'anime' ? 'anime' : 'sc',
    id: parseInt_(item.id, 'id'),
    slug: String(item.slug || ''),
    name: String(item.name || item.slug || ''),
    type: item.type === 'tv' ? 'tv' : 'movie',
    year: item.year ? String(item.year).slice(0, 4) : null,
    poster: textOf('poster'),
    backdrop: textOf('backdrop'),
    dub: Boolean(item.dub),
    season: optionalInt('season'),
    episode_id: optionalInt('episode_id'),
    episode_number: item.episode_number !== null && item.episode_number !== undefined ? String(item.episode_number) : null,
    episode_name: textOf('episode_name'),
  };
}


// [ api ]
class App {
  constructor() {
    // Before the queue: the downloads resumed go to the chosen folder
    videos.load();

    this.site = new Site();
    this.anime = new AnimeSource();
    this.downloads = new DownloadManager(this.site);
    this.recommender = new Recommender(this.site, formatTitle);
    this.animeRecommender = new AnimeRecommender();
    this.torrents = new TorrentManager();
    this.streams = new Streams();
    this.remoteServer = null;
    this.server = null;
    this.lastRequest = Date.now();
    this.lastRemoteRequest = 0;
  }

  /** A download or an upload to the nas is running: the program must stay open */
  isBusy() {
    return this.downloads.isBusy() || this.torrents.isBusy();
  }

  /** The window decides when the program closes, the page only says it is going away */
  close() {
    return { ok: true };
  }

  status() {
    return this.site.status();
  }

  // [ access from the phone ]
  /** Open the app to the devices of the home network, on its own port */
  async startRemote() {
    if (this.remoteServer) return;

    const config = remote.loadConfig();
    const ports = [config.port, ...Array.from({ length: 20 }, (_, index) => remote.DEFAULT_PORT + index)];
    let lastError = null;

    // The saved port could be taken by another program, the next free one is used
    for (const port of ports) {
      try {
        this.remoteServer = await listen(createServer(this, true), REMOTE_HOST, port);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!this.remoteServer) throw new ApiError(`Nessuna porta libera per l'accesso dal telefono (${lastError?.message})`, 500);

    const port = this.remoteServer.address().port;
    if (port !== config.port) remote.saveConfig({ port });

    console.print(`Access from the home network => port ${port}`);
  }

  stopRemote() {
    const server = this.remoteServer;
    this.remoteServer = null;
    if (server) server.close();
  }

  async remoteInfo() {
    const port = this.remoteServer ? this.remoteServer.address().port : remote.loadConfig().port;

    // When the program runs elsewhere (docker) the address to show is given from outside
    const addresses = process.env[ADDRESS_ENV] ? [process.env[ADDRESS_ENV]] : (await remote.getLanIps()).map((ip) => `http://${ip}:${port}`);

    return {
      running: this.remoteServer !== null,
      port,
      addresses,
      qr: addresses.length ? await remote.getQrSvg(addresses[0]) : null,
    };
  }

  getRemote() {
    return this.remoteInfo();
  }

  async setDomain(query, body) {
    await this.site.connect(String(body.domain || ''));
    return this.site.status();
  }

  async home() {
    const props = await this.site.request(Page.getHome);

    return {
      sliders: (props.sliders || []).map((slider) => ({
        name: slider.name,
        label: slider.label,
        titles: slider.titles.map((title) => formatTitle(title, props.cdn_url)),
      })),
    };
  }

  recommendations() {
    return this.recommender.get();
  }

  async search(query) {
    const value = (query.q || '').trim();
    if (!value) throw new ApiError('Scrivi il titolo da cercare');

    const props = await this.site.request((domain, version) => Page.getSearch(value, domain, version));
    return { results: props.titles.map((title) => formatTitle(title, props.cdn_url)) };
  }

  async title(query) {
    const titleId = parseInt_(query.id, 'id');
    const slug = parseSlug(query.slug);
    return formatDetail(await this.site.request((domain, version) => Page.getTitle(titleId, slug, domain, version)));
  }

  async season(query) {
    const titleId = parseInt_(query.id, 'id');
    const slug = parseSlug(query.slug);
    const number = parseInt_(query.number, 'number');
    const props = await this.site.request((domain, version) => tv.getSeason(titleId, slug, domain, version, number));

    return { number, episodes: props.loadedSeason.episodes.map((episode) => formatEpisode(episode, props.cdn_url)) };
  }

  animeHome() {
    return this.anime.home();
  }

  animeRecommendations() {
    return this.animeRecommender.get();
  }

  animeSearch(query) {
    const value = (query.q || '').trim();
    if (!value) throw new ApiError('Scrivi il titolo da cercare');
    return this.anime.search(value);
  }

  animeTitle(query) {
    return this.anime.title(parseInt_(query.id, 'id'));
  }

  animeEpisodes(query) {
    const animeId = parseInt_(query.id, 'id');
    const start = parseInt_(query.start, 'start');
    const end = parseInt_(query.end, 'end');

    if (start < 1 || end < start || end - start > 500) throw new ApiError('Intervallo di episodi non valido');

    return this.anime.episodes(animeId, start, end);
  }

  /** The whole film or episode to watch in the app, in the same quality of the download */
  async stream(query) {
    const source = query.source === 'anime' ? 'anime' : 'sc';
    const titleId = parseInt_(query.id, 'id');
    const episodeId = query.episode_id ? parseInt_(query.episode_id, 'episode_id') : null;

    if (source === 'sc' && !this.site.domain) throw new ApiError('Imposta prima il dominio del sito', 409);
    if (source === 'sc' && query.type === 'tv' && episodeId === null) throw new ApiError('Parametro non valido: episode_id');

    const stream = await this.streams.open(await vixcloud.getStream(await this.getPlayer(source, titleId, episodeId)));
    const height = stream.resolution ? stream.resolution[1] : 0;

    return {
      url: `/api/stream/${stream.id}/master.m3u8`,
      quality: height ? `${height}p` : null,
      language: stream.language,
      duration: Math.round(stream.duration),
      subtitles: stream.subtitles.map((track, index) => ({
        url: `/api/stream/${stream.id}/subtitles/${index}.vtt`,
        label: track.title,
        language: track.language,
        default: track.default,
      })),
    };
  }

  /** Script of the vixcloud player of a film or an episode */
  async getPlayer(source, titleId, episodeId) {
    if (source === 'anime') {
      let episode = episodeId;

      // A film of anime is its first episode
      if (episode === null) {
        const episodes = await anime.client.getEpisodes(titleId, 1, 1);
        if (!episodes.length) throw new ApiError('Episodio non trovato', 404);
        episode = parseInt(episodes[0].id, 10);
      }

      return anime.getPlayerScript(await anime.client.getEmbedUrl(episode));
    }

    const domain = this.site.domain;
    if (episodeId === null) return film.getIframe(titleId, domain);

    return tv.getIframe(titleId, episodeId, domain, await tv.getToken(titleId, domain));
  }

  // [ where the videos have been stopped ]
  watch() {
    return watchProgress.view();
  }

  /** Position of the video watched now, sent by the player every few seconds and when it closes */
  saveWatch(query, body) {
    const item = readWatchItem(body.item);
    const entry = { ...item, position: parseSeconds(body.position, 'position'), duration: parseSeconds(body.duration, 'duration') };

    // The episode after it, proposed in the home when this one is seen to the end
    const following = body.next;
    let nextEntry = null;
    if (storage.isObject(following) && following.episode_id !== null && following.episode_id !== undefined) {
      nextEntry = readWatchItem({ ...body.item, episode_name: null, ...following });
    }

    return watchProgress.view(watchProgress.save(entry, nextEntry));
  }

  dismissWatch(query, body) {
    const source = body.source === 'anime' ? 'anime' : 'sc';
    return watchProgress.view(watchProgress.dismiss(source, parseInt_(body.id, 'id')));
  }

  listDownloads() {
    return { jobs: this.downloads.list() };
  }

  addDownloads(query, body) {
    const items = body.items;
    if (!Array.isArray(items) || !items.length) throw new ApiError('Nessun elemento da scaricare');

    return { added: this.downloads.add(items), jobs: this.downloads.list() };
  }

  removeDownload(query, body) {
    if (!this.downloads.remove(parseInt_(body.id, 'id'))) throw new ApiError('Questo download non può essere rimosso');
    return { jobs: this.downloads.list() };
  }

  clearDownloads() {
    this.downloads.clear();
    return { jobs: this.downloads.list() };
  }

  cancelDownload(query, body) {
    if (!this.downloads.cancel(parseInt_(body.id, 'id'))) throw new ApiError('Questo download non è più in corso');
    return { jobs: this.downloads.list() };
  }

  uploadDownload(query, body) {
    if (!this.downloads.retryUpload(parseInt_(body.id, 'id'))) throw new ApiError('Questo file non può essere caricato di nuovo');
    return { jobs: this.downloads.list() };
  }

  nasConfig() {
    return this.nasStatus(nas.loadConfig());
  }

  saveNas(query, body) {
    const before = nas.loadConfig();
    const config = nas.saveConfig(readNas(body));
    const status = this.nasStatus(config);

    // A nas just turned on, or with other folders, has past downloads never imported (the first start could be without nas)
    const where = (value) => JSON.stringify(['host', 'port', 'film_path', 'tv_path', 'anime_path'].map((key) => value[key]));
    if (nas.isEnabled(config) && !(nas.isEnabled(before) && where(before) === where(config))) history.resetImported();

    if (body.password && !nas.savePassword(config, String(body.password))) {
      status.password_error = `Password non salvata: non riesco a scriverla, impostala con la variabile ${nas.PASSWORD_ENV}`;
    }

    return status;
  }

  async testNas(query, body) {
    const config = readNas(body);

    try {
      return { ok: true, ...await nas.testConnection(config, String(body.password || '') || null) };
    } catch (error) {
      if (!(error instanceof nas.NasError)) throw error;
      return { ok: false, error: error.message };
    }
  }

  nasStatus(config) {
    return { ...config, password_saved: Boolean(nas.getPassword(config)) };
  }

  // [ torrents ]
  torrentStatus() {
    return this.torrents.status();
  }

  torrentSearch(query) {
    const value = (query.q || '').trim();
    if (!value) throw new ApiError('Scrivi cosa cercare');

    const category = Object.hasOwn(jackett.CATEGORIES, query.cat) ? query.cat : 'all';
    return this.torrents.search(value, category);
  }

  async torrentList() {
    return { items: this.torrents.list(), status: await this.torrents.status() };
  }

  /** A scheda tecnica being made, asked often by the page while it waits */
  torrentItem(query) {
    const item = this.torrents.touch(parseInt_(query.id, 'id'));
    if (!item) throw new ApiError("Questo torrent non c'è più", 404);

    return this.torrents.view(item);
  }

  torrentInspect(query, body) {
    return this.torrents.inspect(String(body.result || ''), body.media);
  }

  async torrentDownload(query, body) {
    return { ...await this.torrents.download(body), items: this.torrents.list() };
  }

  torrentDiscard(query, body) {
    this.torrents.discard(parseInt_(body.id, 'id'));
    return { items: this.torrents.list() };
  }

  async torrentPause(query, body) {
    await this.torrents.setPaused(parseInt_(body.id, 'id'), Boolean(body.paused));
    return { items: this.torrents.list() };
  }

  torrentUpload(query, body) {
    this.torrents.retryUpload(parseInt_(body.id, 'id'));
    return { items: this.torrents.list() };
  }

  torrentOpen(query, body) {
    const folder = this.torrents.getFolder(parseInt_(body.id, 'id'));

    if (!folder || !fs.existsSync(folder)) throw new ApiError('I file di questo torrent non si trovano su questo PC', 404);

    platform.openInExplorer(folder);
    return { ok: true };
  }

  async torrentConfig() {
    const config = torrentConfig.loadConfig();
    return { ...this.torrentSettings(config), ...await this.pluginSettings(config) };
  }

  /** Search plugins of qbittorrent found on this pc */
  async pluginSettings(config) {
    try {
      const [folder, engines] = await plugins.getEngines(config);
      return { plugins_folder: folder, plugins_found: Object.values(engines).map((engine) => engine.name), plugins_error: null };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { plugins_folder: null, plugins_found: [], plugins_error: error.message };
    }
  }

  async saveTorrentConfig(query, body) {
    const config = torrentConfig.saveConfig(readTorrentConfig(body, torrentConfig.loadConfig()));
    const saved = !body.qbit_password || torrentConfig.savePassword(config, String(body.qbit_password));
    const settings = this.torrentSettings(config);

    if (!saved) settings.password_error = 'Password non salvata: non riesco a scriverla';

    this.torrents.resetClient();
    plugins.forget();
    return { ...settings, ...await this.pluginSettings(config) };
  }

  async testTorrentConfig(query, body) {
    const config = readTorrentConfig(body, torrentConfig.loadConfig());
    const result = { plugins: 0 };

    if (config.plugins !== 'off') {
      try {
        result.plugins = Object.keys((await plugins.getEngines(config))[1]).length;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }

    try {
      result.jackett = { ok: true, indexers: await jackett.countIndexers(config) };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result.jackett = { ok: false, error: error.message };
    }

    if (!config.qbit_url) {
      result.qbit = { ok: true, mode: 'app' };
      return result;
    }

    try {
      const client = new qbittorrent.Client(config, String(body.qbit_password || '') || null);
      result.qbit = { ok: true, version: await client.version(), save_path: (await client.preferences()).save_path ?? null };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result.qbit = { ok: false, error: error.message };
    }

    return result;
  }

  torrentSettings(config) {
    const { jackett_key: key, ...rest } = config;

    return {
      ...rest,
      jackett_key_saved: Boolean(key),
      jackett_key_auto: Boolean(torrentConfig.findPluginKey()),
      password_saved: Boolean(torrentConfig.getPassword(config)),
      docker: torrentConfig.IN_DOCKER,
    };
  }

  openFolder(query, body) {
    const output = body.id !== null && body.id !== undefined ? this.downloads.getOutput(parseInt_(body.id, 'id')) : null;
    fs.mkdirSync(paths.videos(), { recursive: true });

    let isFile = false;
    try {
      isFile = Boolean(output) && fs.statSync(output).isFile();
    } catch {
      isFile = false;
    }

    platform.openInExplorer(isFile ? output : paths.videos());
    return { ok: true };
  }

  // [ folder of the videos ]
  videosStatus() {
    return { path: videos.loadPath(), folder: paths.videos(), default: paths.defaultVideos(), docker: torrentConfig.IN_DOCKER };
  }

  videosConfig() {
    return this.videosStatus();
  }

  saveVideos(query, body) {
    try {
      videos.savePath(body.path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new ApiError(`Non riesco a scrivere in questa cartella: ${lowerFirst(describe(error))}`);
    }

    return this.videosStatus();
  }
}

const ROUTES = {
  'GET /api/status': App.prototype.status,
  'GET /api/remote': App.prototype.getRemote,
  'POST /api/domain': App.prototype.setDomain,
  'GET /api/home': App.prototype.home,
  'GET /api/recommendations': App.prototype.recommendations,
  'GET /api/search': App.prototype.search,
  'GET /api/title': App.prototype.title,
  'GET /api/season': App.prototype.season,
  'GET /api/anime/home': App.prototype.animeHome,
  'GET /api/anime/search': App.prototype.animeSearch,
  'GET /api/anime/title': App.prototype.animeTitle,
  'GET /api/anime/episodes': App.prototype.animeEpisodes,
  'GET /api/anime/recommendations': App.prototype.animeRecommendations,
  'GET /api/stream': App.prototype.stream,
  'GET /api/progress': App.prototype.watch,
  'POST /api/progress': App.prototype.saveWatch,
  'POST /api/progress/dismiss': App.prototype.dismissWatch,
  'GET /api/downloads': App.prototype.listDownloads,
  'POST /api/downloads': App.prototype.addDownloads,
  'POST /api/downloads/remove': App.prototype.removeDownload,
  'POST /api/downloads/clear': App.prototype.clearDownloads,
  'POST /api/downloads/upload': App.prototype.uploadDownload,
  'POST /api/downloads/cancel': App.prototype.cancelDownload,
  'GET /api/nas': App.prototype.nasConfig,
  'POST /api/nas': App.prototype.saveNas,
  'POST /api/nas/test': App.prototype.testNas,
  'GET /api/torrents/status': App.prototype.torrentStatus,
  'GET /api/torrents/search': App.prototype.torrentSearch,
  'GET /api/torrents': App.prototype.torrentList,
  'GET /api/torrents/item': App.prototype.torrentItem,
  'POST /api/torrents/inspect': App.prototype.torrentInspect,
  'POST /api/torrents/download': App.prototype.torrentDownload,
  'POST /api/torrents/discard': App.prototype.torrentDiscard,
  'POST /api/torrents/pause': App.prototype.torrentPause,
  'POST /api/torrents/upload': App.prototype.torrentUpload,
  'POST /api/torrents/open': App.prototype.torrentOpen,
  'GET /api/torrents/config': App.prototype.torrentConfig,
  'POST /api/torrents/config': App.prototype.saveTorrentConfig,
  'POST /api/torrents/config/test': App.prototype.testTorrentConfig,
  'POST /api/open': App.prototype.openFolder,
  'GET /api/videos': App.prototype.videosConfig,
  'POST /api/videos': App.prototype.saveVideos,
  'POST /api/close': App.prototype.close,
};


// [ server ]
function sendBody(response, body, contentType, status = 200) {
  if (response.headersSent || response.destroyed) return;

  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendJson(response, data, status = 200) {
  sendBody(response, Buffer.from(JSON.stringify(data), 'utf8'), 'application/json; charset=utf-8', status);
}

function readJson(request) {
  // Json content type needs a cors preflight, so other web pages cant post here
  if ((request.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
    request.resume();
    return Promise.reject(new ApiError('Content-Type non valido', 415));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ApiError('Richiesta troppo grande', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        reject(new ApiError('JSON non valido'));
        return;
      }

      if (!storage.isObject(body)) reject(new ApiError('JSON non valido'));
      else resolve(body);
    });
  });
}

function sendStatic(response, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    sendJson(response, { error: 'Risorsa non trovata' }, 404);
    return;
  }

  const file = path.normalize(path.join(WEB_FOLDER, relative));
  const extension = path.extname(file);

  if (!file.startsWith(WEB_FOLDER + path.sep) || !CONTENT_TYPES[extension] || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(response, { error: 'Risorsa non trovata' }, 404);
    return;
  }

  sendBody(response, fs.readFileSync(file), CONTENT_TYPES[extension]);
}

async function sendStream(app, response, pathname) {
  const match = /^\/api\/stream\/([0-9a-f]{16})\/(?:(master|video|audio)\.m3u8|(video|audio)\/(\d+)\.ts|subtitles\/(\d+)\.vtt)$/.exec(pathname);
  const stream = match ? app.streams.get(match[1]) : null;

  if (!stream) {
    sendJson(response, { error: 'Video non trovato, riaprilo' }, 404);
    return;
  }

  if (match[5]) {
    const text = await stream.subtitle(Number(match[5]));
    if (text === null) {
      sendJson(response, { error: 'Sottotitoli non trovati' }, 404);
      return;
    }
    sendBody(response, Buffer.from(text, 'utf8'), 'text/vtt; charset=utf-8');
    return;
  }

  if (match[2]) {
    const playlist = match[2] === 'master' ? stream.master() : stream.playlist(match[2]);
    if (playlist === null) {
      sendJson(response, { error: 'Traccia non trovata' }, 404);
      return;
    }
    sendBody(response, Buffer.from(playlist, 'utf8'), 'application/vnd.apple.mpegurl');
    return;
  }

  // The player asks again by itself the segments that fail
  let data;
  try {
    data = await stream.segment(match[3], Number(match[4]));
  } catch (error) {
    if (!(error instanceof SegmentError)) throw error;
    sendJson(response, { error: error.message }, 502);
    return;
  }

  if (data === null) {
    sendJson(response, { error: 'Segmento non trovato' }, 404);
    return;
  }

  sendBody(response, data, 'video/mp2t');
}

function createServer(app, isRemote = false) {
  const server = http.createServer(async (request, response) => {
    const method = request.method;
    let url;

    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      sendJson(response, { error: 'Risorsa non trovata' }, 404);
      return;
    }

    const pathname = url.pathname;
    const port = server.address()?.port;

    if (isRemote) {
      // Requests from the other devices: any device of the home network, never from internet
      if (!remote.isHomeNetwork(request.socket.remoteAddress)) {
        sendJson(response, { error: 'Accesso consentito solo dalla rete di casa' }, 403);
        return;
      }
      if (remote.LOCAL_ONLY.has(`${method} ${pathname}`)) {
        sendJson(response, { ok: true });
        return;
      }
      app.lastRemoteRequest = Date.now();

    // Accept only requests addressed to this server (dns rebinding)
    } else if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) {
      sendJson(response, { error: 'Host non valido' }, 403);
      return;
    }

    try {
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        sendStatic(response, pathname);
        return;
      }

      // The video watched in the app, the player asks its playlists and then the segments one by one
      if (method === 'GET' && pathname.startsWith('/api/stream/')) {
        await sendStream(app, response, pathname);
        return;
      }

      const route = ROUTES[`${method} ${pathname}`];
      if (!route) {
        sendJson(response, { error: 'Risorsa non trovata' }, 404);
        return;
      }

      // Used to know if the window is still open
      if (pathname !== '/api/close') app.lastRequest = Date.now();

      const body = method === 'POST' ? await readJson(request) : {};
      const query = Object.fromEntries(url.searchParams.entries());
      let result = await route.call(app, query, body);

      // The page on the phone hides what works only on the pc
      if (pathname === '/api/status') result = { ...result, remote_client: isRemote };

      sendJson(response, result);

    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, { error: error.message }, error.status);
        return;
      }
      if (error instanceof AppError) {
        sendJson(response, { error: describe(error) }, 502);
        return;
      }

      console.log(`GUI error on ${pathname}: ${error.stack || error}`);
      logError(`GUI error on ${pathname}`, error);

      // Which site did not answer and why, never a generic message
      sendJson(response, { error: await describeAsync(error) }, 502);
    }
  });

  // A browser closing a connection is not an error
  server.on('clientError', (error, socket) => socket.destroy());
  return server;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Half built files are removed at the start. Segments stay, they are the downloads to resume,
 * only the ones not touched for days (downloads removed from the list) are deleted.
 */
function cleanTemp() {
  for (const folder of [paths.tmp('output'), paths.tmp('preview')]) {
    fs.rmSync(folder, { recursive: true, force: true });
  }

  const segments = paths.tmp('segments');
  let entries;
  try {
    entries = fs.readdirSync(segments, { withFileTypes: true });
  } catch {
    return;
  }

  const limit = Date.now() - SEGMENTS_MAX_AGE;
  for (const entry of entries) {
    try {
      const folder = path.join(segments, entry.name);
      if (entry.isDirectory() && fs.statSync(folder).mtimeMs < limit) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // Removed at the next start
    }
  }
}

/** Start the program: the server of the window on 127.0.0.1 and the one of the home network */
async function start({ port = DEFAULT_PORT } = {}) {
  cleanTemp();

  const app = new App();
  let server;

  try {
    server = await listen(createServer(app), '127.0.0.1', port);
  } catch {
    server = await listen(createServer(app), '127.0.0.1', 0);
  }

  app.server = server;
  const url = `http://127.0.0.1:${server.address().port}`;

  // Every device of the home network can open the app
  try {
    await app.startRemote();
  } catch (error) {
    logError('Access from the home network not started', error);
  }

  console.print(`GUI ready => ${url}`);
  return { app, url };
}

/** The program is closing: running downloads pause and go on at the next start */
async function stop(app) {
  app.server?.close();
  app.stopRemote();
  await Promise.all([app.downloads.stop(), app.torrents.stop()]);
}

module.exports = { start, stop, App, Site, formatTitle };

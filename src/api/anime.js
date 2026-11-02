// 18.09.26

const cheerio = require('cheerio');
const http = require('../util/http');
const { getHeaders } = require('../util/headers');
const { console } = require('../util/console');
const { HttpError, RequestError, step } = require('../util/errors');
const { downloadM3u8 } = require('../lib/downloader');
const { finalize } = require('../lib/nas');
const paths = require('../paths');
const vixcloud = require('./vixcloud');

// The site changes address from time to time, the old ones (.to, .it) send to the new one
const DOMAINS = ['https://www.animeunity.co', 'https://www.animeunity.to', 'https://www.animeunity.it'];
const EPISODES_PAGE = 120;      // The site gives at most 120 episodes for every request


/** Session with the site, its api wants the xsrf token of the session */
class AnimeUnity {
  constructor() {
    this.session = null;
    this.baseUrl = DOMAINS[0];
    this.opening = null;
  }

  /** The address that answers last time first, then the others, following where they send */
  open() {
    if (!this.opening) {
      this.opening = this.connect().finally(() => { this.opening = null; });
    }
    return this.opening;
  }

  async connect() {
    let lastError = null;

    for (const baseUrl of new Set([this.baseUrl, ...DOMAINS])) {
      const session = new http.Session({ 'user-agent': getHeaders() });
      let response;

      try {
        response = (await http.get(baseUrl, { session, timeout: 15 })).raiseForStatus();
      } catch (error) {
        if (!(error instanceof RequestError || error instanceof HttpError)) throw error;
        lastError = error;
        continue;
      }

      this.baseUrl = new URL(response.url).origin;
      session.headers.referer = `${this.baseUrl}/`;
      session.headers['x-xsrf-token'] = decodeURIComponent(session.cookies.get('XSRF-TOKEN') || '');
      this.session = session;
      return;
    }

    throw lastError;
  }

  async request(method, path, options = {}) {
    if (!this.session) await this.open();
    let response = null;

    try {
      response = await http.request(method, `${this.baseUrl}${path}`, { ...options, session: this.session });
    } catch (error) {
      // The address may be gone while the program is open, the others are tried
      if (!(error instanceof RequestError)) throw error;
    }

    // Laravel answers 419 when the token of the session is expired
    if (!response || [401, 419].includes(response.status)) {
      await this.open();
      response = await http.request(method, `${this.baseUrl}${path}`, { ...options, session: this.session });
    }

    return response.raiseForStatus();
  }

  /** Featured anime and last episodes, the site puts them inside the page */
  async getHome() {
    const $ = cheerio.load((await this.request('GET', '/')).text);
    const carousel = $('the-carousel').attr('animes');
    const latest = $('layout-items').attr('items-json');

    return {
      featured: carousel ? JSON.parse(carousel) : [],
      latest: latest ? JSON.parse(latest).data : [],
    };
  }

  async getArchive(filters = {}) {
    const body = { title: false, type: false, year: false, order: false, status: false, genres: false, offset: 0, dubbed: false, season: false, ...filters };
    return (await this.request('POST', '/archivio/get-animes', { json: body })).json().records || [];
  }

  /** Quick search and archive search together, like the search bar of the site */
  async search(title) {
    const found = new Map();

    for (const record of (await this.request('POST', '/livesearch', { data: { title } })).json().records || []) {
      if (!found.has(record.id)) found.set(record.id, record);
    }

    for (const record of await this.getArchive({ title })) {
      if (!found.has(record.id)) found.set(record.id, record);
    }

    return [...found.values()];
  }

  async getInfo(animeId) {
    return (await this.request('GET', `/info_api/${animeId}/`)).json();
  }

  /** Related anime with images and slug, the info api gives them without */
  async getRelated(animeId, slug) {
    const player = cheerio.load((await this.request('GET', `/anime/${animeId}-${slug}`)).text)('video-player').attr('anime');
    return player ? JSON.parse(player).related || [] : [];
  }

  /** Episodes from number start to end, asked in pages of the size allowed by the site */
  async getEpisodes(animeId, start, end) {
    const episodes = [];

    for (let first = start; first <= end; first += EPISODES_PAGE) {
      const last = Math.min(first + EPISODES_PAGE - 1, end);
      const response = await this.request('GET', `/info_api/${animeId}/1`, { params: { start_range: first, end_range: last } });
      episodes.push(...(response.json().episodes || []));
    }

    return episodes;
  }

  async getEmbedUrl(episodeId) {
    return (await this.request('GET', `/embed-url/${episodeId}`)).text.trim();
  }
}

const client = new AnimeUnity();


/** Italian title if the site has it, then the english one used by the site */
function getTitleName(anime) {
  return anime.title_it || anime.title_eng || anime.title || anime.slug;
}

/** Script of the vixcloud player with the parameters of the video */
function getPlayerScript(embedUrl) {
  return vixcloud.getPlayerScript(embedUrl);
}

async function dwEpisode(animeId, slug, episodeId, episodeNumber, progressCallback = null, media = null) {
  console.print(`Download anime: ${slug} => episode ${episodeNumber}`);

  // Same vixcloud player of streamingcommunity
  const embedUrl = await step("Ricerca dell'episodio su AnimeUnity", () => client.getEmbedUrl(episodeId));
  const player = await step('Lettura del player', async () => vixcloud.readPlayer(await getPlayerScript(embedUrl)));

  const mp4Path = paths.videos('anime', slug, `${slug}_E${episodeNumber}.mp4`);

  if (player.audioUrl) console.print('Use m3u8 audio => True');

  // Animeunity burns the italian subtitles into the video, there is no subtitle track to look for
  console.print('Subtitles => already in the video');
  await downloadM3u8({ m3u8Index: player.videoUrl, m3u8Audio: player.audioUrl, key: player.key, outputFilename: mp4Path, progressCallback });

  // Rename the file and move it to the nas if it is enabled
  return step('Salvataggio del file', () => finalize(mp4Path, media, progressCallback));
}

module.exports = { client, AnimeUnity, getTitleName, getPlayerScript, dwEpisode, DOMAINS };

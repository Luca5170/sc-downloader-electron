// 18.09.26

const fs = require('fs');
const anime = require('../api/anime');
const nas = require('../lib/nas');
const history = require('../util/history');
const paths = require('../paths');
const { formatAnime } = require('./anime_source');
const { normalize, parseName } = require('./recommend');
const { console } = require('../util/console');
const { map, Mutex } = require('../util/pool');

const MAX_TITLES = 20;          // Titles in the row
const MAX_SEEDS = 10;           // Recent downloads used to find new titles
const MAX_RELATED = 4;          // Sequels and prequels of every download looked in detail
const MIN_SCORE = 1.6;          // Below this an anime is not similar enough to be proposed
const CACHE_TIME = 6 * 3600 * 1000;

// Genres that almost every anime has, they say little about a taste
const COMMON_GENRES = new Set(['Action', 'Comedy', 'Drama', 'Adventure', 'Fantasy', 'Shounen']);


// [ similarity ]
function getGenres(record) {
  return new Set((record.genres || []).map((genre) => (typeof genre === 'string' ? genre : genre?.name)).filter(Boolean));
}

/** Name without the (ITA) of the dubbed copies, the same anime has one copy for every audio */
function baseName(record) {
  return normalize((anime.getTitleName(record) || '').replace(/\(\s*ita\s*\)/gi, ''));
}

function similarity(seed, record, related) {
  const genres = getGenres(record);
  const shared = [...seed.genres].filter((genre) => genres.has(genre)).length;
  const genreSim = shared / Math.max(1, new Set([...seed.genres, ...genres]).size);
  const rating = parseFloat(record.score || 6) / 10;

  // The other seasons and films of the same story are the best proposals
  return genreSim * 3 + rating * 0.6 + (related ? 1.5 : 0);
}


// [ past downloads ]
function getPast() {
  return history.load().titles.filter((title) => title.source === 'anime');
}

/** Anime already downloaded: folders with the slug in videos/anime, folders 'Name (Year)' on the nas */
async function listDownloads() {
  const found = [];

  try {
    for (const entry of fs.readdirSync(paths.videos('anime'), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        found.push({ ...parseName(entry.name), date: fs.statSync(paths.videos('anime', entry.name)).mtimeMs / 1000 });
      }
    }
  } catch {
    // No anime yet
  }

  const config = nas.loadConfig();
  if (nas.isEnabled(config) && config.anime_path) {
    await nas.withSftp(config, async (sftp) => {
      let entries;
      try {
        entries = await sftp.readdir(config.anime_path);
      } catch {
        entries = [];
      }

      for (const entry of entries) {
        if (entry.attrs.isDirectory() && !entry.filename.startsWith('.')) found.push({ ...parseName(entry.filename), date: entry.attrs.mtime });
      }
    });
  }

  return found;
}

/** The anime of the site with this name, the year decides between anime with the same name */
async function findAnime(item) {
  const sameName = [];

  for (const record of await anime.client.search(item.name)) {
    if (item.slug && record.slug === item.slug) return record;

    const names = new Set(['title_it', 'title_eng', 'title'].map((key) => normalize(record[key])));
    if (names.has(normalize(item.name))) {
      if (item.year && String(record.date || '').slice(0, 4) === item.year) return record;
      sameName.push(record);
    }
  }

  // The copy with the original audio before the dubbed one
  sameName.sort((a, b) => Number(Boolean(a.dub)) - Number(Boolean(b.dub)));
  return sameName[0] || null;
}

function hasSources() {
  const config = nas.loadConfig();
  return fs.existsSync(paths.videos('anime')) || Boolean(nas.isEnabled(config) && config.anime_path);
}

/** At the first start the past anime are taken from the names of the folders */
async function importDownloads() {
  // Without folders of anime yet, the import waits for them
  if (!hasSources()) return;

  let found;
  try {
    found = await listDownloads();
  } catch (error) {
    if (!(error instanceof nas.NasError)) throw error;
    console.log(`Anime recommendations: nas not reachable, past downloads imported later (${error.message})`);
    return;
  }

  const records = await map(found, (item) => findAnime(item).catch(() => null), 6);
  const known = new Set(getPast().map((title) => title.id));
  const imported = new Map();

  found.forEach((item, index) => {
    const record = records[index];
    if (!record || known.has(record.id)) return;

    const previous = imported.get(record.id);
    if (!previous || item.date > previous.date) {
      const title = formatAnime(record);
      imported.set(record.id, {
        id: title.id, slug: title.slug, name: title.name, type: title.type, year: title.year, date: item.date, source: 'anime',
      });
    }
  });

  history.addMany([...imported.values()], true, 'imported_anime');
  console.log(`Anime recommendations: ${imported.size} past downloads imported`);
}


// [ recommendations ]
/** Anime similar to the past downloads: other seasons of the same story and anime with the same genres */
class AnimeRecommender {
  constructor() {
    this.mutex = new Mutex();
    this.infos = new Map();     // Pages of the anime, they change rarely
    this.lists = new Map();     // Lists of the archive by genres
    this.result = null;
    this.resultKey = null;
    this.resultTime = 0;
  }

  get() {
    return this.mutex.run(async () => {
      if (!history.load().imported_anime) await importDownloads();

      const past = getPast();
      const key = JSON.stringify(past.map((title) => [title.id, title.date]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));

      if (!this.result || key !== this.resultKey || Date.now() - this.resultTime > CACHE_TIME) {
        this.result = await this.compute(past);
        this.resultKey = key;
        this.resultTime = Date.now();
      }

      return this.result;
    });
  }

  async getInfo(animeId) {
    if (!this.infos.has(animeId)) {
      try {
        this.infos.set(animeId, await anime.client.getInfo(animeId));
      } catch {
        return null;
      }
    }

    return this.infos.get(animeId);
  }

  async getList(filters) {
    const key = JSON.stringify(Object.entries(filters).sort());
    if (!this.lists.has(key)) {
      try {
        this.lists.set(key, await anime.client.getArchive(filters));
      } catch {
        return [];
      }
    }

    return this.lists.get(key);
  }

  async compute(past) {
    const recent = [...past].sort((a, b) => b.date - a.date).slice(0, MAX_SEEDS);
    const infos = await map(recent, (title) => this.getInfo(title.id), 6);

    const ownedIds = new Set(past.map((title) => title.id));
    const ownedNames = new Set(infos.filter(Boolean).map(baseName));

    // Ids and rarity of the genres come from the most popular anime
    const popular = [...await this.getList({ order: 'Popolarità' }), ...await this.getList({ order: 'Valutazione' })];
    const genreIds = new Map();
    const frequency = new Map();
    for (const record of popular) {
      for (const genre of record.genres || []) if (genre && typeof genre === 'object') genreIds.set(genre.name, genre.id);
      for (const name of getGenres(record)) frequency.set(name, (frequency.get(name) || 0) + 1);
    }

    const seeds = [];
    const searches = [];
    recent.forEach((title, index) => {
      const info = infos[index];
      if (!info) return;

      const genres = getGenres(info);
      seeds.push({ ...title, genres, related: (info.related || []).filter((record) => record.id !== info.id) });

      // The two rarest genres of the anime find the ones like it
      const specific = [...genres].filter((genre) => genreIds.has(genre))
        .sort((a, b) => Number(COMMON_GENRES.has(a)) - Number(COMMON_GENRES.has(b)) || (frequency.get(a) || 0) - (frequency.get(b) || 0))
        .slice(0, 2);

      if (specific.length) {
        const filters = { genres: specific.map((genre) => ({ id: genreIds.get(genre), name: genre })) };
        searches.push({ ...filters, order: 'Popolarità' }, { ...filters, order: 'Valutazione' });
      }
    });

    // Other seasons and films of the same story, the related list has no image so their page is needed
    const relatedIds = [];
    for (const seed of seeds) {
      const others = seed.related.filter((record) => !ownedIds.has(record.id) && ['TV', 'Movie', 'ONA'].includes(record.type));
      for (const record of others.slice(0, MAX_RELATED)) if (!relatedIds.includes(record.id)) relatedIds.push(record.id);
    }

    const lists = await map(searches, (filters) => this.getList(filters), 6);
    const relatedInfos = await map(relatedIds, (animeId) => this.getInfo(animeId), 6);

    const candidates = new Map();
    for (const record of [...lists.flat(), ...relatedInfos.filter(Boolean)]) {
      if (!ownedIds.has(record.id) && !ownedNames.has(baseName(record)) && !candidates.has(record.id)) candidates.set(record.id, record);
    }

    // One copy for every anime, the original audio unless only the dubbed one is there
    const copies = new Map();
    for (const record of [...candidates.values()].sort((a, b) => Number(Boolean(a.dub)) - Number(Boolean(b.dub)))) {
      if (!copies.has(baseName(record))) copies.set(baseName(record), record);
    }
    const chosen = new Map([...copies.values()].map((record) => [record.id, record]));

    const ranked = new Map();
    for (const seed of seeds) {
      const related = new Set(seed.related.map((record) => record.id));
      ranked.set(seed.id, [...chosen.entries()]
        .map(([recordId, record]) => [similarity(seed, record, related.has(recordId)), recordId])
        .sort((a, b) => b[0] - a[0]));
    }

    // Turns between downloads, so different tastes all have their place
    const picked = new Map();
    while (picked.size < MAX_TITLES && [...ranked.values()].some((queue) => queue.length)) {
      for (const seed of seeds) {
        const queue = ranked.get(seed.id);

        while (queue.length && picked.size < MAX_TITLES) {
          const [score, recordId] = queue.shift();

          if (score < MIN_SCORE) {
            queue.length = 0;
          } else if (!picked.has(recordId)) {
            picked.set(recordId, seed.name);
            break;
          }
        }
      }
    }

    const titles = [...picked.entries()].map(([recordId, because]) => formatAnime(chosen.get(recordId), `Perché hai scaricato ${because}`));
    return { titles, based_on: past.length };
  }
}

module.exports = { AnimeRecommender };

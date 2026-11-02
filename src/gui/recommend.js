// 18.09.26

const fs = require('fs');
const Page = require('../api/page');
const nas = require('../lib/nas');
const history = require('../util/history');
const paths = require('../paths');
const { console } = require('../util/console');
const { map, Mutex } = require('../util/pool');

const MAX_TITLES = 20;          // Titles in the row
const MAX_SEEDS = 10;           // Recent downloads used to find new titles
const SHORTLIST = 8;            // Candidates of every download that are looked in detail
const MIN_SCORE = 2.0;          // Below this a title is not similar enough to be proposed
const CACHE_TIME = 6 * 3600 * 1000;

// Tags about the production of a film, they say nothing about its story
const STOP_KEYWORDS = new Set(['aftercreditsstinger', 'duringcreditsstinger', 'woman director', 'live action and animation', 'short film']);


// [ similarity ]
function normalize(text) {
  const ascii = String(text ?? '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  return ascii.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
}

function getTags(title) {
  const genres = new Set((title.genres || []).map((genre) => genre.name));
  const keywords = new Set((title.keywords || []).map((keyword) => keyword.name).filter((name) => !STOP_KEYWORDS.has(name)));
  return [genres, keywords];
}

function intersection(a, b) {
  return [...a].filter((item) => b.has(item)).length;
}

/** How much a title looks like a past download, mostly by the keywords of the story */
function similarity(seed, title) {
  const [genres, keywords] = getTags(title);
  const keywordSim = intersection(seed.keywords, keywords) / Math.sqrt(Math.max(1, seed.keywords.size) * Math.max(1, keywords.size));
  const genreSim = intersection(seed.genres, genres) / Math.max(1, new Set([...seed.genres, ...genres]).size);
  const rating = parseFloat(title.score || 6) / 10;

  return keywordSim * 3 + genreSim * 2 + rating * 0.3 + (title.type === seed.type ? 0.3 : 0);
}


// [ past downloads ]
/** Films and series of streamingcommunity, anime have their own history */
function getPast() {
  return history.load().titles.filter((title) => (title.source || 'sc') === 'sc');
}

/** Title and year from 'Mary Poppins (1964)', or the slug of old names like 'x-men-linizio.mp4' */
function parseName(value) {
  const name = value.endsWith('.mp4') ? value.slice(0, -4) : value;
  const match = /^(.*) \((\d{4})\)$/.exec(name);

  if (match) return { name: match[1], year: match[2] };
  if (/^[a-z0-9+-]+$/.test(name)) return { name: name.replaceAll('-', ' '), slug: name };

  return { name };
}

/** Names of the titles already downloaded, in the videos folder and on the nas */
async function listDownloads() {
  const found = [];

  function add(name, kind, isFolder, date) {
    if (name.startsWith('.') || ['subtitle', 'anime'].includes(name) || name.endsWith('.parte') || name.endsWith('.audio.mp4')) return;
    if (!isFolder && !name.endsWith('.mp4')) return;
    if (kind === 'tv' && !isFolder) return;

    found.push({ ...parseName(name), type: kind, date });
  }

  // Films are files, series are folders with their episodes
  try {
    for (const entry of fs.readdirSync(paths.videos(), { withFileTypes: true })) {
      const date = fs.statSync(paths.videos(entry.name)).mtimeMs / 1000;
      add(entry.name, entry.isDirectory() ? 'tv' : 'movie', entry.isDirectory(), date);
    }
  } catch {
    // No videos yet
  }

  const config = nas.loadConfig();
  if (nas.isEnabled(config)) {
    await nas.withSftp(config, async (sftp) => {
      for (const [folder, kind] of [[config.film_path, 'movie'], [config.tv_path, 'tv']]) {
        let entries;
        try {
          entries = folder ? await sftp.readdir(folder) : [];
        } catch {
          continue;
        }

        for (const entry of entries) add(entry.filename, kind, entry.attrs.isDirectory(), entry.attrs.mtime);
      }
    });
  }

  return found;
}

/** The title of the site with this name, the year decides between titles with the same name */
async function findTitle(site, item) {
  const { titles } = await site.request((domain, version) => Page.getSearch(item.name, domain, version));
  const sameName = [];

  for (const title of titles) {
    if (item.slug && title.slug === item.slug) return title;

    if (normalize(title.name) === normalize(item.name) && title.type === item.type) {
      if (item.year && (title.last_air_date || '').slice(0, 4) === item.year) return title;
      sameName.push(title);
    }
  }

  return sameName[0] || null;
}

/** At the first start the past downloads are taken from the names of the files */
async function importDownloads(site) {
  let found;

  try {
    found = await listDownloads();
  } catch (error) {
    if (!(error instanceof nas.NasError)) throw error;
    console.log(`Recommendations: nas not reachable, past downloads imported later (${error.message})`);
    return;
  }

  const titles = await map(found, (item) => findTitle(site, item).catch(() => null), 6);
  const known = new Set(getPast().map((title) => title.id));
  const imported = new Map();

  found.forEach((item, index) => {
    const title = titles[index];
    if (!title || known.has(title.id)) return;

    const previous = imported.get(title.id);
    if (!previous || item.date > previous.date) {
      imported.set(title.id, {
        id: title.id,
        slug: title.slug,
        name: title.name,
        type: title.type,
        year: (title.last_air_date || '').slice(0, 4) || null,
        date: item.date,
        source: 'sc',
      });
    }
  });

  history.addMany([...imported.values()], true);
  console.log(`Recommendations: ${imported.size} past downloads imported`);
}


// [ recommendations ]
/** Titles similar to the past downloads, every download proposes its own ones */
class Recommender {
  constructor(site, formatTitle) {
    this.site = site;
    this.formatTitle = formatTitle;
    this.mutex = new Mutex();
    this.pages = new Map();     // Pages of the titles, they change rarely
    this.result = null;
    this.resultKey = null;
    this.resultTime = 0;
  }

  get() {
    return this.mutex.run(async () => {
      if (!history.load().imported) await importDownloads(this.site);

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

  async getPage(title) {
    if (!this.pages.has(title.id)) {
      try {
        this.pages.set(title.id, await this.site.request((domain, version) => Page.getTitle(title.id, title.slug, domain, version)));
      } catch {
        return null;
      }
    }

    return this.pages.get(title.id);
  }

  getPages(titles) {
    return map(titles, (title) => this.getPage(title), 6);
  }

  async compute(past) {
    const owned = new Set(past.map((title) => title.id));
    const seeds = [];
    const candidates = new Map();
    const proposals = new Map();

    // Every recent download proposes the titles the site lists with it
    const recent = [...past].sort((a, b) => b.date - a.date).slice(0, MAX_SEEDS);
    const recentPages = await this.getPages(recent);

    recent.forEach((title, index) => {
      const props = recentPages[index];
      if (!props) return;

      const [genres, keywords] = getTags(props.title);
      const seed = { ...title, genres, keywords };
      seeds.push(seed);
      const own = new Map();
      proposals.set(seed.id, own);

      for (const slider of props.sliders || []) {
        const weight = slider.name === 'related' ? 2 : 0.6;

        (slider.titles || []).forEach((item, position) => {
          if (owned.has(item.id)) return;

          candidates.set(item.id, item);
          const score = weight * (1 - position / 40) + parseFloat(item.score || 6) / 20;
          own.set(item.id, Math.max(score, own.get(item.id) || 0));
        });
      }
    });

    // Only the best proposals of every download are looked in detail
    const shortlist = [];
    for (const seed of seeds) {
      const best = [...proposals.get(seed.id).entries()].sort((a, b) => b[1] - a[1]).slice(0, SHORTLIST);
      for (const [itemId] of best) if (!shortlist.includes(itemId)) shortlist.push(itemId);
    }

    const shortPages = await this.getPages(shortlist.map((itemId) => candidates.get(itemId)));
    const details = new Map(shortlist.map((itemId, index) => [itemId, shortPages[index]]).filter(([, props]) => props));

    const ranked = new Map(seeds.map((seed) => [seed.id, [...details.entries()]
      .map(([itemId, props]) => [similarity(seed, props.title), itemId])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1])]));

    // Turns between downloads, so different tastes all have their place
    const picked = new Map();
    while (picked.size < MAX_TITLES && [...ranked.values()].some((queue) => queue.length)) {
      for (const seed of seeds) {
        const queue = ranked.get(seed.id);

        while (queue.length && picked.size < MAX_TITLES) {
          const [score, itemId] = queue.shift();

          if (score < MIN_SCORE) {
            queue.length = 0;
          } else if (!picked.has(itemId)) {
            picked.set(itemId, seed.name);
            break;
          }
        }
      }
    }

    const titles = [...picked.entries()].map(([itemId, because]) => ({
      ...this.formatTitle(details.get(itemId).title, details.get(itemId).cdn_url),
      reason: `Perché hai scaricato ${because}`,
    }));

    return { titles, based_on: past.length };
  }
}

module.exports = { Recommender, normalize, parseName };

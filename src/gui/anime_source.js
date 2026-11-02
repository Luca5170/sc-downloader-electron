// 18.09.26

const anime = require('../api/anime');
const { console } = require('../util/console');

const HOME_CACHE = 10 * 60 * 1000;
const EPISODES_GROUP = 100;     // Episodes in every tab of the gui

const TYPE_LABELS = { TV: 'Anime', Movie: 'Film', OVA: 'OVA', ONA: 'ONA', Special: 'Speciale', 'TV Short': 'Corto' };

// Genres of the site are in english
const GENRES = {
  Action: 'Azione', Adventure: 'Avventura', Comedy: 'Commedia', Drama: 'Drammatico', Horror: 'Horror',
  Mystery: 'Mistero', Romance: 'Romantico', 'Sci-Fi': 'Fantascienza', Sports: 'Sport', Supernatural: 'Soprannaturale',
  Psychological: 'Psicologico', Music: 'Musica', School: 'Scolastico', Historical: 'Storico', Military: 'Militare',
  Magic: 'Magia', 'Martial Arts': 'Arti marziali', Demons: 'Demoni', Game: 'Giochi', Space: 'Spazio', Police: 'Polizieschi',
  Parody: 'Parodia', Vampire: 'Vampiri', 'Super Power': 'Superpoteri', Kids: 'Bambini', Shounen: 'Shōnen', Shoujo: 'Shōjo',
};

// Rows of the home after the top 10 and the new episodes
const ROWS = [
  ['airing', 'In corso', { status: 'In Corso', order: 'Popolarità' }],
  ['top_rated', 'I più votati', { order: 'Valutazione' }],
  ['dubbed', 'Doppiati in italiano', { dubbed: 1, order: 'Popolarità' }],
  ['movies', 'Film', { type: 'Movie', order: 'Popolarità' }],
];


// [ format ]
/** Anime in the same shape of the titles of streamingcommunity, so the gui shows both */
function formatAnime(record, reason = null) {
  const kind = record.type || 'TV';
  const count = parseInt(record.episodes_count || 0, 10) || 0;
  const single = kind === 'Movie' || count === 1;

  const title = {
    id: parseInt(record.id, 10),

    // Related anime come without slug, the page of the anime has it
    slug: record.slug || '',
    // Dubbed copies keep the (ITA) of the name, so on the nas they are not mixed with the original
    name: anime.getTitleName(record),
    source: 'anime',
    type: single ? 'movie' : 'tv',
    label: TYPE_LABELS[kind] || kind,
    score: record.score ?? null,
    year: record.date ? String(record.date).slice(0, 4) : null,
    episodes_count: count || null,
    runtime: single ? record.episodes_length ?? null : null,
    dub: Boolean(record.dub),
    poster: record.imageurl || null,
    backdrop: record.imageurl_cover || record.cover || null,
    logo: null,
  };

  if (reason) title.reason = reason;

  return title;
}

function formatMany(records, reason = null) {
  return records.filter((record) => record.id).map((record) => formatAnime(record, reason));
}

function formatDetail(info) {
  const detail = formatAnime(info);
  const count = detail.episodes_count || 0;
  const genres = (info.genres || []).map((genre) => (typeof genre === 'string' ? genre : genre?.name));
  const credits = [['Studio', info.studio], ['Stato', info.status], ['Episodi', count ? String(count) : null]];
  const groups = [];

  if (detail.type !== 'movie') {
    for (let start = 1; start <= count; start += EPISODES_GROUP) groups.push({ start, end: Math.min(start + EPISODES_GROUP - 1, count) });
  }

  return {
    ...detail,
    plot: info.plot ?? null,
    original_name: info.title ?? null,
    genres: genres.filter(Boolean).map((genre) => GENRES[genre] || genre),
    credits: credits.filter(([, value]) => value && String(value).trim()).map(([label, value]) => ({ label, value: String(value).trim() })),

    // Long anime have hundreds of episodes, the gui shows them in groups
    groups,
    related: formatMany((info.related || []).filter((record) => record.id !== info.id)),
  };
}

function formatEpisode(episode) {
  return {
    id: parseInt(episode.id, 10),
    number: String(episode.number),
    name: `Episodio ${episode.number}`,
    plot: null,
    duration: null,
    cover: null,
  };
}


// [ source ]
/** Home, search and titles of animeunity for the gui */
class AnimeSource {
  constructor() {
    this.homeCache = null;
    this.homeTime = 0;
    this.building = null;
  }

  async home() {
    if (this.homeCache && Date.now() - this.homeTime <= HOME_CACHE) return this.homeCache;

    if (!this.building) {
      this.building = this.buildHome().then((home) => {
        this.homeCache = home;
        this.homeTime = Date.now();
        return home;
      }).finally(() => { this.building = null; });
    }

    return this.building;
  }

  async buildHome() {
    // A list that does not load leaves the others
    const result = (promise) => promise.catch((error) => {
      console.log(`Anime home: a list is not available (${error.message})`);
      return null;
    });

    const [page, popular, ...rows] = await Promise.all([
      result(anime.client.getHome()),
      result(anime.client.getArchive({ order: 'Popolarità' })),
      ...ROWS.map(([, , filters]) => result(anime.client.getArchive(filters))),
    ]);

    const homePage = page || { featured: [], latest: [] };

    // Dubbed copies of the same anime would repeat the banner
    const featured = homePage.featured.filter((record) => record.imageurl_cover && !record.dub);

    const latest = [];
    const seen = new Set();
    for (const episode of homePage.latest) {
      const record = episode.anime || {};
      if (record.id && !seen.has(record.id)) {
        seen.add(record.id);
        latest.push(...formatMany([record], `Nuovo: episodio ${episode.number}`));
      }
    }

    const sliders = [
      { name: 'top10', label: 'Top 10 anime più popolari', titles: formatMany((popular || []).slice(0, 10)) },
      { name: 'latest', label: 'Nuovi episodi', titles: latest },
      ...ROWS.map(([name, label], index) => ({ name, label, titles: formatMany(rows[index] || []) })),
    ];

    // The banners show the plot at once, without asking the page of the anime
    const hero = featured.slice(0, 8).map((record) => ({ ...formatAnime(record), plot: record.plot ?? null }));
    return { hero, sliders: sliders.filter((slider) => slider.titles.length) };
  }

  async search(text) {
    return { results: formatMany(await anime.client.search(text)) };
  }

  async title(animeId) {
    const info = await anime.client.getInfo(animeId);

    // The page of the anime has the related ones with images, without it they are shown with the initials
    try {
      const related = await anime.client.getRelated(animeId, info.slug);
      info.related = related.length ? related : info.related;
    } catch (error) {
      console.log(`Anime: images of the related anime not available (${error.message})`);
    }

    return formatDetail(info);
  }

  async episodes(animeId, start, end) {
    return { episodes: (await anime.client.getEpisodes(animeId, start, end)).map(formatEpisode) };
  }
}

module.exports = { AnimeSource, formatAnime, formatMany };

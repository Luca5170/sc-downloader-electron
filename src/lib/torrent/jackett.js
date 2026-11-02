// 20.10.26

const http = require('../../util/http');
const torrentConfig = require('./config');
const { AppError, HttpError } = require('../../util/errors');

const SEARCH_TIMEOUT = 100;     // Jackett waits every indexer, the slow ones take long
const FETCH_TIMEOUT = 60;
const MAX_REDIRECTS = 5;

// Newznab categories, the sub categories are included by jackett
const CATEGORIES = {
  all: [],
  movies: [2000],
  tv: [5000],
  anime: [5070],
};

class JackettError extends AppError {}

function getBase(config) {
  const url = config.jackett_url;
  if (!url) throw new JackettError('Indirizzo di Jackett mancante: impostalo nelle impostazioni, scheda Torrent');
  return url.replace(/\/+$/, '');
}

function getKey(config) {
  const key = torrentConfig.getJackettKey(config);
  if (!key) throw new JackettError('Chiave API di Jackett non trovata: copiala dalla dashboard di Jackett nelle impostazioni, scheda Torrent');
  return key;
}

/** A request to jackett with a message for the user when it does not answer */
async function request(config, url, options) {
  try {
    return await http.send('GET', url, options);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error.code)) {
      throw new JackettError('Jackett non ha risposto in tempo: qualche indicizzatore è lento, riprova');
    }
    if (error.name === 'RequestError') throw new JackettError(`Jackett non risponde su ${getBase(config)}: è avviato?`);
    throw new JackettError(`Jackett non ha risposto come previsto (${error.message})`);
  }
}


// [ search ]
/** Results of every indexer of jackett, with the errors of the ones that did not answer */
async function search(config, query, category = 'all') {
  const params = [['apikey', getKey(config)], ['Query', query], ...(CATEGORIES[category] || []).map((number) => ['Category[]', String(number)])];
  const response = await request(config, `${getBase(config)}/api/v2.0/indexers/all/results`, { params, timeout: SEARCH_TIMEOUT });

  if ([401, 403].includes(response.status)) throw new JackettError('Jackett ha rifiutato la chiave API: copiala di nuovo dalla sua dashboard');
  if (!response.ok) throw new JackettError(`Jackett ha risposto con errore ${response.status}`);

  let data;
  try {
    data = response.json();
  } catch {
    throw new JackettError("Jackett ha risposto con una pagina al posto dei risultati: l'indirizzo è giusto?");
  }

  const results = [];
  for (const item of data.Results || []) {
    const link = item.Link || '';
    const magnet = item.MagnetUri || '';
    if (!(link || magnet)) continue;

    results.push({
      source: 'jackett',
      title: item.Title || '',
      tracker: item.Tracker || '',
      size: item.Size || 0,
      seeders: item.Seeders || 0,
      peers: item.Peers || 0,
      date: (item.PublishDate || '').slice(0, 10),
      category: item.CategoryDesc || '',
      categories: item.Category || [],
      details: item.Details || '',
      link,
      magnet,
    });
  }

  const indexers = data.Indexers || [];
  return { results, indexers: indexers.length, failed: indexers.filter((indexer) => indexer.Error).map((indexer) => indexer.Name) };
}

/** Indexers configured in jackett, used to test the settings */
async function countIndexers(config) {
  const response = await request(config, `${getBase(config)}/api/v2.0/indexers/all/results/torznab/api`, {
    params: { t: 'indexers', configured: 'true', apikey: getKey(config) }, timeout: 20,
  });

  if ([401, 403].includes(response.status) || response.text.includes('Invalid API Key')) {
    throw new JackettError('Jackett ha rifiutato la chiave API: copiala di nuovo dalla sua dashboard');
  }
  if (!response.ok) throw new JackettError(`Jackett ha risposto con errore ${response.status}`);
  if (!response.text.includes('<indexers')) throw new JackettError('A questo indirizzo non risponde Jackett');

  return response.text.split('<indexer ').length - 1;
}


// [ torrent of a result ]
/**
 * The torrent behind a download link of jackett.
 * Return ['magnet', uri] when the indexer gives a magnet, ['file', buffer] for a .torrent
 */
async function fetch(config, link) {
  if (!link.startsWith(`${getBase(config)}/`)) throw new JackettError('Link del torrent non proveniente da Jackett');

  let url = link;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await request(config, url, { timeout: FETCH_TIMEOUT, redirect: false });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location') || '';
      if (location.startsWith('magnet:')) return ['magnet', location];

      url = new URL(location, url).href;
      continue;
    }

    if (!response.ok) throw new JackettError(`Download del torrent non riuscito: l'indicizzatore ha risposto con errore ${response.status}`);

    // A bencoded dictionary, not an error page
    if (response.content[0] !== 0x64) throw new JackettError("L'indicizzatore non ha dato un file .torrent valido");

    return ['file', response.content];
  }

  throw new JackettError('Download del torrent non riuscito: troppi reindirizzamenti');
}

module.exports = { CATEGORIES, JackettError, search, countIndexers, fetch };

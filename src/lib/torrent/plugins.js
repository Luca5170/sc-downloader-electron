// 20.10.26

// Search plugins of qbittorrent: they are python scripts, run with the python installed on the pc (qbittorrent needs it too)

const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const { execFile, spawnSync } = require('child_process');
const paths = require('../../paths');
const { AppError } = require('../../util/errors');

const SEARCH_TIMEOUT = 90;
const FETCH_TIMEOUT = 60;
const SKIPPED = new Set(['jackett']);    // Jackett is asked directly, through its plugin it would give the same results twice

// Categories of the app and of the plugins
const CATEGORIES = { all: 'all', movies: 'movies', tv: 'tv', anime: 'anime' };
const NEWZNAB = { movies: [2000], tv: [5000], anime: [5070] };

const cache = { folder: null, engines: null, python: undefined };

class PluginError extends AppError {}


// [ python ]
/** The python of the pc: the launcher py first, then python on the path (not the alias that opens the store) */
function findPython() {
  if (cache.python !== undefined) return cache.python;

  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

  cache.python = null;
  for (const [command, args] of candidates) {
    const result = spawnSync(command, [...args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.status === 0 && /Python 3/.test(`${result.stdout}${result.stderr}`)) {
      cache.python = [command, args];
      break;
    }
  }

  return cache.python;
}

function run(folder, args, timeout) {
  const python = findPython();
  if (!python) {
    return Promise.reject(new PluginError('I plugin di qBittorrent hanno bisogno di Python: installalo da python.org (lo usa anche la ricerca di qBittorrent)'));
  }

  return new Promise((resolve, reject) => {
    execFile(python[0], [...python[1], ...args], {
      cwd: folder, timeout: timeout * 1000, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new PluginError('I plugin di ricerca di qBittorrent non hanno risposto in tempo'));
      } else if (error && typeof error.code === 'string') {
        reject(new PluginError(`Plugin di ricerca di qBittorrent non avviati (${error.message})`));
      } else {
        resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), returncode: error ? error.code : 0 });
      }
    });
  });
}


// [ folder ]
/** The search engine of qbittorrent: its own folder on this pc, or a copy next to the data */
function candidateFolders(config) {
  if (config.plugins_path) return [config.plugins_path];

  const home = os.homedir();
  const folders = [
    path.join(home, '.local', 'share', 'qBittorrent', 'nova3'),
    path.join(home, 'Library', 'Application Support', 'qBittorrent', 'nova3'),
    paths.data('nova3'),
  ];

  if (process.env.LOCALAPPDATA) folders.unshift(path.join(process.env.LOCALAPPDATA, 'qBittorrent', 'nova3'));

  return folders;
}

function findFolder(config) {
  return candidateFolders(config).find((folder) => fs.existsSync(path.join(folder, 'nova2.py'))) || null;
}


// [ engines ]
/** Plugins installed in qbittorrent: name of the module, name of the site, address and categories */
async function getEngines(config) {
  const folder = findFolder(config);
  if (!folder) return [folder, {}];

  if (cache.folder === folder && cache.engines) return [folder, cache.engines];

  const result = await run(folder, ['nova2.py', '--capabilities'], 30);
  const text = result.stdout.trim();

  if (!text.startsWith('<capabilities')) {
    throw new PluginError('I plugin di ricerca di qBittorrent non si avviano: aggiornali da qBittorrent (Ricerca → Estensioni)');
  }

  const $ = cheerio.load(text, { xml: true });
  const engines = {};

  $('capabilities').children().each((_, node) => {
    const module = node.tagName;
    if (SKIPPED.has(module)) return;

    const element = $(node);
    engines[module] = {
      name: element.children('name').text() || module,
      url: element.children('url').text().replace(/\/+$/, ''),
      categories: element.children('categories').text().split(/\s+/).filter(Boolean),
    };
  });

  Object.assign(cache, { folder, engines });
  return [folder, engines];
}

/** The settings changed: the plugins are looked for again */
function forget() {
  Object.assign(cache, { folder: null, engines: null, python: undefined });
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toInt(value) {
  const number = Math.trunc(parseFloat(value));
  return Number.isFinite(number) ? number : 0;
}


// [ search ]
/** Results of every plugin of qbittorrent that knows the category, in the format of the jackett results */
async function search(config, query, category = 'all') {
  const [folder, engines] = await getEngines(config);
  if (!Object.keys(engines).length) return { results: [], engines: 0, failed: false };

  const wanted = Object.entries(engines).filter(([, engine]) => category === 'all' || engine.categories.includes(CATEGORIES[category])).map(([module]) => module);
  if (!wanted.length) return { results: [], engines: 0, failed: false };

  const result = await run(folder, ['nova2.py', wanted.join(','), CATEGORIES[category] || 'all', ...query.split(/\s+/).filter(Boolean)], SEARCH_TIMEOUT);
  const byHost = new Map(Object.entries(engines).map(([module, engine]) => [host(engine.url), [module, engine]]));
  const results = [];

  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 6) continue;

    const [link, name, size, seeds, leech, engineUrl] = parts;
    const details = parts.length > 6 ? parts[6] : '';
    const [module, engine] = byHost.get(host(engineUrl)) || [null, null];

    if (!module || !link) continue;

    const published = parts.length > 7 ? toInt(parts[7]) : -1;
    const date = published > 0 ? new Date(published * 1000).toISOString().slice(0, 10) : '';

    results.push({
      source: 'plugin',
      engine: module,
      title: name.trim(),
      tracker: engine.name,
      size: toInt(size),
      seeders: Math.max(0, toInt(seeds)),
      peers: Math.max(0, toInt(leech)),
      date,
      category: '',
      categories: NEWZNAB[category] || [],
      details: details.startsWith('http') ? details : '',
      link: link.startsWith('magnet:') ? '' : link,
      magnet: link.startsWith('magnet:') ? link : '',
    });
  }

  // A plugin that fails (site blocked, changed) does not stop the others
  return { results, engines: wanted.length, failed: result.returncode !== 0 };
}


// [ torrent of a result ]
/**
 * The torrent behind a result that is not a magnet: the plugin knows how to get it from the page of its site.
 * Return ['magnet', uri] or ['file', buffer]
 */
async function fetch(config, engine, link) {
  const [folder, engines] = await getEngines(config);
  if (!engines[engine]) throw new PluginError("Il plugin di questo risultato non c'è più in qBittorrent");
  if (!/^https?:\/\//.test(link)) throw new PluginError('Link del torrent non valido');

  const result = await run(folder, ['nova2dl.py', engine, link], FETCH_TIMEOUT);
  const output = result.stdout.trim().split(' ')[0] || '';

  if (output.startsWith('magnet:')) return ['magnet', output];

  // The plugin saved the .torrent in a temporary file
  if (output && fs.existsSync(output)) {
    let data;
    try {
      data = fs.readFileSync(output);
    } finally {
      try {
        fs.unlinkSync(output);
      } catch {
        // Left to the temporary folder of the system
      }
    }

    if (data[0] === 0x64) return ['file', data];
  }

  throw new PluginError(`${engines[engine].name} non ha dato il torrent: il sito è bloccato o è cambiato`);
}

module.exports = { PluginError, getEngines, forget, search, fetch, findPython };

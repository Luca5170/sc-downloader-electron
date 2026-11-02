// 18.09.26

const storage = require('./storage');

const HISTORY_FILE = 'history.json';

/** Titles downloaded in the past, a series is kept once */
function load() {
  // A damaged file falls back to its last good copy, the history is never lost for a power cut
  let data = storage.readJson(HISTORY_FILE, {});
  if (!storage.isObject(data)) data = {};

  // Films and series, anime are imported by themselves
  return { imported: Boolean(data.imported), imported_anime: Boolean(data.imported_anime), titles: Array.isArray(data.titles) ? data.titles : [] };
}

function save(data) {
  storage.writeJson(HISTORY_FILE, data, 4);
}

/** Titles of different sites can have the same id */
function getKey(title) {
  return `${title.source || 'sc'}:${title.id}`;
}

/** Remember a downloaded title, the most recent download wins */
function add(titleId, slug, name, kind, year = null, date = null, source = 'sc') {
  addMany([{ id: titleId, slug, name, type: kind, year, date: date || Date.now() / 1000, source }]);
}

/** Past downloads are looked for again, known titles are skipped */
function resetImported() {
  const data = load();
  data.imported = data.imported_anime = false;
  save(data);
}

function addMany(titles, imported = null, flag = 'imported') {
  const data = load();
  const newKeys = new Set(titles.map(getKey));
  data.titles = [...data.titles.filter((title) => !newKeys.has(getKey(title))), ...titles];

  if (imported !== null) data[flag] = imported;

  save(data);
}

module.exports = { load, save, add, addMany, resetImported, getKey };

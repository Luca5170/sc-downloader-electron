// 28.10.26

const storage = require('./storage');

const PROGRESS_FILE = 'progress.json';
const MIN_RESUME = 10;          // Seconds: before this the video starts again from the beginning
const MAX_ENTRIES = 300;        // The oldest positions go away, a few hundred videos are more than enough
const MAX_CONTINUE = 20;

function now() {
  return Date.now() / 1000;
}


// [ positions ]
/** Ids of the two sites can be the same number, a film has no episode */
function getKey(entry) {
  return `${entry.source || 'sc'}:${entry.id}:${entry.episode_id ?? null}`;
}

/** The end credits count as seen: the last 5%, or the last 45 seconds */
function isFinished(position, duration) {
  return duration > 0 && position > duration / 2 && (position >= duration * 0.95 || duration - position <= 45);
}

function canResume(entry) {
  return !entry.finished && (entry.position || 0) >= MIN_RESUME;
}

/** Where the films and the episodes watched in the app have been stopped */
function load() {
  const entries = storage.readJson(PROGRESS_FILE, []);
  return Array.isArray(entries) ? entries.filter((entry) => storage.isObject(entry) && Number.isInteger(entry.id)) : [];
}

function store(entries) {
  const sorted = [...entries].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, MAX_ENTRIES);
  storage.writeJson(PROGRESS_FILE, sorted, 2);
  return sorted;
}

/**
 * Remember where the video is, a video watched again comes back in the row of the home.
 * Seen to the end, the episode after it is proposed in its place.
 */
function save(entry, nextEntry = null) {
  const saved = { ...entry, updated_at: now(), dismissed: false, up_next: false };
  saved.finished = isFinished(saved.position, saved.duration);

  let entries = [...load().filter((other) => getKey(other) !== getKey(saved)), saved];
  if (saved.finished && nextEntry) entries = addNext(entries, nextEntry);

  return store(entries);
}

/** The next episode goes in the home, without losing a position already saved for it */
function addNext(entries, entry) {
  const existing = entries.find((other) => getKey(other) === getKey(entry));
  const others = entries.filter((other) => getKey(other) !== getKey(entry));

  if (existing && canResume(existing)) {
    return [...others, { ...existing, updated_at: now() + 0.001, dismissed: false }];
  }

  const fresh = { ...entry, position: 0, duration: existing?.duration || 0, finished: false, up_next: true, dismissed: false, updated_at: now() + 0.001 };
  return [...others, fresh];
}

/** Out of the row of the home, the episodes stay marked as seen */
function dismiss(source, titleId) {
  return store(load().map((entry) => ((entry.source || 'sc') === source && entry.id === titleId ? { ...entry, dismissed: true } : entry)));
}

/** For every title its last film or episode, the ones to go on with: stopped in the middle, or the next episode */
function continueList(entries, source) {
  const latest = new Map();

  for (const entry of entries) {
    if ((entry.source || 'sc') !== source) continue;

    const current = latest.get(entry.id);
    if (!current || (entry.updated_at || 0) > (current.updated_at || 0)) latest.set(entry.id, entry);
  }

  return [...latest.values()]
    .filter((entry) => !entry.dismissed && (entry.up_next || canResume(entry)))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, MAX_CONTINUE);
}

/** All the positions for the pages of the titles, and the rows of the two homes */
function view(entries = null) {
  const list = entries === null ? load() : entries;
  return { entries: list, continue: { sc: continueList(list, 'sc'), anime: continueList(list, 'anime') } };
}

module.exports = { save, dismiss, view, load, isFinished };

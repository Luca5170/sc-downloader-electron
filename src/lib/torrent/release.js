// 20.10.26

const path = require('path');

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt']);
const DANGEROUS_EXTENSIONS = new Set(['.exe', '.scr', '.bat', '.cmd', '.msi', '.lnk', '.com', '.vbs', '.js', '.ps1', '.jar', '.apk']);
const ARCHIVE_EXTENSIONS = new Set(['.rar', '.zip', '.7z']);

// Tags of a release name: label shown in the app, pattern, kind
const TAGS = [
  ['4K', /2160p|\b4k\b|\buhd\b/i, 'quality'],
  ['1080p', /1080[pi]/i, 'quality'],
  ['720p', /720p/i, 'quality'],
  ['SD', /480p|576p|\bdvdrip\b|\bxvid\b/i, 'quality'],
  ['Dolby Vision', /dolby[ ._-]?vision|\bdovi\b|\bdv\b/i, 'hdr'],
  ['HDR10+', /hdr10(?:\+|plus)/i, 'hdr'],
  ['HDR', /\bhdr(?:10)?\b/i, 'hdr'],
  ['HEVC', /\bx\.?265\b|\bh\.?265\b|\bhevc\b/i, 'codec'],
  ['AV1', /\bav1\b/i, 'codec'],
  ['H.264', /\bx\.?264\b|\bh\.?264\b|\bavc\b/i, 'codec'],
  ['Remux', /\bremux\b/i, 'source'],
  ['BluRay', /blu[ ._-]?ray|\bbd(?:rip)?\b|\bbrrip\b/i, 'source'],
  ['WEB-DL', /\bweb[ ._-]?dl\b|\bwebdl\b/i, 'source'],
  ['WEBRip', /\bweb[ ._-]?rip\b/i, 'source'],
  ['HDTV', /\bhdtv\b/i, 'source'],
  ['CAM', /\b(?:hd)?cam(?:rip)?\b|\bhdts\b|\btelesync\b|\btsrip\b/i, 'source'],
  ['Sub ITA', /\bsub(?:bed|s)?[ ._-]?ita(?:liano)?\b/i, 'subtitles'],
  ['ITA', /\bita\b|\bitalian[oa]?\b/i, 'language'],
  ['ENG', /\beng\b|\benglish\b/i, 'language'],
  ['JAP', /\bjap\b|\bjpn\b|\bjapanese\b/i, 'language'],
  ['MULTI', /\bmulti\b/i, 'language'],
];
const SUB_ITA = /\bsub(?:bed|s)?[ ._-]?ita(?:liano)?\b/gi;

const EPISODE = /\bS(\d{1,2})[ ._-]?E(\d{1,4})\b/i;
const CROSS_EPISODE = /\b(\d{1,2})x(\d{2,3})\b/i;
const SEASON = /\bS(\d{1,2})\b|\b(?:stagione|season|stagioni)[ ._-]?(\d{1,2})\b/i;
const ANIME_EPISODE = /\s-\s(\d{1,4})(?:v\d)?(?=\s|\[|\(|$)/;
const YEAR = /(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)/g;
const GROUP = /^\s*[[(【][^\])】]*[\])】]\s*/;
const COMPLETE = /\b(?:complete|completa|integrale)\b/i;


// [ files ]
function extension(name) {
  return path.extname(name || '').toLowerCase();
}

function isVideo(name) {
  return VIDEO_EXTENSIONS.has(extension(name));
}

function isSample(name, size = 0) {
  const base = path.basename((name || '').replaceAll('\\', '/')).toLowerCase();
  const folders = (name || '').toLowerCase().split('/').slice(0, -1);
  return /\bsample\b/.test(base) || folders.includes('sample') || (size > 0 && size < 30 * 1024 * 1024 && isVideo(name));
}


// [ release names ]
/** Labels of quality, codec, hdr, source and languages, at most one per kind except the languages */
function getTags(title) {
  const tags = [];
  const kinds = new Set();

  // "Sub ITA" says nothing about the language of the audio
  const audio = title.replace(SUB_ITA, ' ');

  for (const [label, pattern, kind] of TAGS) {
    if (kind !== 'language' && kinds.has(kind)) continue;
    if (pattern.test(kind === 'language' ? audio : title)) {
      tags.push({ label, kind });
      kinds.add(kind);
    }
  }

  return tags;
}

function cleanTitle(text) {
  return text.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[ \-–[\](){}]+|[ \-–[\](){}]+$/g, '');
}

/**
 * What a release name says: title, year, season and episode.
 * The kind comes from the numbers when there are, from the category of the indexer otherwise.
 */
function parse(title, categories = []) {
  const text = (title || '').replace(GROUP, '');
  const plain = text.replace(/[._]+/g, ' ');

  let season = null;
  let episode = null;
  let cut = plain.length;

  let match = EPISODE.exec(plain) || CROSS_EPISODE.exec(plain);
  if (match) {
    season = Number(match[1]);
    episode = Number(match[2]);
    cut = Math.min(cut, match.index);
  } else {
    match = SEASON.exec(plain);
    if (match) {
      season = Number(match[1] || match[2]);
      cut = Math.min(cut, match.index);
    }
  }

  const anime = GROUP.test(title || '') && episode === null ? ANIME_EPISODE.exec(plain) : null;
  if (anime) {
    episode = Number(anime[1]);
    cut = Math.min(cut, anime.index);
  }

  let year = null;
  for (const found of plain.matchAll(YEAR)) {
    // A year at the start is part of the title (2001 Odissea nello spazio)
    if (found.index === 0) continue;
    year = found[1];
    cut = Math.min(cut, found.index);
    break;
  }

  for (const [, pattern] of TAGS) {
    const tag = pattern.exec(plain);
    if (tag && tag.index > 0) cut = Math.min(cut, tag.index);
  }

  const name = cleanTitle(plain.slice(0, cut)) || cleanTitle(plain);
  const numbers = (categories || []).filter((category) => /^\d+$/.test(String(category))).map(Number);
  let kind;

  if (anime || numbers.some((category) => (category >= 5070 && category < 5080) || (category >= 100000 && category % 1000 === 70))) {
    kind = 'anime';
  } else if (season !== null || episode !== null || numbers.some((category) => category >= 5000 && category < 6000)) {
    kind = 'tv';
  } else {
    kind = 'movie';
  }

  return {
    name,
    year,
    type: kind,
    season: season !== null ? season : (['tv', 'anime'].includes(kind) ? 1 : null),
    episode,
    pack: kind !== 'movie' && episode === null,
    complete: COMPLETE.test(plain),
    tags: getTags(plain),
  };
}

/** Season and episode of a file inside a torrent, the folders can say the season */
function parseFile(name) {
  const base = path.basename(name.replaceAll('\\', '/'), path.extname(name));
  const info = parse(base);

  if (info.episode === null) {
    // "Title - 05 [1080p].mkv" of anime, "Title/Season 2/05 - Name.mkv"
    const match = ANIME_EPISODE.exec(base.replace(/[._]+/g, ' ')) || /^\s*(?:e(?:p(?:isodio|isode)?)?[ ._-]*)?(\d{1,3})(?=\D|$)/i.exec(base);
    if (match && !/^(19[2-9]\d|20[0-4]\d)$/.test(match[1])) info.episode = Number(match[1]);
  }

  const folders = name.replaceAll('\\', '/').split('/').slice(0, -1).reverse();
  for (const folder of folders) {
    const match = SEASON.exec(folder.replace(/[._]+/g, ' '));
    if (match && !EPISODE.test(base)) {
      info.season = Number(match[1] || match[2]);
      break;
    }
  }

  return info;
}

module.exports = {
  VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, DANGEROUS_EXTENSIONS, ARCHIVE_EXTENSIONS,
  extension, isVideo, isSample, getTags, parse, parseFile,
};

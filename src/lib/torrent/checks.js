// 20.10.26

const release = require('./release');

const MB = 1024 * 1024;
const FAKE = 'fake';
const SUSPECT = 'suspect';

// Least weight that makes sense, in MB: [fake under, suspect under]
const FILM_SIZES = { '4K': [1500, 4000], '1080p': [400, 900], '720p': [200, 450], SD: [100, 250], none: [100, 0] };
const EPISODE_SIZES = { '4K': [250, 700], '1080p': [60, 150], '720p': [40, 90], SD: [20, 45], none: [20, 0] };
const REMUX_SIZES = [4000, 12000];
const PACK_EPISODES = 4;                // A whole season has at least these episodes

// Least bitrate of a real encode, in Mbit/s
const MIN_BITRATE = { '4K': 3.0, '1080p': 0.9, '720p': 0.5 };
const RANK = { SD: 0, '720p': 1, '1080p': 2, '4K': 3 };
const LANGUAGES = {
  ita: 'italiano', eng: 'inglese', jpn: 'giapponese', fre: 'francese', fra: 'francese', ger: 'tedesco',
  deu: 'tedesco', spa: 'spagnolo', por: 'portoghese', rus: 'russo', kor: 'coreano', chi: 'cinese', zho: 'cinese',
};

const PROGRAM_IN_NAME = /\.(exe|scr|bat|cmd|msi|lnk|vbs|apk|jar|ps1)\b/i;
const ARCHIVE_IN_NAME = /\.(rar|zip|7z|iso)\b/i;
const BAIT_WORDS = /\b(password|passwd|keygen|crack(?:ed)?|setup|installer|codec[ ._-]?pack|activator|serial[ ._-]?key)\b/i;
const WEB_ADDRESS = /\bwww\.|https?:\/\/|\.(?:com|net|org|xyz|top|club|site|online|ru)\b/i;
const RESOLUTIONS = { '4K': /2160p|\b4k\b/i, '1080p': /1080[pi]/i, '720p': /720p/i, SD: /480p|576p/i };
const X264 = /\b[xh]\.?264\b|\bavc\b/i;
const X265 = /\b[xh]\.?265\b|\bhevc\b/i;
const FAKE_VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv)\.[a-z0-9]{2,4}$/i;
const LINK_EXTENSIONS = new Set(['.url', '.website', '.webloc']);


// [ helpers ]
/** The worst level found, with every reason and its level: the fakes first */
function verdict(reasons) {
  const sorted = [...reasons].sort((a, b) => Number(a[0] !== FAKE) - Number(b[0] !== FAKE));
  const level = sorted.some(([found]) => found === FAKE) ? FAKE : sorted.length ? SUSPECT : null;
  return { level, reasons: sorted.map(([found, text]) => ({ level: found, text })) };
}

function merge(...verdicts) {
  return verdict(verdicts.filter(Boolean).flatMap((found) => found.reasons.map((reason) => [reason.level, reason.text])));
}

function sizeLabel(size) {
  if (size >= 1024 * MB) return `${(size / 1024 / MB).toFixed(1).replace('.', ',')} GB`;
  return `${Math.round(size / MB)} MB`;
}

function qualityOf(tags) {
  return tags.find((tag) => tag.kind === 'quality')?.label || null;
}

/** A file too light for what its name promises: fake, or a quality not worth it */
function sizeReasons(size, kind, quality, remux = false, pack = false) {
  if (!size || size <= 0) return [];

  let fake;
  let suspect;
  let what;

  if (kind === 'movie') {
    [fake, suspect] = remux ? REMUX_SIZES : FILM_SIZES[quality] || FILM_SIZES.none;
    what = `un film${quality ? ` ${quality}` : ''}`;
  } else {
    [fake, suspect] = EPISODE_SIZES[quality] || EPISODE_SIZES.none;
    what = `un episodio${quality ? ` ${quality}` : ''}`;

    if (pack) {
      fake *= PACK_EPISODES;
      suspect *= PACK_EPISODES;
      what = `una stagione intera${quality ? ` ${quality}` : ''}`;
    }
  }

  if (size < fake * MB) return [[FAKE, `Pesa ${sizeLabel(size)}: troppo poco per ${what}`]];
  if (size < suspect * MB) return [[SUSPECT, `Pesa ${sizeLabel(size)}: poco per ${what}, qualità probabilmente bassa`]];
  return [];
}


// [ result of a search ]
/** Signs of a fake or of junk, from the name and the weight only */
function checkResult(title, size, guess) {
  const reasons = [];
  const tags = guess.tags;

  const program = PROGRAM_IN_NAME.exec(title);
  if (program) reasons.push([FAKE, `Nel nome c'è un programma (.${program[1].toLowerCase()}): non è un video`]);

  const archive = ARCHIVE_IN_NAME.exec(title);
  if (archive) reasons.push([FAKE, `Nel nome c'è un archivio (.${archive[1].toLowerCase()}): spesso chiede una password o nasconde un programma`]);

  const bait = BAIT_WORDS.exec(title);
  if (bait) reasons.push([FAKE, `Parola tipica dei falsi nel nome: «${bait[1]}»`]);

  if (guess.year && Number(guess.year) > new Date().getFullYear() + 1) reasons.push([FAKE, `Anno nel futuro (${guess.year})`]);

  const found = Object.entries(RESOLUTIONS).filter(([, pattern]) => pattern.test(title)).map(([label]) => label);
  if (found.length > 1) reasons.push([SUSPECT, `Il nome elenca più risoluzioni insieme (${found.join(', ')}): tipico dei falsi`]);

  if (X264.test(title) && X265.test(title)) reasons.push([SUSPECT, 'Il nome dice due codec diversi (x264 e x265)']);

  if (!program && WEB_ADDRESS.test(title)) reasons.push([SUSPECT, "Nel nome c'è un indirizzo web: spesso pubblicità o falsi"]);

  if (tags.some((tag) => tag.label === 'CAM')) reasons.push([SUSPECT, 'Registrato al cinema con una videocamera: qualità pessima']);

  reasons.push(...sizeReasons(size, guess.type, qualityOf(tags), tags.some((tag) => tag.label === 'Remux'), guess.pack));
  return verdict(reasons);
}


// [ files of a torrent ]
function getVideos(files) {
  return files.filter((file) => release.isVideo(file.name) && !release.isSample(file.name, file.size));
}

function isProgram(file) {
  return release.DANGEROUS_EXTENSIONS.has(release.extension(file.name));
}

/** Why a torrent is only junk (no real video), null when it has something to watch */
function getJunk(files) {
  if (getVideos(files).length) return null;

  const programs = files.filter(isProgram);
  if (programs.length) return `dentro c'è solo un programma (${programs[0].name.split('/').pop()}), nessun video`;
  if (files.some((file) => release.ARCHIVE_EXTENSIONS.has(release.extension(file.name)))) {
    return 'il video è chiuso in un archivio, che di solito chiede una password o nasconde un programma';
  }
  return "dentro non c'è nessun video";
}

/** Files downloaded when nobody chose: the videos and their subtitles, never programs or samples */
function defaultFiles(files) {
  const videos = getVideos(files);
  if (!videos.length) return files.filter((file) => !isProgram(file)).map((file) => file.index);

  const subtitles = files.filter((file) => release.SUBTITLE_EXTENSIONS.has(release.extension(file.name)));
  return [...videos, ...subtitles].map((file) => file.index);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Signs of a fake from the list of files: programs, archives, links, a video too light */
function checkFiles(files, guess) {
  const reasons = [];

  for (const file of files) {
    if (!isProgram(file)) continue;

    const name = file.name.split('/').pop();
    if (FAKE_VIDEO.test(name)) reasons.push([FAKE, `«${name}» finge di essere un video ma è un programma: non aprirlo`]);
    else reasons.push([FAKE, `Contiene un programma (${name}): non aprirlo, non lo scarico`]);
  }

  if (files.some((file) => file.name.toLowerCase().includes('password'))) {
    reasons.push([FAKE, "C'è un file che parla di password: il video è protetto, quasi sempre un falso"]);
  }

  if (files.some((file) => LINK_EXTENSIONS.has(release.extension(file.name)))) reasons.push([SUSPECT, 'Contiene collegamenti a siti web (pubblicità)']);

  const junk = getJunk(files);
  if (junk) {
    reasons.push([FAKE, junk[0].toUpperCase() + junk.slice(1)]);
    return verdict(reasons);
  }

  const videos = getVideos(files);
  const quality = qualityOf(guess.tags);
  const remux = guess.tags.some((tag) => tag.label === 'Remux');

  if (guess.type === 'movie') {
    reasons.push(...sizeReasons(Math.max(...videos.map((file) => file.size)), 'movie', quality, remux));
  } else {
    // Each episode on its own, the typical one of the pack
    reasons.push(...sizeReasons(median(videos.map((file) => file.size)), 'tv', quality));
  }

  return verdict(reasons);
}


// [ tracks read by ffprobe ]
function actualQuality(video) {
  const width = video.width || 0;
  const height = video.height || 0;

  if (width >= 3200 || height >= 1700) return '4K';
  if (width >= 1700 || height >= 900) return '1080p';
  if (width >= 1200 || height >= 650) return '720p';
  return 'SD';
}

/** What the name promises against what the video really is */
function checkProbe(data, guess, size) {
  const reasons = [];
  const video = data.video;

  if (!video || !video.width) return verdict([[FAKE, 'Il file non contiene un video vero']]);

  const claimed = qualityOf(guess.tags);
  const actual = actualQuality(video);
  if (claimed in RANK && RANK[actual] < RANK[claimed]) {
    reasons.push([FAKE, `Il nome dice ${claimed} ma il video è ${actual} (${video.width}×${video.height})`]);
  }

  if (guess.tags.some((tag) => tag.label === 'ITA')) {
    const audio = data.audio || [];
    const languages = new Set(audio.map((track) => (track.language || '').toLowerCase()).filter((language) => language && language !== 'und'));
    const titles = audio.map((track) => (track.title || '').toLowerCase()).join(' ');

    if (!audio.length) {
      reasons.push([FAKE, 'Il nome dice ITA ma il video non ha audio']);
    } else if (languages.size && !languages.has('ita') && !titles.includes('ital') && !/\bita\b/.test(titles)) {
      const names = [...languages].map((language) => LANGUAGES[language] || language).sort().join(', ');
      reasons.push([FAKE, `Il nome dice ITA ma nessuna traccia audio è in italiano (ci sono: ${names})`]);
    } else if (!languages.size && !titles.includes('ital')) {
      reasons.push([SUSPECT, "Le tracce audio non dicono la lingua: non posso verificare che ci sia l'italiano"]);
    }
  }

  const duration = data.duration || 0;
  if (duration) {
    const minutes = Math.round(duration / 60);

    if (guess.type === 'movie' && duration < 40 * 60) reasons.push([SUSPECT, `Dura solo ${minutes} min: forse è un trailer o un pezzo del film`]);
    else if (guess.type !== 'movie' && duration < 5 * 60) reasons.push([SUSPECT, `Dura solo ${minutes} min: troppo poco per un episodio`]);

    const bitrate = size ? (size * 8) / duration / 1e6 : 0;
    if (bitrate && actual in MIN_BITRATE && bitrate < MIN_BITRATE[actual]) {
      reasons.push([SUSPECT, `Bitrate molto basso (${bitrate.toFixed(1).replace('.', ',')} Mbit/s per un ${actual}): immagine probabilmente impastata`]);
    }
  }

  return verdict(reasons);
}

module.exports = { verdict, merge, checkResult, getVideos, isProgram, getJunk, defaultFiles, checkFiles, checkProbe };

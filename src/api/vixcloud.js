// 15.09.26

const cheerio = require('cheerio');
const http = require('../util/http');
const m3u8 = require('../lib/m3u8');
const { getHeaders } = require('../util/headers');
const { console } = require('../util/console');
const { AppError, DownloadError, describeResponse, getHost } = require('../util/errors');

const LANGUAGE_NAMES = {
  ita: 'Italiano', eng: 'Inglese', jpn: 'Giapponese', fra: 'Francese', fre: 'Francese', deu: 'Tedesco', ger: 'Tedesco', spa: 'Spagnolo',
};
const VTT_HEADER = /^WEBVTT[^\n]*\n(?:[^\n]+\n)*\n?/;


// [ player page ]
/** Script of the vixcloud player with the parameters of the video */
async function getPlayerScript(urlEmbed) {
  const response = await http.get(urlEmbed, { headers: { 'user-agent': getHeaders() } });

  if (!response.ok) throw new DownloadError(describeResponse(response, 'Il player'));

  const $ = cheerio.load(response.text);
  const script = $('body script').first();

  if (!script.length) {
    throw new DownloadError(`Il player ${getHost(urlEmbed)} ha risposto con una pagina senza video, forse è cambiato`);
  }

  return script.text();
}

/** Address of the player inside the iframe page of the site */
function getIframeSrc(html) {
  return cheerio.load(html)('iframe').first().attr('src') || null;
}


// [ playlist ]
function parseContent(embedContent) {
  // Parse parameter of window.masterPlaylist from req embed content
  const text = String(embedContent);
  const index = text.indexOf('window.masterPlaylist');
  const masterPlaylist = index >= 0 ? text.slice(index + 'window.masterPlaylist'.length) : text;
  const token = /['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/.exec(masterPlaylist);
  const expires = /['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/.exec(masterPlaylist);
  const url = /['"]?url['"]?\s*:\s*['"]([^'"]+)['"]/.exec(masterPlaylist);

  if (!(token && expires && url)) {
    throw new DownloadError('Il player non contiene i dati del video: il video non è disponibile o il player è cambiato');
  }

  return {
    token: token[1],
    expires: expires[1],
    url: url[1],
    canPlayFHD: /window\.canPlayFHD\s*=\s*true/.test(text),
  };
}

function getPlaylist(params) {
  // Add token and expires to master playlist url
  const address = new URL(params.url);
  address.searchParams.set('token', params.token);
  address.searchParams.set('expires', params.expires);

  if (params.canPlayFHD) address.searchParams.set('h', '1');

  return address.href;
}

async function getMasterPlaylist(playlistUrl) {
  const response = await http.get(playlistUrl, { headers: { 'user-agent': getHeaders() } });

  if (!response.ok) throw new DownloadError(describeResponse(response, 'Il player'));

  return m3u8.parse(response.text, response.url);
}

function getBest(master) {
  return master.playlists.reduce((best, playlist) => ((playlist.bandwidth || 0) > (best.bandwidth || 0) ? playlist : best));
}

function getM3u8Url(master) {
  if (!master.playlists.length) throw new DownloadError('La playlist del player non contiene nessuna qualità video');

  // Select video playlist with best quality
  const best = getBest(master);
  console.log(`Quality select => ${best.resolution ? `${best.resolution[1]}p` : 'unknown'}`);

  return best.uri;
}

function getAudioTrack(master) {
  // Select italian audio if present, otherwise first audio track
  const tracks = master.media.filter((media) => media.type === 'AUDIO' && media.uri);
  return tracks.find((track) => track.language === 'ita') || tracks[0] || null;
}

function getM3u8Audio(master) {
  return getAudioTrack(master)?.uri || null;
}


// [ subtitles ]
/** Subtitle tracks of the player, the one to show by itself comes first and is the default */
function getSubtitleTracks(master) {
  const tracks = [];

  for (const media of master.media) {
    if (media.type !== 'SUBTITLES' || !media.uri || media.language === 'auto') continue;

    // The player writes the tracks with the foreign lines of a dubbed film like ita-forced
    const language = (media.language || 'und').toLowerCase();
    const code = language.split(/[-_]/)[0];
    const forced = media.forced || `${language} ${media.name}`.toLowerCase().includes('forced');
    const name = LANGUAGE_NAMES[code] || media.name || code;

    tracks.push({ url: media.uri, language: code, forced, default: false, title: forced ? `${name} (forzati)` : name });
  }

  const audio = getAudioTrack(master);
  const italian = tracks.filter((track) => track.language === 'ita');

  // Who listens in italian needs only the foreign lines, a foreign audio needs all the subtitles there are
  const wanted = !audio || audio.language === 'ita'
    ? italian.filter((track) => track.forced)
    : [...italian.filter((track) => !track.forced), ...italian, ...tracks];

  if (wanted.length) wanted[0].default = true;

  return tracks.sort((first, second) => Number(second.default) - Number(first.default));
}

function decodeText(content) {
  // The server does not say the charset of the subtitles, the accents must stay right
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return new TextDecoder('windows-1252').decode(content);
  }
}

async function getSubtitlePart(url) {
  const response = await http.get(url, { headers: { 'user-agent': getHeaders() } });

  if (!response.ok) throw new DownloadError(describeResponse(response, 'Il server dei sottotitoli'));

  return { text: decodeText(response.content), url: response.url };
}

/** Text of a subtitle track in webvtt: its playlist points to one file, or to many pieces of it */
async function readSubtitle(url) {
  const page = await getSubtitlePart(url);
  const parts = [];

  for (const segment of m3u8.parse(page.text, page.url).segments) {
    parts.push((await getSubtitlePart(segment.uri)).text.replaceAll('\r\n', '\n').trimStart());
  }

  if (!parts.length || !parts.every((part) => part.startsWith('WEBVTT'))) {
    throw new DownloadError('La traccia dei sottotitoli non è in formato WebVTT');
  }

  // Only the header of the whole file stays
  const body = parts.map((part) => part.replace(VTT_HEADER, '').trim()).join('\n\n');

  if (!body.includes('-->')) throw new DownloadError('La traccia dei sottotitoli è vuota');

  return `WEBVTT\n\n${body}\n`;
}

/** Subtitles to put inside the file, they are an extra: the video is downloaded also when they fail */
async function getSubtitles(master) {
  const found = [];

  for (const track of getSubtitleTracks(master)) {
    try {
      found.push({ ...track, text: await readSubtitle(track.url) });
      console.log(`Download subtitle: ${track.title}`);
    } catch (error) {
      console.log(`Subtitle ${track.title} not downloaded: ${error.message}`);
    }
  }

  // With no default track the players would show the first one: every line of a dubbed film subtitled
  if (!found.some((track) => track.default)) {
    console.print('Subtitles => no track to show by itself');
    return [];
  }

  return found;
}

async function getM3u8Key(m3u8Url) {
  const response = await http.get(new URL('/storage/enc.key', m3u8Url).href, { headers: { 'user-agent': getHeaders() } });

  if (!response.ok) throw new DownloadError(describeResponse(response, 'Il server della chiave del video'));
  if (response.content.length !== 16) {
    throw new DownloadError(`Chiave del video non valida (${response.content.length} byte invece di 16), il player potrebbe essere cambiato`);
  }

  return response.content.toString('hex');
}

/** Video with the best quality, audio and key of a player, used by the streaming of the app */
async function getStream(embedContent) {
  const master = await getMasterPlaylist(getPlaylist(parseContent(embedContent)));

  if (!master.playlists.length) throw new AppError('Video non disponibile');

  const best = getBest(master);
  const audio = getAudioTrack(master);

  return {
    video: best.uri,
    audio: audio?.uri || null,
    key: await getM3u8Key(best.uri),
    resolution: best.resolution,
    bandwidth: best.bandwidth,
    codecs: best.codecs,
    language: audio?.language || null,
    subtitles: getSubtitleTracks(master),
  };
}

/** Everything needed to download a player: video, audio and key */
async function readPlayer(embedContent) {
  const master = await getMasterPlaylist(getPlaylist(parseContent(embedContent)));
  const videoUrl = getM3u8Url(master);

  return { master, videoUrl, audioUrl: getM3u8Audio(master), key: await getM3u8Key(videoUrl) };
}

module.exports = {
  getPlayerScript, getIframeSrc, parseContent, getPlaylist, getMasterPlaylist, getM3u8Url, getM3u8Audio, getM3u8Key,
  getSubtitleTracks, readSubtitle, getSubtitles, getStream, readPlayer,
};

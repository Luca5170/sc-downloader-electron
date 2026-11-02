// 3.12.23 -> 10.12.23

const http = require('../util/http');
const { getHeaders } = require('../util/headers');
const { console } = require('../util/console');
const { DownloadError, describeResponse, step } = require('../util/errors');
const { downloadM3u8 } = require('../lib/downloader');
const { finalize } = require('../lib/nas');
const paths = require('../paths');
const { getBaseUrl, getPageProps } = require('./page');
const vixcloud = require('./vixcloud');

async function getToken(idTv, domain) {
  const session = new http.Session();
  const response = await http.get(`${getBaseUrl(domain)}/watch/${idTv}`, { session, headers: { 'user-agent': getHeaders() } });

  const token = session.cookies.get('XSRF-TOKEN');
  if (!token && !response.ok) throw new DownloadError(describeResponse(response, 'Il sito'), ![404, 410].includes(response.status));
  if (!token) throw new DownloadError("Il sito non ha dato il permesso di guardare l'episodio (manca il token della sessione), riprova");

  return token;
}

function getSeason(tvId, tvName, domain, version, season, token = null) {
  const headers = { referer: `${getBaseUrl(domain)}/titles/${tvId}-${tvName}` };
  if (token) headers['x-xsrf-token'] = token;

  return getPageProps(`${getBaseUrl(domain)}/titles/${tvId}-${tvName}/season-${season}`, version, null, headers);
}

async function getIframe(tvId, episodeId, domain, token) {
  const response = await http.get(`${getBaseUrl(domain)}/iframe/${tvId}`, {
    params: { episode_id: episodeId, next_episode: '1' },
    cookies: { 'XSRF-TOKEN': token },
    headers: { referer: `${getBaseUrl(domain)}/watch/${tvId}?e=${episodeId}`, 'user-agent': getHeaders() },
  });

  if (!response.ok) {
    // A title that is not on the site is not there also at the next attempt
    throw new DownloadError(describeResponse(response, 'Il sito'), ![404, 410].includes(response.status));
  }

  const src = vixcloud.getIframeSrc(response.text);
  if (!src) throw new DownloadError("La pagina dell'episodio non contiene il player: l'episodio non è disponibile sul sito", false);

  return vixcloud.getPlayerScript(src);
}

async function dwSingleEp(tvId, eps, index, domain, token, tvName, season, progressCallback = null, media = null) {
  const episode = eps[index];
  console.print(`Download ep: ${episode.n} => ${episode.name}`);

  const named = media ? { ...media, season, episode_number: episode.n, episode_name: episode.name } : null;
  const embedContent = await step("Ricerca dell'episodio sul sito", () => getIframe(tvId, episode.id, domain, token));
  const player = await step('Lettura del player', () => vixcloud.readPlayer(embedContent));

  const mp4Name = `${tvName.replaceAll('+', '_')}_S${String(season).padStart(2, '0')}E${String(index + 1).padStart(2, '0')}`;
  const mp4Path = paths.videos(tvName, `${mp4Name}.mp4`);

  if (player.audioUrl) console.print('Use m3u8 audio => True');

  await downloadM3u8({
    m3u8Index: player.videoUrl, m3u8Audio: player.audioUrl, subtitles: await vixcloud.getSubtitles(player.master), key: player.key, outputFilename: mp4Path, progressCallback,
  });

  // Rename the file and move it to the nas if it is enabled
  return step('Salvataggio del file', () => finalize(mp4Path, named, progressCallback));
}

module.exports = { getToken, getSeason, getIframe, dwSingleEp };

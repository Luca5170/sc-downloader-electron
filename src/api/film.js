// 3.12.23 -> 10.12.23

const http = require('../util/http');
const { getHeaders } = require('../util/headers');
const { console } = require('../util/console');
const { DownloadError, describeResponse, step } = require('../util/errors');
const { downloadM3u8 } = require('../lib/downloader');
const { finalize } = require('../lib/nas');
const paths = require('../paths');
const { getBaseUrl } = require('./page');
const vixcloud = require('./vixcloud');

async function getIframe(idTitle, domain) {
  const response = await http.get(`${getBaseUrl(domain)}/iframe/${idTitle}`, { headers: { 'user-agent': getHeaders() } });

  if (!response.ok) {
    // A title that is not on the site is not there also at the next attempt
    throw new DownloadError(describeResponse(response, 'Il sito'), ![404, 410].includes(response.status));
  }

  const src = vixcloud.getIframeSrc(response.text);
  if (!src) throw new DownloadError('La pagina del film non contiene il player: il video non è disponibile sul sito', false);

  return vixcloud.getPlayerScript(src);
}

async function mainDwFilm(idFilm, titleName, domain, progressCallback = null, media = null) {
  const embedContent = await step('Ricerca del film sul sito', () => getIframe(idFilm, domain));
  const player = await step('Lettura del player', () => vixcloud.readPlayer(embedContent));

  const mp4Name = titleName.replaceAll('+', ' ').replaceAll(',', '');
  const mp4Path = paths.videos(`${mp4Name}.mp4`);

  if (player.audioUrl) console.print('Use m3u8 audio => True');

  await downloadM3u8({
    m3u8Index: player.videoUrl, m3u8Audio: player.audioUrl, subtitles: await vixcloud.getSubtitles(player.master), key: player.key, outputFilename: mp4Path, progressCallback,
  });

  // Rename the file and move it to the nas if it is enabled
  return step('Salvataggio del file', () => finalize(mp4Path, media, progressCallback));
}

module.exports = { getIframe, mainDwFilm };

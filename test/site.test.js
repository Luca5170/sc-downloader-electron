// 28.10.26

// The parts of streamingcommunity that can be checked without the site: the page of the site, the player, the errors

const assert = require('assert');
const path = require('path');
const { test } = require('node:test');
const paths = require('../src/paths');

paths.init({ data: path.join(__dirname, 'tmp', 'site'), videos: path.join(__dirname, 'tmp', 'site', 'videos') });

const cheerio = require('cheerio');
const Page = require('../src/api/page');
const vixcloud = require('../src/api/vixcloud');
const m3u8 = require('../src/lib/m3u8');
const nas = require('../src/lib/nas');
const { formatTitle } = require('../src/gui/server');
const { describe, describeResponse, RequestError, DownloadError, step } = require('../src/util/errors');

const PLAYER = `
  window.video = {"id":1};
  window.masterPlaylist = {
    params: { 'token': 'abc123', 'expires': '1793196900', 'asn': '' },
    url: 'https://vixcloud.co/playlist/12345?b=1',
  }
  window.canPlayFHD = true
`;

test('indirizzo del sito da quello che scrive l\'utente', () => {
  assert.strictEqual(Page.getHost('photos'), 'streamingcommunityz.photos');
  assert.strictEqual(Page.getHost('https://www.streamingcommunityz.shiksha/it/titles/1-x'), 'streamingcommunityz.shiksha');
  assert.strictEqual(Page.getHost('nuovonome.org'), 'nuovonome.org');
  assert.strictEqual(Page.getBaseUrl('photos'), 'https://streamingcommunityz.photos/it');
});

test('versione inertia nella pagina del sito', () => {
  const html = `<div id="app" data-page="{&quot;component&quot;:&quot;Home&quot;,&quot;version&quot;:&quot;f3a9&quot;}"></div>`;
  assert.strictEqual(JSON.parse(cheerio.load(html)('div#app').attr('data-page')).version, 'f3a9');
});

test('dati del video nello script del player', () => {
  const params = vixcloud.parseContent(PLAYER);
  assert.deepStrictEqual(params, { token: 'abc123', expires: '1793196900', url: 'https://vixcloud.co/playlist/12345?b=1', canPlayFHD: true });

  const playlist = new URL(vixcloud.getPlaylist(params));
  assert.strictEqual(playlist.searchParams.get('token'), 'abc123');
  assert.strictEqual(playlist.searchParams.get('h'), '1');
  assert.strictEqual(playlist.searchParams.get('b'), '1');

  assert.throws(() => vixcloud.parseContent('<html></html>'), DownloadError);
});

test('qualità migliore e audio italiano della playlist principale', () => {
  const master = m3u8.parse([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="eng",URI="audio/eng/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Italian",LANGUAGE="ita",DEFAULT=YES,URI="audio/ita/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="eng",URI="sub/eng.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720,AUDIO="a"',
    'video/720p/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="a"',
    'video/1080p/index.m3u8',
  ].join('\n'), 'https://vixcloud.co/playlist/12345?token=x');

  assert.strictEqual(vixcloud.getM3u8Url(master), 'https://vixcloud.co/playlist/video/1080p/index.m3u8');
  assert.strictEqual(vixcloud.getM3u8Audio(master), 'https://vixcloud.co/playlist/audio/ita/index.m3u8');
  assert.deepStrictEqual(master.playlists[1].resolution, [1920, 1080]);
  assert.strictEqual(master.playlists[1].codecs, 'avc1.640028,mp4a.40.2');
});

/** Playlist of the player with an audio and some subtitle tracks: [language, name, FORCED] */
function playerWith(audio, ...subtitles) {
  return m3u8.parse([
    '#EXTM3U',
    ...(audio ? [`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",LANGUAGE="${audio}",URI="audio.m3u8"`] : []),
    ...subtitles.map(([language, name, forced = 'NO']) => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="${name}",FORCED=${forced},LANGUAGE="${language}",URI="sub/${language}.m3u8"`),
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
    'video.m3u8',
  ].join('\n'), 'https://vixcloud.co/playlist/1');
}

const summary = (master) => vixcloud.getSubtitleTracks(master).map((track) => [track.title, track.language, track.default, track.forced]);

test('con l\'audio italiano si vedono da soli i forzati, le altre tracce restano da scegliere', () => {
  const master = playerWith('ita', ['eng', 'English'], ['ita-forced', 'Forced'], ['ita', 'Italian'], ['auto', 'Auto']);

  assert.deepStrictEqual(summary(master), [
    ['Italiano (forzati)', 'ita', true, true],
    ['Inglese', 'eng', false, false],
    ['Italiano', 'ita', false, false],
  ]);
  assert.strictEqual(vixcloud.getSubtitleTracks(master)[0].url, 'https://vixcloud.co/playlist/sub/ita-forced.m3u8');
});

test('i forzati si riconoscono anche solo dall\'attributo FORCED o dal nome', () => {
  assert.deepStrictEqual(summary(playerWith('ita', ['ita', 'Italian', 'YES'])), [['Italiano (forzati)', 'ita', true, true]]);
  assert.deepStrictEqual(summary(playerWith('ita', ['ita', 'Italian Forced'])), [['Italiano (forzati)', 'ita', true, true]]);
});

test('doppiato senza forzati: nessuna traccia si vede da sola', () => {
  const tracks = vixcloud.getSubtitleTracks(playerWith('ita', ['ita', 'Italian'], ['eng', 'English']));
  assert.deepStrictEqual(tracks.map((track) => track.default), [false, false]);
});

test('con l\'audio straniero si vede tutto l\'italiano, o quello che c\'è', () => {
  assert.deepStrictEqual(summary(playerWith('eng', ['ita-forced', 'Forced'], ['ita', 'Italian'])), [
    ['Italiano', 'ita', true, false],
    ['Italiano (forzati)', 'ita', false, true],
  ]);
  assert.deepStrictEqual(summary(playerWith('eng', ['ita-forced', 'Forced']))[0], ['Italiano (forzati)', 'ita', true, true]);
  assert.deepStrictEqual(summary(playerWith('eng', ['eng', 'English']))[0], ['Inglese', 'eng', true, false]);
});

test('titolo del sito nel formato della pagina', () => {
  const title = formatTitle({
    id: 7, slug: 'x-men', name: 'X-Men', type: 'movie', score: '7.1', release_date: '2011-06-01', sub_ita: 0,
    images: [{ type: 'cover_mobile', filename: 'c.webp' }, { type: 'poster', filename: 'p.webp' }, { type: 'background', filename: 'b.webp' }],
  }, 'https://cdn.example');

  assert.strictEqual(title.poster, 'https://cdn.example/images/p.webp');
  assert.strictEqual(title.backdrop, 'https://cdn.example/images/b.webp');
  assert.strictEqual(title.year, '2011');
  assert.strictEqual(title.logo, null);
});

test('nomi dei file e cartelle del NAS come nella versione python', () => {
  const config = { film_path: '/volume1/Film', tv_path: '/volume1/Serie TV', anime_path: '' };

  assert.strictEqual(nas.getRemotePath(config, { name: "X-Men: L'inizio", year: '2011', type: 'movie' }),
    "/volume1/Film/X-Men L'inizio (2011)/X-Men L'inizio (2011).mp4");
  assert.strictEqual(nas.getRemotePath(config, { name: 'Breaking Bad', year: '2008', type: 'tv', season: 1, episode_number: 3, episode_name: 'Conseguenze radicali' }),
    '/volume1/Serie TV/Breaking Bad (2008)/Stagione 01/Breaking Bad - S01E03 - Conseguenze radicali.mp4');
  assert.strictEqual(nas.getRemotePath(config, { name: 'One Piece', year: '1999', type: 'anime', single: false, episode_number: '6.5' }),
    '/volume1/Serie TV/One Piece (1999)/Stagione 01/One Piece - S01E6.5.mp4');
});

test('errori spiegati in italiano', async () => {
  const blocked = new RequestError('getaddrinfo ENOTFOUND', { code: 'ENOTFOUND', url: 'https://streamingcommunityz.photos/' });
  assert.match(describe(blocked), /Il dominio streamingcommunityz\.photos non esiste/);

  const response = { status: 503, url: 'https://vixcloud.co/x', history: ['https://old.example/x'] };
  assert.strictEqual(describeResponse(response, 'Il player'),
    'Il player vixcloud.co ha risposto con errore 503: sito sovraccarico o in manutenzione (la richiesta è stata spostata su vixcloud.co)');

  const failure = await step('Lettura del player', async () => { throw new DownloadError('Il player non risponde'); }).catch((error) => error);
  assert.strictEqual(describe(failure), 'Lettura del player: il player non risponde');
});

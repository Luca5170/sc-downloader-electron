// 28.10.26

// A local copy of a vixcloud video: encrypted hls with video and audio apart, served by a small server.
// The downloader must give a mp4 with both tracks, stop when cancelled, and go on from the saved segments.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, before, after } = require('node:test');

const ROOT = path.join(__dirname, 'tmp', 'download');
const SITE = path.join(ROOT, 'site');
const paths = require('../src/paths');

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
paths.init({ data: path.join(ROOT, 'data'), videos: path.join(ROOT, 'videos') });

const ffmpeg = require('../src/lib/ffmpeg');
const m3u8 = require('../src/lib/m3u8');
const vixcloud = require('../src/api/vixcloud');
const videos = require('../src/util/videos');
const { downloadM3u8, M3U8Downloader } = require('../src/lib/downloader');
const { Stream } = require('../src/gui/player');
const { DownloadCancelled } = require('../src/util/cancel');
const { AppError } = require('../src/util/errors');

const KEY = crypto.randomBytes(16);
const requests = [];
let server;
let base;
let delay = 0;

function makeHls(kind, input) {
  const folder = path.join(SITE, kind);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(SITE, 'enc.key'), KEY);
  fs.writeFileSync(path.join(folder, 'keyinfo'), `${base}/storage/enc.key\n${path.join(SITE, 'enc.key')}\n${crypto.randomBytes(16).toString('hex')}\n`);

  execFileSync(ffmpeg.find('ffmpeg'), [
    '-loglevel', 'error', ...input, '-t', '12',
    ...(kind === 'video' ? ['-c:v', 'libx264', '-g', '24', '-pix_fmt', 'yuv420p'] : ['-c:a', 'aac']),
    '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_key_info_file', path.join(folder, 'keyinfo'),
    '-hls_segment_filename', path.join(folder, 'seg%03d.ts'), path.join(folder, 'index.m3u8'),
  ]);
}

before(async () => {
  server = http.createServer((request, response) => {
    requests.push(request.url);
    const file = request.url === '/storage/enc.key' ? path.join(SITE, 'enc.key') : path.join(SITE, request.url.split('?')[0]);

    setTimeout(() => {
      if (!fs.existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      const data = fs.readFileSync(file);
      response.writeHead(200, { 'Content-Length': data.length }).end(data);
    }, request.url.endsWith('.ts') ? delay : 0);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  makeHls('video', ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24']);
  makeHls('audio', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']);
});

after(() => server.close());

function probe(file) {
  return JSON.parse(execFileSync(ffmpeg.find('ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]).toString());
}

test('scarica video e audio cifrati e li unisce in un mp4', async () => {
  const output = paths.videos('Film di prova.mp4');
  const stages = new Set();

  await downloadM3u8({
    m3u8Index: `${base}/video/index.m3u8`,
    m3u8Audio: `${base}/audio/index.m3u8`,
    key: KEY.toString('hex'),
    outputFilename: output,
    progressCallback: (stage) => stages.add(stage),
  });

  const info = probe(output);
  const kinds = info.streams.map((stream) => stream.codec_type).sort();
  assert.deepStrictEqual(kinds, ['audio', 'video']);
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 1, `durata ${info.format.duration}`);
  assert.deepStrictEqual([...stages], ['video', 'join_video', 'audio', 'join_audio', 'merge']);
  assert.ok(!fs.existsSync(paths.tmp('output')) || !fs.readdirSync(paths.tmp('output')).length, 'file temporanei rimasti');
});

test('annullato si ferma e non lascia segmenti', async () => {
  delay = 150;
  let calls = 0;
  const output = paths.videos('Annullato.mp4');

  await assert.rejects(downloadM3u8({
    m3u8Index: `${base}/video/index.m3u8`,
    key: KEY.toString('hex'),
    outputFilename: output,
    progressCallback: (stage, done) => {
      calls++;
      if (stage === 'video' && done >= 3) throw new DownloadCancelled();
    },
  }), DownloadCancelled);

  delay = 0;
  assert.ok(calls > 0);
  assert.ok(!fs.existsSync(output));
  const folders = fs.readdirSync(paths.tmp('segments')).filter((name) => fs.readdirSync(paths.tmp('segments', name)).some((file) => file.endsWith('.ts')));
  assert.deepStrictEqual(folders, [], 'segmenti rimasti dopo l\'annullamento');
});

test('chiudendo il programma i segmenti restano e il download riprende da lì', async () => {
  delay = 100;
  const output = paths.videos('Ripreso.mp4');

  await assert.rejects(downloadM3u8({
    m3u8Index: `${base}/video/index.m3u8`,
    key: KEY.toString('hex'),
    outputFilename: output,
    progressCallback: (stage, done) => {
      if (stage === 'video' && done >= 5) throw new DownloadCancelled(true);
    },
  }), DownloadCancelled);

  delay = 0;
  requests.length = 0;

  await downloadM3u8({ m3u8Index: `${base}/video/index.m3u8`, key: KEY.toString('hex'), outputFilename: output });

  const segments = requests.filter((url) => url.endsWith('.ts')).length;
  assert.ok(segments < 12, `riscaricati ${segments} segmenti su 12`);
  assert.ok(Math.abs(Number(probe(output).format.duration) - 12) < 1);
});

test('lo streaming dell\'app dà i segmenti già decifrati', async () => {
  const stream = await new Stream({
    video: `${base}/video/index.m3u8`, audio: `${base}/audio/index.m3u8`, key: KEY.toString('hex'),
    resolution: [640, 360], bandwidth: 800000, codecs: 'avc1.64001e,mp4a.40.2', language: 'ita',
  }).open();

  assert.ok(Math.abs(stream.duration - 12) < 1);
  assert.match(stream.master(), /AUDIO="audio"/);
  assert.match(stream.playlist('video'), /video\/0\.ts/);

  const segment = await stream.segment('video', 0);
  assert.strictEqual(segment[0], 0x47, 'il segmento non è un transport stream');
  assert.strictEqual(segment.length % 188, 0);
});

// [ subtitles ]
const FORCED_TEXT = 'PERCHÉ è così difficile, città';

/** A subtitle track on the server: its playlist and its files, the pieces can be text or bytes */
function makeTrack(name, ...pieces) {
  const folder = path.join(SITE, 'sub', name);
  fs.mkdirSync(folder, { recursive: true });

  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:12'];
  pieces.forEach((piece, index) => {
    fs.writeFileSync(path.join(folder, `part${index}.vtt`), piece);
    lines.push('#EXTINF:12,', `part${index}.vtt?token=x`);
  });
  lines.push('#EXT-X-ENDLIST');

  fs.writeFileSync(path.join(folder, 'index.m3u8'), lines.join('\n'));
}

function makeTracks() {
  makeTrack('forced', `WEBVTT\n\n00:02.000 --> 00:06.000\n${FORCED_TEXT}\n`);
  makeTrack('full', 'WEBVTT\n\n00:01.000 --> 00:03.000\nSottotitolo completo\n');
  makeTrack('eng', 'WEBVTT\n\n00:01.000 --> 00:03.000\nFull english line\n');
  makeTrack('html', '<html><body>Errore</body></html>');
  makeTrack('empty', 'WEBVTT\n\n');
}

/** The master playlist of the player, the audio is in italian */
function masterWith(...tracks) {
  return m3u8.parse([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Italian",LANGUAGE="ita",URI="audio/index.m3u8"',
    ...tracks.map(([language, name]) => `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="${language}",LANGUAGE="${language}",URI="sub/${name}/index.m3u8"`),
    '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
    'video/index.m3u8',
  ].join('\n'), `${base}/master.m3u8`);
}

async function download(name, subtitles, progressCallback = null) {
  const output = paths.videos(`${name}.mp4`);
  await downloadM3u8({ m3u8Index: `${base}/video/index.m3u8`, m3u8Audio: `${base}/audio/index.m3u8`, subtitles, key: KEY.toString('hex'), outputFilename: output, progressCallback });
  return output;
}

function subtitleStreams(file) {
  return probe(file).streams.filter((stream) => stream.codec_type === 'subtitle').map((stream) => ({
    codec: stream.codec_name,
    name: stream.tags?.handler_name,
    language: stream.tags?.language,
    default: stream.disposition.default,
    forced: stream.disposition.forced,
  }));
}

function subtitleText(file, track = 0) {
  return execFileSync(ffmpeg.find('ffmpeg'), ['-loglevel', 'error', '-i', file, '-map', `0:s:${track}`, '-f', 'srt', '-']).toString('utf8');
}

test('i sottotitoli finiscono dentro il file, si vedono da soli solo i forzati', async () => {
  makeTracks();
  const output = await download('Doppiato', await vixcloud.getSubtitles(masterWith(['eng', 'eng'], ['ita-forced', 'forced'], ['ita', 'full'], ['auto', 'eng'])));

  assert.deepStrictEqual(subtitleStreams(output), [
    { codec: 'mov_text', name: 'Italiano (forzati)', language: 'ita', default: 1, forced: 1 },
    { codec: 'mov_text', name: 'Inglese', language: 'eng', default: 0, forced: 0 },
    { codec: 'mov_text', name: 'Italiano', language: 'ita', default: 0, forced: 0 },
  ]);
  assert.deepStrictEqual(probe(output).streams.slice(0, 2).map((stream) => stream.codec_type), ['video', 'audio']);
  assert.match(subtitleText(output), new RegExp(`00:00:02,000 --> 00:00:06,000\\s+${FORCED_TEXT}`));
  assert.ok(!fs.existsSync(paths.videos('subtitle')), 'la vecchia cartella condivisa non serve più');
});

test('doppiato senza forzati: nessuna traccia, il player mostrerebbe tutte le battute', async () => {
  makeTracks();
  const subtitles = await vixcloud.getSubtitles(masterWith(['ita', 'full'], ['eng', 'eng']));

  assert.deepStrictEqual(subtitles, []);
  assert.deepStrictEqual(subtitleStreams(await download('Senza forzati', subtitles)), []);
});

test('una traccia rotta viene saltata, se è quella dei forzati non resta nulla da mostrare per sbaglio', async () => {
  makeTracks();
  const extras = await vixcloud.getSubtitles(masterWith(['ita-forced', 'forced'], ['eng', 'missing'], ['spa', 'html'], ['deu', 'empty']));
  assert.deepStrictEqual(extras.map((track) => track.title), ['Italiano (forzati)']);

  assert.deepStrictEqual(await vixcloud.getSubtitles(masterWith(['ita-forced', 'missing'], ['ita', 'full'])), []);
});

test('testo dei sottotitoli: accenti giusti senza charset, a pezzi, in cp1252', async () => {
  makeTrack('utf8bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\n${FORCED_TEXT}\r\n`)]));
  assert.strictEqual(await vixcloud.readSubtitle(`${base}/sub/utf8bom/index.m3u8`), `WEBVTT\n\n00:01.000 --> 00:02.000\n${FORCED_TEXT}\n`);

  makeTrack('cp1252', Buffer.from('WEBVTT\n\n00:01.000 --> 00:02.000\nperch\xE8 cos\xEC\n', 'latin1'));
  assert.match(await vixcloud.readSubtitle(`${base}/sub/cp1252/index.m3u8`), /perchè così/);

  const map = 'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000';
  makeTrack('pieces', `WEBVTT\n${map}\n\n00:01.000 --> 00:02.000\nPezzo uno\n`, `WEBVTT\n${map}\n\n00:05.000 --> 00:06.000\nPezzo due\n`);
  assert.strictEqual(await vixcloud.readSubtitle(`${base}/sub/pieces/index.m3u8`),
    'WEBVTT\n\n00:01.000 --> 00:02.000\nPezzo uno\n\n00:05.000 --> 00:06.000\nPezzo due\n');
});

test('se ffmpeg rifiuta i sottotitoli il video resta, senza di loro', async () => {
  const run = ffmpeg.run;
  ffmpeg.run = (args, check) => (args.includes('mov_text') ? Promise.reject(new ffmpeg.FfmpegError('ffmpeg exit 1')) : run(args, check));

  try {
    const output = await download('Sottotitoli rifiutati', [{ language: 'ita', title: 'Forzati', default: true, forced: true, text: 'WEBVTT\n' }]);
    assert.deepStrictEqual(probe(output).streams.map((stream) => stream.codec_type), ['video', 'audio']);
  } finally {
    ffmpeg.run = run;
  }
});

test('lo streaming dell\'app dà il testo delle tracce, solo quando viene chiesto', async () => {
  makeTracks();
  requests.length = 0;

  const stream = new Stream({ subtitles: vixcloud.getSubtitleTracks(masterWith(['ita-forced', 'forced'])) });
  assert.strictEqual(requests.length, 0);

  assert.match(await stream.subtitle(0), new RegExp(FORCED_TEXT));
  const asked = requests.length;
  await stream.subtitle(0);
  assert.strictEqual(requests.length, asked, 'la traccia già letta non si chiede di nuovo');
  assert.strictEqual(await stream.subtitle(5), null);
});

// [ folder of the videos ]
test('la cartella dei video si cambia, si controlla e resta salvata', () => {
  const chosen = path.join(ROOT, 'scelta', 'film');

  assert.strictEqual(videos.savePath(`  "${chosen}"  `), chosen);
  assert.strictEqual(paths.videos('x.mp4'), path.join(chosen, 'x.mp4'));
  assert.ok(fs.statSync(chosen).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(chosen), [], 'il file di prova non deve restare');

  // A new start of the program finds it
  paths.setVideos(null);
  videos.load();
  assert.strictEqual(paths.videos(), chosen);

  assert.throws(() => videos.savePath('Film'), AppError, 'un percorso relativo finirebbe chissà dove');
  assert.throws(() => videos.savePath(process.platform === 'win32' ? 'Z:\\non\\esiste' : '/proc/no'));
  const file = path.join(ROOT, 'un-file.txt');
  fs.writeFileSync(file, '');
  assert.throws(() => videos.savePath(file));
  assert.strictEqual(videos.loadPath(), chosen, 'una cartella rifiutata non cambia quella salvata');

  assert.strictEqual(videos.savePath(''), '');
  assert.strictEqual(paths.videos(), paths.defaultVideos());
});

test('cambiare cartella non fa perdere i segmenti dei download da riprendere', () => {
  const first = new M3U8Downloader('u', null, null, paths.videos('serie', 'x.mp4')).name;
  videos.savePath(path.join(ROOT, 'altra'));
  const second = new M3U8Downloader('u', null, null, paths.videos('serie', 'x.mp4')).name;
  videos.savePath('');

  assert.strictEqual(first, second);
});

/** Windows refuses to rename a file to another disk: the same answer for the final file */
function withOtherDisk(output, action) {
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === output && !source.endsWith('.parte')) throw Object.assign(new Error('other disk'), { code: 'EXDEV' });
    return rename(source, target);
  };
  return action().finally(() => { fs.renameSync = rename; });
}

test('su un altro disco il video viene copiato e segnala l\'avanzamento', async () => {
  const output = paths.videos('Altro disco.mp4');
  const saving = [];

  await withOtherDisk(output, () => download('Altro disco', null, (stage, done, total) => {
    if (stage === 'save') saving.push([done, total]);
  }));

  assert.ok(saving.length > 0, 'la copia non è stata segnalata');
  assert.strictEqual(saving.at(-1)[0], saving.at(-1)[1]);
  assert.strictEqual(saving.at(-1)[1], fs.statSync(output).size);
  assert.deepStrictEqual(probe(output).streams.map((stream) => stream.codec_type), ['video', 'audio']);
  assert.ok(!fs.existsSync(`${output}.parte`), 'mezzo file rimasto');
});

test('annullato durante la copia su un altro disco non lascia mezzi file', async () => {
  const output = paths.videos('Copia annullata.mp4');

  await assert.rejects(withOtherDisk(output, () => download('Copia annullata', null, (stage) => {
    if (stage === 'save') throw new DownloadCancelled();
  })), DownloadCancelled);

  assert.ok(!fs.existsSync(output));
  assert.ok(!fs.existsSync(`${output}.parte`), 'mezzo file rimasto');
});

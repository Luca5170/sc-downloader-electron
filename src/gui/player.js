// 28.10.26

const crypto = require('crypto');
const http = require('../util/http');
const m3u8 = require('../lib/m3u8');
const { readSubtitle } = require('../api/vixcloud');
const { getHeaders } = require('../util/headers');
const { AppError, sleep } = require('../util/errors');

const MAX_STREAMS = 4;          // Older streams are forgotten, a stream is useful only while it is watched
const ATTEMPTS = 4;

class SegmentError extends Error {}


/**
 * A film or an episode watched in the app. Playlists and segments pass from here:
 * the browser gets them already decrypted, without the key and the headers of the site.
 */
class Stream {
  constructor(stream) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.session = new http.Session({ 'user-agent': getHeaders() });
    this.key = stream.key ? Buffer.from(stream.key, 'hex') : null;
    this.resolution = stream.resolution;
    this.bandwidth = stream.bandwidth;
    this.codecs = stream.codecs;
    this.language = stream.language;
    this.subtitles = stream.subtitles || [];
    this.subtitleTexts = new Map();
    this.source = stream;
    this.tracks = {};
    this.duration = 0;
  }

  async open() {
    this.tracks.video = await this.load(this.source.video);
    if (this.source.audio) this.tracks.audio = await this.load(this.source.audio);

    this.duration = this.tracks.video.segments.reduce((total, segment) => total + (segment.duration || 0), 0);
    return this;
  }

  async load(url) {
    const response = (await http.get(url, { session: this.session, retries: 0 })).raiseForStatus();
    const playlist = m3u8.parse(response.text, response.url);

    if (!playlist.segments.length) throw new AppError('La playlist del video è vuota');

    return playlist;
  }

  // [ playlists ]
  /** One quality, the same of the download, with its audio when it is separated from the video */
  master() {
    const info = [`BANDWIDTH=${this.bandwidth || 1000000}`];
    if (this.resolution) info.push(`RESOLUTION=${this.resolution[0]}x${this.resolution[1]}`);
    if (this.codecs) info.push(`CODECS="${this.codecs}"`);

    const lines = ['#EXTM3U'];
    if (this.tracks.audio) {
      const language = this.language || 'und';
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${language}",LANGUAGE="${language}",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"`);
      info.push('AUDIO="audio"');
    }

    lines.push(`#EXT-X-STREAM-INF:${info.join(',')}`, 'video.m3u8');
    return `${lines.join('\n')}\n`;
  }

  /** Playlist of the video or of the audio, its segments point here and have no key */
  playlist(kind) {
    const playlist = this.tracks[kind];
    if (!playlist) return null;

    const target = Math.ceil(Math.max(...playlist.segments.map((segment) => segment.duration || 0)));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];

    playlist.segments.forEach((segment, index) => {
      if (segment.discontinuity && index) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXTINF:${segment.duration || 0},`, `${kind}/${index}.ts`);
    });

    lines.push('#EXT-X-ENDLIST');
    return `${lines.join('\n')}\n`;
  }

  // [ segments ]
  async segment(kind, index) {
    const playlist = this.tracks[kind];
    if (!playlist || index < 0 || index >= playlist.segments.length) return null;

    const segment = playlist.segments[index];
    let data = await this.fetch(segment.uri);

    if (this.key && segment.key && segment.key.method === 'AES-128') {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, m3u8.getIv(playlist, index));
      decipher.setAutoPadding(false);
      data = m3u8.unpad(Buffer.concat([decipher.update(data), decipher.final()]));
    }

    return data;
  }

  async fetch(url) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        const response = await http.send('GET', url, { session: this.session, timeout: 20 });
        if (response.status === 200) return response.content;
      } catch {
        // Tried again
      }
      await sleep((1 + attempt) * 1000);
    }

    throw new SegmentError('Segmento del video non disponibile');
  }

  // [ subtitles ]
  /** Text of a subtitle track, read from the site only when the player asks for it */
  async subtitle(index) {
    if (index < 0 || index >= this.subtitles.length) return null;

    if (!this.subtitleTexts.has(index)) this.subtitleTexts.set(index, await readSubtitle(this.subtitles[index].url));

    return this.subtitleTexts.get(index);
  }
}


/** The streams opened by the app, by their id */
class Streams {
  constructor() {
    this.items = new Map();
  }

  async open(source) {
    const stream = await new Stream(source).open();

    this.items.set(stream.id, stream);
    while (this.items.size > MAX_STREAMS) this.items.delete(this.items.keys().next().value);

    return stream;
  }

  get(streamId) {
    const stream = this.items.get(streamId) || null;

    // The stream watched now is the last one forgotten
    if (stream) {
      this.items.delete(streamId);
      this.items.set(streamId, stream);
    }

    return stream;
  }
}

module.exports = { Streams, Stream, SegmentError };

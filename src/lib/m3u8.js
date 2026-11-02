// 28.10.26

// Reader of the m3u8 playlists, in place of the m3u8 library of the python version

/** Attributes of a tag: BANDWIDTH=1,CODECS="a,b" becomes { BANDWIDTH: '1', CODECS: 'a,b' } */
function parseAttributes(text) {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }

  return attributes;
}

function resolve(uri, base) {
  if (!uri || !base) return uri || null;

  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/**
 * Qualities, audio and subtitle tracks of a master playlist, segments and keys of a media playlist.
 * The addresses are made absolute with the address of the playlist when it is given.
 */
function parse(text, baseUrl = null) {
  const playlist = { playlists: [], media: [], segments: [], keys: [], mediaSequence: 0, targetDuration: null };
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim());
  let streamInfo = null;
  let duration = null;
  let discontinuity = false;
  let key = null;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributes(line.slice(18));
      const resolution = /^(\d+)x(\d+)$/i.exec(attributes.RESOLUTION || '');

      streamInfo = {
        bandwidth: attributes.BANDWIDTH ? Number(attributes.BANDWIDTH) : null,
        resolution: resolution ? [Number(resolution[1]), Number(resolution[2])] : null,
        codecs: attributes.CODECS || null,
        audio: attributes.AUDIO || null,
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributes(line.slice(13));

      playlist.media.push({
        type: attributes.TYPE || null,
        groupId: attributes['GROUP-ID'] || null,
        name: attributes.NAME || null,
        language: attributes.LANGUAGE || null,
        default: attributes.DEFAULT === 'YES',
        forced: attributes.FORCED === 'YES',
        uri: resolve(attributes.URI, baseUrl),
      });
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attributes = parseAttributes(line.slice(11));

      key = attributes.METHOD && attributes.METHOD !== 'NONE'
        ? { method: attributes.METHOD, uri: resolve(attributes.URI, baseUrl), iv: attributes.IV || null }
        : null;
      if (key) playlist.keys.push(key);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      playlist.mediaSequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      playlist.targetDuration = Number(line.slice(22)) || null;
    } else if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuity = true;
    } else if (!line.startsWith('#')) {
      if (streamInfo) {
        playlist.playlists.push({ ...streamInfo, uri: resolve(line, baseUrl) });
        streamInfo = null;
      } else {
        playlist.segments.push({ uri: resolve(line, baseUrl), duration, key, discontinuity });
        duration = null;
        discontinuity = false;
      }
    }
  }

  return playlist;
}

/** Iv of a segment: the one of its key, or the number of the segment when the key has none */
function getIv(playlist, index) {
  const iv = playlist.segments[index]?.key?.iv;
  if (iv) return Buffer.from(iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');

  const buffer = Buffer.alloc(16);
  buffer.writeBigUInt64BE(BigInt((playlist.mediaSequence || 0) + index), 8);
  return buffer;
}

/** Padding added by the encryption, the player would read it as broken video */
function unpad(data) {
  const size = data.length ? data[data.length - 1] : 0;
  if (size >= 1 && size <= 16 && data.length >= size && data.subarray(data.length - size).every((byte) => byte === size)) {
    return data.subarray(0, data.length - size);
  }
  return data;
}

module.exports = { parse, parseAttributes, getIv, unpad };

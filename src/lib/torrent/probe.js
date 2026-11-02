// 20.10.26

const { execFile } = require('child_process');
const ffmpeg = require('../ffmpeg');

const TIMEOUT = 30;
const HDR_TRANSFERS = { smpte2084: 'HDR10', 'arib-std-b67': 'HLG' };
const CODECS = {
  hevc: 'HEVC', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2',
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS',
  flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM',
  subrip: 'SRT', ass: 'ASS', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', mov_text: 'Testo',
};

class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeError';
  }
}

function isAvailable() {
  return ffmpeg.isAvailable('ffprobe');
}

/** Streams of a video read by ffprobe, also from a file downloaded only in part */
function run(file) {
  const binary = ffmpeg.find('ffprobe');
  if (!binary) return Promise.reject(new ProbeError('ffprobe non trovato: reinstalla il programma'));

  return new Promise((resolve, reject) => {
    execFile(binary, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { timeout: TIMEOUT * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new ProbeError('ffprobe non ha finito in tempo'));
          return;
        }

        let data = {};
        try {
          data = JSON.parse(stdout || '{}');
        } catch {
          data = {};
        }

        if (!data.streams?.length) {
          const lines = String(stderr || '').trim().split(/\r?\n/).filter(Boolean);
          reject(new ProbeError(lines.length ? lines[lines.length - 1] : 'Nessuna traccia leggibile'));
          return;
        }

        resolve(data);
      });
  });
}

function codecName(stream) {
  const name = stream.codec_name || '';
  const profile = stream.profile || '';

  // DTS-HD MA and DTS:X are profiles of dts
  if (name === 'dts' && profile && profile !== 'DTS') return profile;
  return CODECS[name] || name.toUpperCase() || null;
}

function channelsLabel(stream) {
  const channels = stream.channels;
  const layout = stream.channel_layout || '';

  if (!channels) return null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (layout.includes('7.1') || channels === 8) return '7.1';
  if (layout.includes('5.1') || channels === 6) return '5.1';
  return `${channels} canali`;
}

function getHdr(stream) {
  const side = (stream.side_data_list || []).map((item) => item.side_data_type || '');

  if (side.some((item) => item.includes('DOVI') || item.includes('Dolby Vision'))) return 'Dolby Vision';
  if (side.some((item) => item.includes('HDR10+') || item.includes('HDR Dynamic Metadata'))) return 'HDR10+';
  return HDR_TRANSFERS[stream.color_transfer] || null;
}

function getFps(stream) {
  const [numerator, denominator] = (stream.avg_frame_rate || '0/0').split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function lowerTags(stream) {
  return Object.fromEntries(Object.entries(stream.tags || {}).map(([key, value]) => [key.toLowerCase(), value]));
}

/** Scheda tecnica: video, audio and subtitles of a file */
function describe(data) {
  const streams = data.streams || [];
  const format = data.format || {};
  const videos = streams.filter((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const video = videos.reduce((best, stream) => (!best || (stream.width || 0) * (stream.height || 0) > (best.width || 0) * (best.height || 0) ? stream : best), null);
  const duration = parseFloat(format.duration || 0) || null;
  const bits = String(video?.bits_per_raw_sample ?? '');

  return {
    container: (format.format_long_name || '').split(' / ')[0] || null,
    duration,
    video: video ? {
      codec: codecName(video),
      width: video.width ?? null,
      height: video.height ?? null,
      hdr: getHdr(video),
      bit_depth: /^\d+$/.test(bits) ? Number(bits) : ((video.pix_fmt || '').includes('10') ? 10 : null),
      fps: getFps(video),
    } : null,
    audio: streams.filter((stream) => stream.codec_type === 'audio').map((stream) => ({
      language: lowerTags(stream).language || null,
      title: lowerTags(stream).title || null,
      codec: codecName(stream),
      channels: channelsLabel(stream),
      default: Boolean(stream.disposition?.default),
    })),
    subtitles: streams.filter((stream) => stream.codec_type === 'subtitle').map((stream) => ({
      language: lowerTags(stream).language || null,
      title: lowerTags(stream).title || null,
      codec: codecName(stream),
      forced: Boolean(stream.disposition?.forced),
    })),
  };
}

module.exports = { ProbeError, isAvailable, run, describe };

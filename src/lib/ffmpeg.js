// 28.10.26

// FFmpeg and ffprobe come with the program, the ones installed on the pc are used only if they are missing

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DownloadError, sleep } = require('../util/errors');

const found = {};

/** Inside the packaged app the binaries are outside the asar archive */
function unpacked(file) {
  return file ? file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : file;
}

function bundled(name) {
  try {
    if (name === 'ffmpeg') return unpacked(require('ffmpeg-static'));
    return unpacked(require('@ffprobe-installer/ffprobe').path);
  } catch {
    return null;
  }
}

function onPath(name) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true });
  const first = (result.stdout || '').split(/\r?\n/).find(Boolean);
  return result.status === 0 && first ? first.trim() : null;
}

/** Path of ffmpeg or ffprobe, null when there is none */
function find(name) {
  if (!(name in found)) {
    const own = bundled(name);
    found[name] = own && fs.existsSync(own) ? own : onPath(name);
  }
  return found[name];
}

function isAvailable(name = 'ffmpeg') {
  return Boolean(find(name));
}

class FfmpegError extends Error {
  constructor(message, stderr = '') {
    super(message);
    this.name = 'FfmpegError';
    this.stderr = stderr;
  }
}

/** Run ffmpeg and wait for it, ffmpeg is stopped if the download is cancelled meanwhile */
async function run(args, check = null) {
  const binary = find('ffmpeg');
  if (!binary) throw new DownloadError('FFmpeg non trovato: reinstalla il programma', false);

  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let exit = null;

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const finished = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, error }));
    child.on('close', (code) => resolve({ code }));
  });
  finished.then((result) => { exit = result; });

  try {
    while (exit === null) {
      if (check) check();
      await Promise.race([finished, sleep(300)]);
    }
  } catch (error) {
    child.kill();
    await finished;
    throw error;
  }

  if (exit.error) throw new DownloadError(`FFmpeg non si avvia (${exit.error.message})`, false);
  if (exit.code !== 0) throw new FfmpegError(`ffmpeg exit ${exit.code}`, stderr.trim());
}

module.exports = { find, isAvailable, run, FfmpegError };

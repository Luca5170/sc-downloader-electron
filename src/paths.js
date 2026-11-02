// 28.10.26

// Where the program keeps its files: settings and state, the videos, the segments of the downloads to resume

const fs = require('fs');
const os = require('os');
const path = require('path');

const folders = {
  data: path.join(os.homedir(), 'SC Downloader'),
  videos: path.join(os.homedir(), 'Videos', 'SC Downloader'),
  chosenVideos: null,     // The one chosen in the settings
};

function init({ data, videos }) {
  if (data) folders.data = data;
  if (videos) folders.videos = videos;
  fs.mkdirSync(folders.data, { recursive: true });
}

function data(...parts) {
  return path.join(folders.data, ...parts);
}

function videos(...parts) {
  return path.join(folders.chosenVideos || folders.videos, ...parts);
}

function setVideos(folder) {
  folders.chosenVideos = folder || null;
}

function defaultVideos() {
  return folders.videos;
}

/** Path of a video as it would be in the default folder, it stays the same after changing the folder */
function stableVideoPath(file) {
  const relative = path.relative(videos(), file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : path.join(folders.videos, relative);
}

function tmp(...parts) {
  return path.join(folders.data, 'tmp', ...parts);
}

module.exports = { init, data, videos, setVideos, defaultVideos, stableVideoPath, tmp };

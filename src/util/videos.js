// 01.11.26

// Folder of the videos chosen in the settings

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../paths');
const storage = require('./storage');
const { AppError } = require('./errors');

const CONFIG_FILE = 'videos.json';


/** Folder written in the settings, empty when it is the default one */
function loadPath() {
  const saved = storage.readJson(CONFIG_FILE, {});
  return storage.isObject(saved) && typeof saved.path === 'string' ? saved.path : '';
}

/** At the start of the program the saved folder becomes the one of the videos */
function load() {
  paths.setVideos(loadPath());
}

function expand(text) {
  return text.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole).replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Save the folder after checking that it can be written, an empty one goes back to the default */
function savePath(value) {
  // The copy of a path from the explorer has the quotes
  let folder = expand(String(value ?? '').trim().replace(/^"|"$/g, '').trim());

  if (folder) {
    // The folder the program is started from changes with its shortcut, a relative path would end up anywhere
    if (!path.isAbsolute(folder)) throw new AppError('Scrivi il percorso completo, per esempio E:\\Film');

    folder = path.resolve(folder);
    fs.mkdirSync(folder, { recursive: true });

    const testFile = path.join(folder, `.sc-downloader-${process.pid}.tmp`);
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
  }

  storage.writeJson(CONFIG_FILE, { path: folder }, 4);
  paths.setVideos(folder);
  return folder;
}

module.exports = { loadPath, load, savePath };

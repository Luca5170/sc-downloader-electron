// 20.10.26

const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../../util/storage');
const credentials = require('../../util/credentials');
const paths = require('../../paths');

const IN_DOCKER = fs.existsSync('/.dockerenv');
const CONFIG_FILE = 'torrent.json';
const KEYRING_SERVICE = 'SC Downloader qBittorrent';
const PASSWORD_FILE = 'torrent_password';       // Used where the system cant encrypt, only readable by the program
const DEFAULT_CONFIG = {
  jackett_url: IN_DOCKER ? 'http://host.docker.internal:9117' : 'http://127.0.0.1:9117',
  jackett_key: '',              // Empty: read from the jackett plugin of qbittorrent
  qbit_url: '',                 // Empty: torrents are opened with qbittorrent like a double click
  qbit_user: '',
  save_path: '',                // Empty: the folder chosen in qbittorrent
  after_upload: 'remove',       // 'remove' the torrent and its files once on the nas, or 'keep' sharing them
  path_from: '',                // Folder of the downloads as qbittorrent sees it...
  path_to: '',                  // ...and as this program sees it (docker)
  plugins: 'on',                // Search also with the search plugins of qbittorrent
  plugins_path: '',             // Empty: the nova3 folder of qbittorrent on this pc
};
const AFTER_UPLOAD = ['remove', 'keep'];


// [ config ]
function loadConfig() {
  const saved = storage.readJson(CONFIG_FILE, {});
  const config = { ...DEFAULT_CONFIG, ...(storage.isObject(saved) ? saved : {}) };

  if (!AFTER_UPLOAD.includes(config.after_upload)) config.after_upload = DEFAULT_CONFIG.after_upload;
  if (!['on', 'off'].includes(config.plugins)) config.plugins = DEFAULT_CONFIG.plugins;

  return config;
}

function saveConfig(config) {
  const clean = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, String(config[key] ?? value ?? '').trim()]));

  for (const key of ['jackett_url', 'qbit_url']) clean[key] = clean[key].replace(/\/+$/, '');
  if (!AFTER_UPLOAD.includes(clean.after_upload)) clean.after_upload = DEFAULT_CONFIG.after_upload;
  if (!['on', 'off'].includes(clean.plugins)) clean.plugins = DEFAULT_CONFIG.plugins;

  storage.writeJson(CONFIG_FILE, clean, 4);
  return clean;
}


// [ jackett key ]
/** The jackett plugin of the qbittorrent search keeps the key in its folder */
function pluginKeyPaths() {
  const home = os.homedir();
  const list = [
    path.join(home, '.local', 'share', 'qBittorrent', 'nova3', 'engines', 'jackett.json'),
    path.join(home, 'Library', 'Application Support', 'qBittorrent', 'nova3', 'engines', 'jackett.json'),
    paths.data('nova3', 'engines', 'jackett.json'),
  ];

  if (process.env.LOCALAPPDATA) list.unshift(path.join(process.env.LOCALAPPDATA, 'qBittorrent', 'nova3', 'engines', 'jackett.json'));

  return list;
}

function findPluginKey() {
  for (const file of pluginKeyPaths()) {
    try {
      const key = JSON.parse(fs.readFileSync(file, 'utf8')).api_key || '';
      if (key && key !== 'YOUR_API_KEY_HERE') return key;
    } catch {
      continue;
    }
  }

  return '';
}

function getJackettKey(config) {
  return config.jackett_key || findPluginKey();
}


// [ qbittorrent password ]
function getAccount(config) {
  return `${config.qbit_user}@${config.qbit_url}`;
}

/** Password of the web ui, saved by the program */
function getPassword(config) {
  if (!config.qbit_url || !config.qbit_user) return null;
  return credentials.get(KEYRING_SERVICE, getAccount(config), PASSWORD_FILE);
}

function savePassword(config, password) {
  return credentials.set(KEYRING_SERVICE, getAccount(config), password, PASSWORD_FILE);
}


// [ paths ]
/** A path given by qbittorrent, as this program sees it (in docker the two can differ) */
function toLocalPath(config, value) {
  if (!value) return value;

  const source = config.path_from;
  const target = config.path_to;
  const normalized = value.replaceAll('\\', '/');

  if (source && target) {
    const prefix = source.replaceAll('\\', '/').replace(/\/+$/, '');

    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      const rest = normalized.slice(prefix.length).replace(/^\/+/, '');
      return rest ? path.join(target, ...rest.split('/')) : target;
    }
  }

  return path.normalize(value);
}

module.exports = { IN_DOCKER, loadConfig, saveConfig, findPluginKey, getJackettKey, getPassword, savePassword, toLocalPath };

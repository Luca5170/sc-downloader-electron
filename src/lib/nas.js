// 16.09.26

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Client } = require('ssh2');
const storage = require('../util/storage');
const credentials = require('../util/credentials');
const { console } = require('../util/console');
const { DownloadCancelled } = require('../util/cancel');

const CONFIG_FILE = 'nas.json';
const KNOWN_HOSTS_FILE = 'nas_known_hosts.json';
const KEYRING_SERVICE = 'SC Downloader NAS';
const PASSWORD_ENV = 'SC_NAS_PASSWORD';         // Optional, it wins over the password of the settings
const PASSWORD_FILE = 'nas_password';           // Used where the system cant encrypt, only readable by the program
const DEFAULT_CONFIG = {
  enabled: false,
  host: '',
  port: 22,
  user: '',
  film_path: '',
  tv_path: '',
  anime_path: '',
};

// Characters not allowed in a file name
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;


class NasError extends Error {
  constructor(message, localPath = null) {
    super(message);
    this.name = 'NasError';
    this.localPath = localPath;
  }
}


// [ config ]
/** Read nas settings, password is not saved here */
function loadConfig() {
  const saved = storage.readJson(CONFIG_FILE, {});
  const config = { ...DEFAULT_CONFIG, ...(storage.isObject(saved) ? saved : {}) };
  const port = parseInt(config.port || 22, 10);
  config.port = Number.isNaN(port) ? 22 : port;
  return config;
}

function saveConfig(config) {
  const clean = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, value]) => [key, config[key] ?? value]));
  clean.port = parseInt(clean.port || 22, 10) || 22;

  storage.writeJson(CONFIG_FILE, clean, 4);
  return clean;
}

function isEnabled(config = null) {
  const current = config || loadConfig();
  return Boolean(current.enabled && current.host && current.user && current.film_path);
}

function getAccount(config) {
  return `${config.user}@${config.host}`;
}

/** Password from the environment or the one saved by the program */
function getPassword(config) {
  if (process.env[PASSWORD_ENV]) return process.env[PASSWORD_ENV];
  if (!config.host || !config.user) return null;

  return credentials.get(KEYRING_SERVICE, getAccount(config), PASSWORD_FILE);
}

function savePassword(config, password) {
  return credentials.set(KEYRING_SERVICE, getAccount(config), password, PASSWORD_FILE);
}


// [ name of the files ]
/** Remove from a name the characters not allowed in a file name */
function cleanName(text) {
  const name = String(text ?? '').replace(INVALID_CHARS, '').replaceAll('\t', ' ');
  return name.split(/\s+/).filter(Boolean).join(' ').replace(/^[ .]+|[ .]+$/g, '');
}

function getTitleFolder(media) {
  const title = cleanName(media.name);
  const year = String(media.year || '');
  return year ? `${title} (${year})` : title;
}

function pad2(number) {
  return String(parseInt(number || 0, 10) || 0).padStart(2, '0');
}

/** Numbers like 3 become 03, special episodes like 6.5 stay as they are */
function formatEpisodeNumber(number) {
  const text = String(number || '0');
  return /^\d+$/.test(text) ? pad2(text) : cleanName(text);
}

/** Readable name of the file, without extension */
function getFileName(media) {
  const title = cleanName(media.name) || 'Senza nome';

  if (media.type === 'tv') {
    const code = `S${pad2(media.season)}E${pad2(media.episode_number)}`;
    const episode = cleanName(media.episode_name);
    return episode ? `${title} - ${code} - ${episode}` : `${title} - ${code}`;
  }

  // Every anime of the site is a single season, films of anime have one episode
  if (media.type === 'anime' && !media.single) return `${title} - S01E${formatEpisodeNumber(media.episode_number)}`;

  const year = String(media.year || '');
  return year ? `${title} (${year})` : title;
}

/** Path of the file on the nas, with the folders used by media servers */
function getRemotePath(config, media, extension = '.mp4') {
  const folder = getTitleFolder(media) || 'Senza nome';
  const fileName = `${getFileName(media)}${extension}`;

  if (media.type === 'anime') {
    const base = config.anime_path || config.tv_path || config.film_path;
    return media.single ? path.posix.join(base, folder, fileName) : path.posix.join(base, folder, 'Stagione 01', fileName);
  }

  if (media.type === 'tv') return path.posix.join(config.tv_path || config.film_path, folder, `Stagione ${pad2(media.season)}`, fileName);

  return path.posix.join(config.film_path, folder, fileName);
}

/** Rename a downloaded file with its readable name */
function renameLocal(localPath, media) {
  if (!localPath || !fs.existsSync(localPath)) return localPath;

  const newPath = path.join(path.dirname(localPath), getFileName(media) + path.extname(localPath));
  if (path.resolve(newPath) === path.resolve(localPath)) return localPath;

  try {
    fs.renameSync(localPath, newPath);
  } catch {
    return localPath;
  }

  return newPath;
}


// [ connection ]
/** Open a tcp connection, with the first bytes the server sends (its banner) */
function probe(host, port, timeout, readBanner = false) {
  return new Promise((resolve) => {
    let socket;

    try {
      socket = net.connect({ host, port: Number(port) });
    } catch {
      resolve(null);
      return;
    }

    const finish = (result) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(socket.connecting ? null : Buffer.alloc(0)), timeout);

    socket.once('connect', () => {
      if (!readBanner) finish(Buffer.alloc(0));
    });
    socket.once('data', (data) => finish(data.subarray(0, 64)));
    socket.once('error', () => finish(null));
  });
}

/** Fast check that the nas is on, without logging in */
async function isReachable(config, timeout = 3000) {
  return (await probe(config.host, config.port, timeout)) !== null;
}

function fingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64')}`;
}

function promisify(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** Sftp with promises, closed with close() */
class Sftp {
  constructor(client, sftp) {
    this.client = client;
    this.sftp = sftp;
  }

  stat(remote) {
    return promisify(this.sftp, 'stat', remote);
  }

  async isFolder(remote) {
    try {
      return (await this.stat(remote)).isDirectory();
    } catch {
      return false;
    }
  }

  readdir(remote) {
    return promisify(this.sftp, 'readdir', remote);
  }

  mkdir(remote) {
    return promisify(this.sftp, 'mkdir', remote);
  }

  remove(remote) {
    return promisify(this.sftp, 'unlink', remote);
  }

  rmdir(remote) {
    return promisify(this.sftp, 'rmdir', remote);
  }

  rename(from, to) {
    return promisify(this.sftp, 'rename', from, to);
  }

  realpath(remote) {
    return promisify(this.sftp, 'realpath', remote);
  }

  close() {
    this.client.end();
  }
}

/** Open a sftp connection to the nas */
async function openSftp(config, password = null) {
  if (!config.host || !config.user) throw new NasError('Indirizzo o utente del NAS non impostati');

  const secret = password || getPassword(config);
  if (!secret) throw new NasError('Password del NAS non salvata, inseriscila nelle impostazioni');

  // Fast check, a nas that is off must not hold the download for long
  const banner = await probe(config.host, config.port, 4000, true);
  if (banner === null) throw new NasError(`NAS non raggiungibile su ${config.host}:${config.port}`);

  // The ftp of the nas answers on its own port (21), the upload uses sftp, the one of ssh
  if (banner.subarray(0, 3).toString() === '220') {
    throw new NasError(`Sulla porta ${config.port} risponde l'FTP, ma il caricamento usa SFTP: metti la porta 22 e attiva SSH sul NAS`);
  }

  const knownHosts = storage.readJson(KNOWN_HOSTS_FILE, {});
  const hostKey = `${config.host}:${config.port}`;
  let keyChanged = false;
  let seenKey = null;
  const client = new Client();

  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => finish(prompts.map(() => secret)));

    client.connect({
      host: config.host,
      port: Number(config.port),
      username: config.user,
      password: secret,
      tryKeyboard: true,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,

      // The key of the nas is saved at the first connection and checked after
      hostVerifier: (key) => {
        seenKey = fingerprint(key);
        const known = storage.isObject(knownHosts) ? knownHosts[hostKey] : null;
        keyChanged = Boolean(known && known !== seenKey);
        return !keyChanged;
      },
    });
  }).catch((error) => {
    client.end();
    if (keyChanged) throw new NasError('La chiave del NAS è cambiata, controlla di collegarti al NAS giusto');
    if (error.level === 'client-authentication') throw new NasError('Utente o password del NAS non corretti');
    throw new NasError(`Impossibile collegarsi al NAS: ${error.message}`);
  });

  if (seenKey && !(storage.isObject(knownHosts) && knownHosts[hostKey])) {
    try {
      storage.writeJson(KNOWN_HOSTS_FILE, { ...(storage.isObject(knownHosts) ? knownHosts : {}), [hostKey]: seenKey }, 2);
    } catch {
      // Saved at the next connection
    }
  }

  try {
    const sftp = await new Promise((resolve, reject) => client.sftp((error, result) => (error ? reject(error) : resolve(result))));
    return new Sftp(client, sftp);
  } catch (error) {
    client.end();
    throw new NasError(`Impossibile aprire la connessione SFTP con il NAS: ${error.message}`);
  }
}

/** Run action with an open sftp, always closed at the end */
async function withSftp(config, action, password = null) {
  const sftp = await openSftp(config, password);
  try {
    return await action(sftp);
  } finally {
    sftp.close();
  }
}

/** Name of the folders inside a path, to help choosing the right one */
async function listFolders(sftp, remote) {
  try {
    return (await sftp.readdir(remote)).filter((entry) => entry.attrs.isDirectory()).map((entry) => entry.filename).sort().slice(0, 40);
  } catch {
    return [];
  }
}

/** Create a folder on the nas with all its parents */
async function makeFolders(sftp, remote) {
  let current = remote.startsWith('/') ? '/' : '';

  for (const part of remote.split('/').filter(Boolean)) {
    current = path.posix.join(current, part);

    if (await sftp.isFolder(current)) continue;

    try {
      await sftp.mkdir(current);
    } catch {
      throw new NasError(`Non riesco a creare la cartella ${current} sul NAS`);
    }
  }
}

/** Check the connection and the folders, return what the gui shows */
function testConnection(config, password = null) {
  return withSftp(config, async (sftp) => {
    let home = null;
    try {
      home = await sftp.realpath('.');
    } catch {
      home = null;
    }

    const folders = {};
    for (const key of ['film_path', 'tv_path', 'anime_path']) {
      const remote = config[key];

      if (!remote) {
        folders[key] = { path: remote, exists: false, near: [] };
        continue;
      }

      folders[key] = {
        path: remote,
        exists: await sftp.isFolder(remote),
        near: await listFolders(sftp, path.posix.dirname(remote) || '/'),
      };
    }

    return { home, folders };
  }, password);
}


// [ upload ]
/** Dont leave half files on the nas, nor the folder created for them */
async function removePartial(sftp, tempPath) {
  for (const action of [() => sftp.remove(tempPath), () => sftp.rmdir(path.posix.dirname(tempPath))]) {
    try {
      await action();
    } catch {
      // Already gone, or the folder has other files
    }
  }
}

/** Send the file, progress(sent, total) can throw to stop: the connection is closed at once */
function put(sftp, localPath, remotePath, progress) {
  return new Promise((resolve, reject) => {
    let stopped = null;

    const onClose = () => {
      if (stopped) reject(stopped);
    };
    sftp.client.once('close', onClose);

    sftp.sftp.fastPut(localPath, remotePath, {
      step: (sent, chunk, total) => {
        if (stopped || !progress) return;

        try {
          progress(sent, total);
        } catch (error) {
          stopped = error;
          sftp.client.end();
        }
      },
    }, (error) => {
      sftp.client.removeListener('close', onClose);
      if (stopped) reject(stopped);
      else if (error) reject(error);
      else resolve();
    });
  });
}

/** Upload a file, it takes its real name only when the transfer is complete */
async function upload(config, localPath, remotePath, password = null, progress = null) {
  const size = fs.statSync(localPath).size;
  const tempPath = `${remotePath}.parte`;
  const sftp = await openSftp(config, password);

  try {
    const folder = path.posix.dirname(remotePath);
    await makeFolders(sftp, folder);

    // Half files left by a program closed during an upload
    try {
      for (const entry of await sftp.readdir(folder)) {
        if (entry.filename.endsWith('.parte')) await sftp.remove(path.posix.join(folder, entry.filename));
      }
    } catch {
      // Nothing to clean
    }

    try {
      await put(sftp, localPath, tempPath, progress);
    } catch (error) {
      if (error instanceof DownloadCancelled) throw error;
      await removePartial(sftp, tempPath);
      throw new NasError(`Trasferimento sul NAS non riuscito: ${error.message}`);
    }

    try {
      const uploaded = (await sftp.stat(tempPath)).size;

      if (uploaded !== size) {
        await removePartial(sftp, tempPath);
        throw new NasError(`Trasferimento incompleto, ${uploaded} byte invece di ${size}`);
      }

      try {
        await sftp.remove(remotePath);
      } catch {
        // There was no old copy
      }

      await sftp.rename(tempPath, remotePath);

    } catch (error) {
      if (error instanceof NasError) throw error;
      await removePartial(sftp, tempPath);
      throw new NasError(`Il NAS non ha completato il salvataggio del file: ${error.message}`);
    }

  } finally {
    sftp.close();
  }

  return remotePath;
}

/** Report the upload without calling back for every block */
function makeProgress(progressCallback) {
  let last = 0;

  return (sent, total) => {
    const now = Date.now();

    if (progressCallback && (sent >= total || now - last > 300)) {
      last = now;
      progressCallback('upload', sent, total);
    }
  };
}

/**
 * Rename a downloaded file and move it to the nas if it is enabled.
 * A nas that does not answer is never a lost download: the file stays here.
 * Return {path: file on this pc, remote: file on the nas, warning: why the nas failed}
 */
async function finalize(localPath, media = null, progressCallback = null) {
  const result = { path: localPath, remote: null, warning: null };

  if (!media) return result;

  const renamed = renameLocal(localPath, media);
  result.path = renamed;
  const config = loadConfig();

  if (!isEnabled(config)) return result;

  let remotePath;

  try {
    remotePath = getRemotePath(config, media);
    console.print(`Upload to nas => ${remotePath}`);

    if (!fs.existsSync(renamed) || !fs.statSync(renamed).isFile()) throw new NasError("Il file da caricare non c'è più");

    if (progressCallback) progressCallback('upload', 0, fs.statSync(renamed).size);

    await upload(config, renamed, remotePath, null, makeProgress(progressCallback));

  } catch (error) {
    if (error instanceof DownloadCancelled) {
      // The download is complete, only the upload is stopped
      console.log(`NAS: caricamento annullato, il file resta in ${renamed}`);
      result.warning = 'Caricamento sul NAS annullato, il file è rimasto sul PC';
      return result;
    }

    if (error instanceof NasError) {
      console.log(`NAS: ${error.message}, il file resta in ${renamed}`);
      result.warning = error.message;
      return result;
    }

    console.log(`NAS: errore inatteso (${error.message}), il file resta in ${renamed}`);
    result.warning = `Errore inatteso durante il caricamento: ${error.message}`;
    return result;
  }

  // The file is on the nas, a copy that cant be removed here is only a warning
  try {
    fs.unlinkSync(renamed);
  } catch (error) {
    console.log(`NAS: file caricato, ma la copia locale non si può eliminare (${error.message})`);
    result.remote = remotePath;
    return result;
  }

  return { path: null, remote: remotePath, warning: null };
}

module.exports = {
  NasError, PASSWORD_ENV, loadConfig, saveConfig, isEnabled, getPassword, savePassword,
  cleanName, getFileName, getRemotePath, renameLocal, isReachable, openSftp, withSftp, testConnection,
  upload, makeProgress, finalize,
};

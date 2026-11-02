// 28.10.26

// Passwords of the nas and of qbittorrent. In the app they are encrypted by the system (DPAPI, the same protection
// of the credential manager); without it (started with node) they go in a file only readable by the program.

const fs = require('fs');
const storage = require('./storage');
const { console } = require('./console');

const SECRETS_FILE = 'secrets.json';
let cipher = null;              // { encrypt(text) -> base64, decrypt(base64) -> text }, given by electron

function setCipher(value) {
  cipher = value;
}

function key(service, account) {
  return `${service}|${account}`;
}

function get(service, account, plainFile) {
  if (cipher) {
    const saved = storage.readJson(SECRETS_FILE, {});
    const value = storage.isObject(saved) ? saved[key(service, account)] : null;

    if (value) {
      try {
        return cipher.decrypt(value);
      } catch {
        // Encrypted by another user of the pc, it is asked again
      }
    }
  }

  const saved = storage.readJson(plainFile, {});
  return storage.isObject(saved) ? saved[account] || null : null;
}

function set(service, account, password, plainFile) {
  if (!password) return true;

  if (cipher) {
    try {
      const saved = storage.readJson(SECRETS_FILE, {});
      storage.writeJson(SECRETS_FILE, { ...(storage.isObject(saved) ? saved : {}), [key(service, account)]: cipher.encrypt(password) }, 2);
      return true;
    } catch {
      // The plain file is used
    }
  }

  try {
    storage.writeJson(plainFile, { [account]: password });
  } catch (error) {
    console.log(`Password non salvata (${error.message})`);
    return false;
  }

  // The copy kept by storage has the previous password
  for (const path of [storage.resolve(plainFile), `${storage.resolve(plainFile)}.bak`]) {
    try {
      fs.chmodSync(path, 0o600);
    } catch {
      // Not possible on every disk
    }
  }

  return true;
}

module.exports = { setCipher, get, set };

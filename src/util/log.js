// 18.09.26

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

const MAX_BYTES = 1024 * 1024;
const BACKUPS = 3;

/** Errors are written in logs/errori.log, the file never grows beyond a few MB */
function logFile() {
  return paths.data('logs', 'errori.log');
}

function rotate(file) {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
  } catch {
    return;
  }

  for (let index = BACKUPS - 1; index >= 1; index--) {
    try {
      fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    } catch {
      // Missing backup
    }
  }

  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // The log goes on in the same file
  }
}

function stamp() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())},${pad(now.getMilliseconds(), 3)}`;
}

function write(level, message) {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotate(file);
  fs.appendFileSync(file, `${stamp()} ${level} ${message}\n`, 'utf8');
}

/** Never throws: a log that cant be written must not stop the program */
function logError(message, error = null) {
  try {
    const details = error ? (error.stack || String(error)) : '';
    write('ERROR', `${message}\n${details}`.trimEnd());
  } catch {
    // Nothing to do
  }
}

function logInfo(message) {
  try {
    write('INFO', message);
  } catch {
    // Nothing to do
  }
}

module.exports = { logError, logInfo, logFile };

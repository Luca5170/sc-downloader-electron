// 18.09.26

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

function resolve(file) {
  return path.isAbsolute(file) ? file : paths.data(file);
}

/**
 * Save a json file so that it is never left half written.
 * The new content goes to a temporary file that takes the place of the old one only when complete,
 * the previous version stays in .bak in case the disk loses the new one (power cut).
 * Files are written synchronously: two writes of the same file never mix.
 */
function writeJson(file, data, indent) {
  const target = resolve(file);
  const tempPath = `${target}.tmp`;
  const text = JSON.stringify(data, null, indent);

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const handle = fs.openSync(tempPath, 'w');
  try {
    fs.writeSync(handle, text, null, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }

  if (fs.existsSync(target)) {
    try {
      fs.renameSync(target, `${target}.bak`);
    } catch {
      // The old copy stays where it is
    }
  }

  fs.renameSync(tempPath, target);
}

/** Read a json file, if it is damaged the last good copy is used */
function readJson(file, fallback = null) {
  const target = resolve(file);

  for (const candidate of [target, `${target}.bak`]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^﻿/, ''));
    } catch {
      continue;
    }
  }

  return fallback;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { writeJson, readJson, isObject, resolve };

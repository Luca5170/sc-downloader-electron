// 3.12.23 -> 10.12.23

// User agent of a recent Chrome on Windows or Linux, a different one at every call

const SYSTEMS = [
  'Windows NT 10.0; Win64; x64',
  'Windows NT 10.0; Win64; x64',
  'X11; Linux x86_64',
];
const FIRST_VERSION = 138;
const LAST_VERSION = 146;

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getHeaders() {
  const version = FIRST_VERSION + Math.floor(Math.random() * (LAST_VERSION - FIRST_VERSION + 1));
  return `Mozilla/5.0 (${pick(SYSTEMS)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
}

module.exports = { getHeaders };

// 18.09.26

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const QRCode = require('qrcode');
const storage = require('../util/storage');

const CONFIG_FILE = 'remote.json';
const DEFAULT_PORT = 8770;

// Closing the page on the phone must not close the program on the pc
const LOCAL_ONLY = new Set(['POST /api/close']);


// [ config ]
function loadConfig() {
  const saved = storage.readJson(CONFIG_FILE, {});
  const port = storage.isObject(saved) ? saved.port : null;
  return { port: Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_PORT };
}

function saveConfig(config) {
  storage.writeJson(CONFIG_FILE, { port: config.port }, 4);
}


// [ access ]
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 29],
  ['192.0.0.170', 31], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['240.0.0.0', 4],
];

function toNumber(ip) {
  return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

function inRange(ip, [base, bits]) {
  const size = 2 ** (32 - bits);
  return Math.floor(toNumber(ip) / size) === Math.floor(toNumber(base) / size);
}

function isPrivateV4(ip) {
  return PRIVATE_V4.some((range) => inRange(ip, range));
}

/** Every device of the home network can use the app, internet never */
function isHomeNetwork(address) {
  let ip = String(address || '').toLowerCase();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);

  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (!net.isIPv6(ip)) return false;

  // Loopback, unique local (fc00::/7) and link local (fe80::/10)
  return ip === '::1' || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}


// [ address ]
/** The address used to go on internet, it is the one of the home network */
function routeAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (value) => {
      try {
        socket.close();
      } catch {
        // Already closed
      }
      resolve(value);
    };

    socket.on('error', () => done(null));
    socket.connect(80, '192.0.2.1', () => {
      try {
        done(socket.address().address);
      } catch {
        done(null);
      }
    });
  });
}

/** Addresses of this pc in the home network, the one used to go on internet first */
async function getLanIps() {
  const found = [];
  const route = await routeAddress();
  if (route) found.push(route);

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const info of addresses || []) {
      if (info.family === 'IPv4' || info.family === 4) found.push(info.address);
    }
  }

  return [...new Set(found)].filter((ip) => net.isIPv4(ip) && isPrivateV4(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.') && ip !== '0.0.0.0');
}

/** Qr code of the address, to open it from the phone without typing */
function getQrSvg(url) {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#08090dff', light: '#ffffffff' } });
}

module.exports = { DEFAULT_PORT, LOCAL_ONLY, loadConfig, saveConfig, isHomeNetwork, getLanIps, getQrSvg };

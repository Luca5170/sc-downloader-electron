// 28.10.26

// The window of SC Downloader. The program is the same server of the python version, the window shows its page:
// closing the window closes the program, but only when no download is running (it waits in the tray meanwhile).

const path = require('path');
const { app, BrowserWindow, Menu, Notification, Tray, safeStorage, session, shell } = require('electron');

const ICON = path.join(__dirname, 'assets', 'icon.ico');
const IDLE_CHECK = 4000;
const REMOTE_GRACE = 30000;     // A phone that used the app in the last seconds keeps it open

let core = null;
let window_ = null;
let tray = null;
let idleTimer = null;
let quitting = false;
let notified = false;


// [ start ]
function setupPaths() {
  const paths = require('./src/paths');
  const data = process.env.SC_DATA_DIR || app.getPath('userData');
  const videos = process.env.SC_VIDEOS_DIR || path.join(app.getPath('videos'), 'SC Downloader');
  paths.init({ data, videos });
}

function setupSystem() {
  require('./src/platform').setShell(shell);

  // Passwords of the nas and of qbittorrent are encrypted by windows, like the credential manager
  if (safeStorage.isEncryptionAvailable()) {
    require('./src/util/credentials').setCipher({
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    });
  }

  // The page needs nothing from the system, the full screen of the player excepted
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(['fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });
}


// [ window ]
function isLocal(url) {
  return core && (url === core.url || url.startsWith(`${core.url}/`));
}

function createWindow() {
  window_ = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 820,
    minHeight: 560,
    title: 'SC Downloader',
    icon: ICON,
    backgroundColor: '#08090d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window_.removeMenu();
  window_.once('ready-to-show', () => window_.show());

  // Links to the sites of the torrents and to jackett open in the browser of the pc
  window_.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|magnet):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  window_.webContents.on('will-navigate', (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // F5 reloads the page, Ctrl+Shift+I opens the tools to see what goes wrong
  window_.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      window_.webContents.reload();
      event.preventDefault();
    } else if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      window_.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  window_.on('closed', () => {
    window_ = null;
  });

  window_.loadURL(core.url);
}

function showWindow() {
  stopBackground();

  if (!window_) {
    createWindow();
    return;
  }

  if (window_.isMinimized()) window_.restore();
  window_.show();
  window_.focus();
}


// [ background ]
/** The window is closed while something is running: the program stays in the tray until it ends */
function runInBackground() {
  if (!tray) {
    tray = new Tray(ICON);
    tray.setToolTip('SC Downloader: download in corso');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Apri SC Downloader', click: showWindow },
      { type: 'separator' },
      { label: 'Esci (i download riprendono al prossimo avvio)', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  }

  if (!notified && Notification.isSupported()) {
    notified = true;
    new Notification({
      title: 'SC Downloader continua a scaricare',
      body: 'Quando i download finiscono il programma si chiude da solo. Riaprilo dall\'icona vicino all\'orologio.',
      icon: ICON,
    }).show();
  }

  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (window_ || core.app.isBusy() || Date.now() - core.app.lastRemoteRequest < REMOTE_GRACE) return;
    app.quit();
  }, IDLE_CHECK);
}

function stopBackground() {
  clearInterval(idleTimer);
  idleTimer = null;

  if (tray) {
    tray.destroy();
    tray = null;
  }
}


// [ program ]
if (!app.requestSingleInstanceLock()) {
  // Two programs open would download the same things together: the second one only shows the first
  app.quit();
} else {
  app.setAppUserModelId('it.luca.scdownloader');
  setupPaths();

  app.on('second-instance', () => {
    if (core) showWindow();
  });

  app.whenReady().then(async () => {
    setupSystem();

    const server = require('./src/gui/server');
    core = await server.start();
    core.server = server;
    createWindow();
  }).catch((error) => {
    require('./src/util/log').logError('The program stopped', error);
    const { dialog } = require('electron');
    dialog.showErrorBox('SC Downloader non si avvia', String(error.stack || error));
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (core && core.app.isBusy()) runInBackground();
    else app.quit();
  });

  // Running downloads pause and keep their segments, they go on at the next start
  app.on('before-quit', (event) => {
    if (quitting || !core) return;

    event.preventDefault();
    quitting = true;
    stopBackground();

    // The last position of a video, sent by the page while it closes, arrives first
    setTimeout(() => {
      core.server.stop(core.app).catch(() => {}).finally(() => app.exit(0));
    }, 400);
  });
}

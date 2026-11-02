// 28.10.26

// What the program asks to the system: open a folder, show a file, open a link or a magnet.
// The app uses the shell of electron, started with node the commands of the system are used.

const fs = require('fs');
const { spawn } = require('child_process');

let shell = null;

function setShell(value) {
  shell = value;
}

function run(command, args) {
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function openPath(target) {
  if (shell) return shell.openPath(target);

  if (process.platform === 'win32') run('explorer', [target]);
  else if (process.platform === 'darwin') run('open', [target]);
  else run('xdg-open', [target]);
  return Promise.resolve('');
}

function openExternal(url) {
  if (shell) return shell.openExternal(url);

  if (process.platform === 'win32') run('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') run('open', [url]);
  else run('xdg-open', [url]);
  return Promise.resolve();
}

/** A file is shown selected in its folder, a folder is opened */
function openInExplorer(target) {
  let isFile = false;
  try {
    isFile = fs.statSync(target).isFile();
  } catch {
    isFile = false;
  }

  if (!isFile) return openPath(target);
  if (shell) return shell.showItemInFolder(target);

  if (process.platform === 'win32') run('explorer', [`/select,${target}`]);
  else if (process.platform === 'darwin') run('open', ['-R', target]);
  else run('xdg-open', [require('path').dirname(target)]);
  return undefined;
}

module.exports = { setShell, openPath, openExternal, openInExplorer };

// 17.09.23

// Messages of the program, in the terminal when it is started from there

function time() {
  return new Date().toTimeString().slice(0, 8);
}

const console_ = {
  print: (...parts) => console.log(...parts),
  log: (...parts) => console.log(`[${time()}]`, ...parts),
};

module.exports = { console: console_ };

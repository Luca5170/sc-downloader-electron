// 28.10.26

// The program without its window, opened in the browser: node dev-server.js
// SC_DATA_DIR and SC_VIDEOS_DIR choose the folders, --port or PORT the port (8765)

const path = require('path');
const paths = require('./src/paths');

const data = process.env.SC_DATA_DIR || path.join(__dirname, 'data');
paths.init({ data, videos: process.env.SC_VIDEOS_DIR || path.join(data, 'videos') });

const server = require('./src/gui/server');

const portArgument = process.argv.indexOf('--port');
const port = Number(portArgument > 0 ? process.argv[portArgument + 1] : process.env.PORT) || 8765;

server.start({ port }).then((core) => {
  const close = () => {
    console.log('GUI closed');
    server.stop(core.app).finally(() => process.exit(0));
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

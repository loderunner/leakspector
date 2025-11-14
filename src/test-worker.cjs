// Simple test worker script
const { parentPort } = require('node:worker_threads');

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message === 'exit') {
      process.exit(0);
    }
    parentPort.postMessage(`echo: ${message}`);
  });
}

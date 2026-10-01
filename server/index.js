import { createApp } from './app.js';

try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('Unable to read the local .env configuration.');
    process.exit(1);
  }
}

const portValue = process.env.PORT ?? '3000';
const port = Number(portValue);

if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer from 1 to 65535.');
  process.exit(1);
}

const server = createApp().listen(port, '0.0.0.0');

server.on('listening', () => {
  console.log(`KaiOrderApp listening on port ${port}.`);
});

server.on('error', () => {
  console.error('Unable to start KaiOrderApp. Check PORT and whether it is already in use.');
  process.exit(1);
});

let stopping = false;

function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

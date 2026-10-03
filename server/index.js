import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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

const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;

if (Boolean(certPath) !== Boolean(keyPath)) {
  console.error('TLS_CERT_PATH and TLS_KEY_PATH must both be configured to enable HTTPS.');
  process.exit(1);
}

function readTlsFile(path, variable) {
  try {
    return readFileSync(path);
  } catch {
    console.error(`Unable to read ${variable}. Check the file path and read permissions.`);
    process.exit(1);
  }
}

const protocol = certPath ? 'HTTPS' : 'HTTP';
const app = createApp();
let server;

if (certPath) {
  const cert = readTlsFile(certPath, 'TLS_CERT_PATH');
  const key = readTlsFile(keyPath, 'TLS_KEY_PATH');
  try {
    server = createHttpsServer({ cert, key }, app);
  } catch {
    console.error('Unable to initialize HTTPS. Check that TLS_CERT_PATH and TLS_KEY_PATH contain a valid PEM certificate chain and matching unencrypted private key.');
    process.exit(1);
  }
} else {
  server = createHttpServer(app);
}

server.on('listening', () => {
  console.log(`KaiOrderApp listening on ${protocol} port ${port}.`);
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

server.listen(port, '0.0.0.0');

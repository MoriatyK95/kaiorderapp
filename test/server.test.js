import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../server/index.js', import.meta.url));
const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kaiorderapp-server-test-'));
  const processes = [];
  t.after(async () => {
    for (const server of processes) {
      if (!server.result) server.child.kill('SIGTERM');
      await server.closed;
    }
    await rm(directory, { recursive: true, force: true });
  });

  return {
    directory,
    start(overrides = {}) {
      const env = { ...process.env };
      for (const name of ['PORT', 'TLS_CERT_PATH', 'TLS_KEY_PATH', 'NODE_OPTIONS']) delete env[name];
      Object.assign(env, overrides);
      const child = spawn(process.execPath, [entrypoint], {
        cwd: directory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const server = { child, stdout: '', stderr: '', result: null };
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      server.listening = new Promise((resolve) => {
        child.stdout.on('data', (chunk) => {
          server.stdout += chunk;
          if (server.stdout.includes('KaiOrderApp listening on ')) resolve();
        });
      });
      child.stderr.on('data', (chunk) => { server.stderr += chunk; });
      child.on('error', (error) => { server.spawnError = error; });
      server.closed = new Promise((resolve) => {
        child.once('close', (code, signal) => {
          clearTimeout(timeout);
          server.result = { code, signal };
          resolve(server.result);
        });
      });
      processes.push(server);
      return server;
    },
  };
}

async function ready(server, protocol, port) {
  await Promise.race([
    server.listening,
    server.closed.then(() => {
      throw new Error(`Server exited before listening: ${server.spawnError ?? server.stderr}`);
    }),
  ]);
  assert.equal(server.stdout.trim(), `KaiOrderApp listening on ${protocol} port ${port}.`);
  assert.equal(server.stderr, '');
}

function request(port, { secure = false, ca } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = (secure ? httpsRequest : httpRequest)({
      hostname: '127.0.0.1', port, path: '/api/health', agent: false, ...(ca ? { ca } : {}),
    }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, body }));
    });
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error('Request timed out.')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function assertHealthy(port, options) {
  const response = await request(port, options);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
}

async function assertStartupFailure(server, port, expectedError) {
  assert.deepEqual(await server.closed, { code: 1, signal: null });
  assert.match(server.stderr, expectedError);
  assert.doesNotMatch(server.stderr, /-----BEGIN|-----END|\n\s+at |Error:|opensslErrorStack/);
  assert.doesNotMatch(server.stdout, /listening/i);
  await assert.rejects(request(port), { code: 'ECONNREFUSED' });
}

function generateCertificate(directory) {
  const cert = join(directory, 'fullchain.pem');
  const key = join(directory, 'privkey.pem');
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore', timeout: 10_000 });
  assert.equal(result.status, 0, 'OpenSSL must generate the temporary test certificate.');
  return { cert, key };
}

for (const [name, tls, signal] of [
  ['unset TLS variables', {}, 'SIGTERM'],
  ['empty TLS variables', { TLS_CERT_PATH: '', TLS_KEY_PATH: '' }, 'SIGINT'],
]) {
  test(`HTTP starts with ${name} and shuts down on ${signal}`, async (t) => {
    const context = await fixture(t);
    const port = await unusedPort();
    const server = context.start({ PORT: String(port), ...tls });
    await ready(server, 'HTTP', port);
    await assertHealthy(port);
    server.child.kill(signal);
    assert.deepEqual(await server.closed, { code: 0, signal: null });
    await assert.rejects(request(port), { code: 'ECONNREFUSED' });
  });
}

test('startup loads PORT from the local .env file', async (t) => {
  const context = await fixture(t);
  const port = await unusedPort();
  await writeFile(join(context.directory, '.env'), `PORT=${port}\n`);
  const server = context.start();
  await ready(server, 'HTTP', port);
  await assertHealthy(port);
});

test('exported environment values take precedence over .env', async (t) => {
  const context = await fixture(t);
  const port = await unusedPort();
  await writeFile(join(context.directory, '.env'), 'PORT=invalid\nTLS_CERT_PATH=not-used.pem\nTLS_KEY_PATH=not-used.key\n');
  const server = context.start({ PORT: String(port), TLS_CERT_PATH: '', TLS_KEY_PATH: '' });
  await ready(server, 'HTTP', port);
  await assertHealthy(port);
});

test('startup rejects invalid PORT values', async (t) => {
  for (const value of ['', '0', '65536', '-1', '3.5', 'invalid']) {
    await t.test(JSON.stringify(value), async (t) => {
      const context = await fixture(t);
      const server = context.start({ PORT: value });
      assert.deepEqual(await server.closed, { code: 1, signal: null });
      assert.match(server.stderr, /PORT must be an integer from 1 to 65535/);
      assert.doesNotMatch(server.stdout, /listening/i);
    });
  }
});

for (const configured of ['TLS_CERT_PATH', 'TLS_KEY_PATH']) {
  test(`startup fails when only ${configured} is configured`, async (t) => {
    const context = await fixture(t);
    const port = await unusedPort();
    const server = context.start({ PORT: String(port), [configured]: 'not-read.pem' });
    await assertStartupFailure(server, port, /TLS_CERT_PATH.*TLS_KEY_PATH/);
  });
}

for (const variable of ['TLS_CERT_PATH', 'TLS_KEY_PATH']) {
  test(`startup fails safely when ${variable} is missing`, async (t) => {
    const context = await fixture(t);
    const port = await unusedPort();
    const existing = join(context.directory, 'existing.pem');
    await writeFile(existing, 'test contents must not be printed');
    const server = context.start({
      PORT: String(port), TLS_CERT_PATH: existing, TLS_KEY_PATH: existing,
      [variable]: join(context.directory, 'missing.pem'),
    });
    await assertStartupFailure(server, port, new RegExp(`Unable to read ${variable}`));
    assert.doesNotMatch(server.stderr, /test contents must not be printed/);
  });

  test(`startup fails safely when ${variable} is unreadable`, async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('Unreadable-file test needs a non-root user and POSIX file permissions.');
      return;
    }
    const context = await fixture(t);
    const port = await unusedPort();
    const readable = join(context.directory, 'readable.pem');
    const unreadable = join(context.directory, 'unreadable.pem');
    await writeFile(readable, 'test contents must not be printed');
    await writeFile(unreadable, 'test contents must not be printed');
    await chmod(unreadable, 0);
    try {
      await readFile(unreadable);
      t.skip('This environment permits reading files despite their permission mode.');
      return;
    } catch (error) {
      assert.equal(error.code, 'EACCES');
    }
    const server = context.start({
      PORT: String(port), TLS_CERT_PATH: readable, TLS_KEY_PATH: readable, [variable]: unreadable,
    });
    await assertStartupFailure(server, port, new RegExp(`Unable to read ${variable}`));
    assert.doesNotMatch(server.stderr, /test contents must not be printed/);
  });
}

test('startup rejects malformed TLS files without exposing their contents', async (t) => {
  const context = await fixture(t);
  const port = await unusedPort();
  const malformed = join(context.directory, 'malformed.pem');
  await writeFile(malformed, 'test contents must not be printed');
  const server = context.start({ PORT: String(port), TLS_CERT_PATH: malformed, TLS_KEY_PATH: malformed });
  await assertStartupFailure(server, port, /Unable to initialize HTTPS/);
  assert.doesNotMatch(server.stderr, /test contents must not be printed/);
});

test('startup rejects malformed or empty certificates and keys separately', async (t) => {
  if (!opensslAvailable) return t.skip('OpenSSL is unavailable; individual invalid TLS file tests were not run.');
  const validFiles = await fixture(t);
  const { cert, key } = generateCertificate(validFiles.directory);
  await chmod(key, 0o600);
  for (const variable of ['TLS_CERT_PATH', 'TLS_KEY_PATH']) {
    for (const [name, contents] of [['malformed', 'test contents must not be printed'], ['empty', '']]) {
      await t.test(`${name} ${variable}`, async (t) => {
        const context = await fixture(t);
        const invalid = join(context.directory, 'invalid.pem');
        await writeFile(invalid, contents);
        const port = await unusedPort();
        const server = context.start({
          PORT: String(port), TLS_CERT_PATH: cert, TLS_KEY_PATH: key, [variable]: invalid,
        });
        await assertStartupFailure(server, port, /Unable to initialize HTTPS/);
        assert.doesNotMatch(server.stderr, /test contents must not be printed/);
      });
    }
  }
});

test('HTTPS serves the API with a trusted temporary certificate', async (t) => {
  if (!opensslAvailable) return t.skip('OpenSSL is unavailable; HTTPS certificate tests were not run.');
  const context = await fixture(t);
  const { cert, key } = generateCertificate(context.directory);
  await chmod(key, 0o600);
  const port = await unusedPort();
  await writeFile(join(context.directory, '.env'), `PORT=${port}\nTLS_CERT_PATH=${cert}\nTLS_KEY_PATH=${key}\n`);
  const server = context.start();
  await ready(server, 'HTTPS', port);
  await assertHealthy(port, { secure: true, ca: await readFile(cert) });
  try {
    const response = await request(port);
    assert.notEqual(response.status, 200, 'Plain HTTP must not successfully reach the API.');
  } catch (error) {
    assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code), `Unexpected plain HTTP error: ${error.code}`);
  }
  server.child.kill('SIGTERM');
  assert.deepEqual(await server.closed, { code: 0, signal: null });
});

test('startup rejects a certificate and private key that do not match', async (t) => {
  if (!opensslAvailable) return t.skip('OpenSSL is unavailable; TLS key-mismatch test was not run.');
  const context = await fixture(t);
  const { cert } = generateCertificate(context.directory);
  const wrongKey = join(context.directory, 'wrong-key.pem');
  const generated = spawnSync('openssl', [
    'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', wrongKey,
  ], { stdio: 'ignore', timeout: 10_000 });
  assert.equal(generated.status, 0, 'OpenSSL must generate the temporary mismatched key.');
  await chmod(wrongKey, 0o600);
  const port = await unusedPort();
  const server = context.start({ PORT: String(port), TLS_CERT_PATH: cert, TLS_KEY_PATH: wrongKey });
  await assertStartupFailure(server, port, /Unable to initialize HTTPS/);
});

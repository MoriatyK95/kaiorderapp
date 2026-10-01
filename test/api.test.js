import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';

let server;
let port;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers, agent: false },
      (incoming) => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { text += chunk; });
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function order(body) {
  return request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function assertError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.equal(typeof response.body.error, 'string');
  assert.ok(response.body.error.length > 0);
  assert.equal(response.body.error.includes(' at '), false);
}

test('menu contains the six stable dishes and integer SGD prices', async () => {
  const response = await request('/api/menu');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    currency: 'SGD',
    items: [
      { id: 'ginger-chicken', name: 'Ginger Chicken Rice', priceCents: 890 },
      { id: 'sambal-tofu', name: 'Sambal Tofu Bowl', priceCents: 750 },
      { id: 'miso-mushroom', name: 'Miso Mushroom Rice', priceCents: 950 },
      { id: 'lime-prawn', name: 'Lime Prawn Bowl', priceCents: 1190 },
      { id: 'sesame-noodles', name: 'Sesame Garden Noodles', priceCents: 790 },
      { id: 'coconut-curry', name: 'Coconut Vegetable Curry', priceCents: 990 },
    ],
  });
});

test('valid orders return server-calculated line totals, total, UUID, and timestamp', async () => {
  const startedAt = Date.now();
  const response = await order({ items: [
    { id: 'ginger-chicken', quantity: 2 },
    { id: 'lime-prawn', quantity: 3 },
  ] });
  assert.equal(response.status, 201);
  assert.equal(response.body.currency, 'SGD');
  assert.deepEqual(response.body.items, [
    { id: 'ginger-chicken', name: 'Ginger Chicken Rice', quantity: 2, priceCents: 890, lineTotalCents: 1780 },
    { id: 'lime-prawn', name: 'Lime Prawn Bowl', quantity: 3, priceCents: 1190, lineTotalCents: 3570 },
  ]);
  assert.equal(response.body.totalCents, 5350);
  assert.match(response.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const timestamp = Date.parse(response.body.timestamp);
  assert.equal(new Date(timestamp).toISOString(), response.body.timestamp);
  assert.ok(timestamp >= startedAt && timestamp <= Date.now());
});

test('browser-supplied prices, totals, names, currency, and IDs do not affect the order', async () => {
  const response = await order({
    id: 'forged-id',
    currency: 'USD',
    totalCents: 1,
    total: -100,
    items: [{ id: 'sambal-tofu', quantity: 2, name: 'Forged dish', priceCents: 1, lineTotalCents: 2 }],
  });
  assert.equal(response.status, 201);
  assert.notEqual(response.body.id, 'forged-id');
  assert.equal(response.body.currency, 'SGD');
  assert.equal(response.body.totalCents, 1500);
  assert.deepEqual(response.body.items, [
    { id: 'sambal-tofu', name: 'Sambal Tofu Bowl', quantity: 2, priceCents: 750, lineTotalCents: 1500 },
  ]);
});

test('all six dishes and quantity boundaries are accepted', async () => {
  const response = await order({ items: [
    { id: 'ginger-chicken', quantity: 1 },
    { id: 'sambal-tofu', quantity: 99 },
    { id: 'miso-mushroom', quantity: 1 },
    { id: 'lime-prawn', quantity: 1 },
    { id: 'sesame-noodles', quantity: 1 },
    { id: 'coconut-curry', quantity: 1 },
  ] });
  assert.equal(response.status, 201);
  assert.equal(response.body.items.length, 6);
  assert.equal(response.body.totalCents, 79_060);
});

test('separate submissions generate different demo IDs', async () => {
  const payload = { items: [{ id: 'sesame-noodles', quantity: 1 }] };
  const first = await order(payload);
  const second = await order(payload);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
});

test('rejects missing, malformed, empty, or overlong item collections', async (t) => {
  const cases = [
    ['null', null],
    ['array', []],
    ['string', 'order'],
    ['missing items', {}],
    ['empty items', { items: [] }],
    ['object items', { items: {} }],
    ['string items', { items: 'ginger-chicken' }],
    ['too many items', { items: Array.from({ length: 7 }, () => ({ id: 'ginger-chicken', quantity: 1 })) }],
  ];
  for (const [name, payload] of cases) {
    await t.test(name, async () => assertError(await order(payload), 400));
  }
});

test('rejects malformed items and unknown IDs', async (t) => {
  const cases = [
    ['null item', null],
    ['array item', []],
    ['string item', 'ginger-chicken'],
    ['missing ID', { quantity: 1 }],
    ['numeric ID', { id: 1, quantity: 1 }],
    ['unknown ID', { id: 'unknown-dish', quantity: 1 }],
    ['prototype key', { id: '__proto__', quantity: 1 }],
  ];
  for (const [name, item] of cases) {
    await t.test(name, async () => assertError(await order({ items: [item] }), 400));
  }
});

test('rejects duplicate item IDs', async () => {
  assertError(await order({ items: [
    { id: 'ginger-chicken', quantity: 1 },
    { id: 'ginger-chicken', quantity: 2 },
  ] }), 400);
});

test('rejects quantities outside integer range 1–99', async (t) => {
  for (const quantity of [undefined, null, false, true, '2', 0, -1, 100, 1.5, Number.MAX_SAFE_INTEGER]) {
    await t.test(String(quantity), async () => {
      assertError(await order({ items: [{ id: 'ginger-chicken', quantity }] }), 400);
    });
  }
});

test('rejects absent and malformed JSON without exposing parser details', async () => {
  for (const body of ['', '{"items":']) {
    assertError(await request('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }), 400);
  }
});

test('rejects unsupported content types and encodings', async () => {
  assertError(await request('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
  }), 415);
  assertError(await request('/api/orders', { method: 'POST', body: '{}' }), 415);
  assertError(await request('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, body: '{}',
  }), 415);
});

test('rejects malformed compressed bodies as invalid input without exposing decompression details', async () => {
  const response = await request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: 'not gzip',
  });
  assertError(response, 400);
  assert.deepEqual(response.body, { error: 'Invalid request body.' });
});

test('rejects request bodies over 10 KB', async () => {
  assertError(await order({
    items: [{ id: 'ginger-chicken', quantity: 1 }],
    padding: 'x'.repeat(11 * 1024),
  }), 413);
});

test('header diagnostics echo actual normalized custom values with no-store', async () => {
  const response = await request('/api/headers', { headers: { 'X-Demo-Message': 'Hello Kai' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.headers['x-demo-message'], 'Hello Kai');
  assert.ok(Array.isArray(response.body.rawHeaders));
  assert.equal(response.body.rawHeaders.length % 2, 0);
  assert.equal(response.body.headers.authorization, undefined);
  assert.equal(response.body.headers.cookie, undefined);
});

test('header diagnostics preserve duplicate received entries and casing in rawHeaders', async () => {
  const response = await request('/api/headers', {
    headers: [
      'Host', `127.0.0.1:${port}`,
      'X-Demo-Message', 'Hello Kai', 'x-demo-message', 'Second value', 'X-Demo-Other', 'Exact Value',
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.headers['x-demo-message'], 'Hello Kai, Second value');
  assert.equal(response.body.headers['x-demo-other'], 'Exact Value');
  const rawCustomHeaders = [];
  for (let index = 0; index < response.body.rawHeaders.length; index += 2) {
    if (response.body.rawHeaders[index].toLowerCase().startsWith('x-demo-')) {
      rawCustomHeaders.push(...response.body.rawHeaders.slice(index, index + 2));
    }
  }
  assert.deepEqual(rawCustomHeaders, [
    'X-Demo-Message', 'Hello Kai', 'x-demo-message', 'Second value', 'X-Demo-Other', 'Exact Value',
  ]);
});

test('health and rate-test return predictable small responses', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  for (let index = 0; index < 3; index += 1) {
    const rateTest = await request('/api/rate-test');
    assert.equal(rateTest.status, 200);
    assert.deepEqual(rateTest.body, { ok: true });
  }
});

test('unknown API routes and unsupported API methods return JSON 404s', async () => {
  for (const path of ['/api', '/api/', '/api/not-found', '/api/menu/extra']) {
    assertError(await request(path), 404);
  }
  assertError(await request('/api/menu', { method: 'POST' }), 404);
});

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { menu } from './menu.js';

const menuById = new Map(menu.map((item) => [item.id, item]));
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/menu', (_request, response) => {
    response.json({ currency: 'SGD', items: menu });
  });

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/headers', (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ headers: request.headers, rawHeaders: request.rawHeaders });
  });

  app.get('/api/rate-test', (_request, response) => {
    response.json({ ok: true });
  });

  app.post(
    '/api/orders',
    (request, response, next) => {
      const contentType = request.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        return response.status(415).json({ error: 'Use Content-Type: application/json.' });
      }
      next();
    },
    express.json({ limit: '10kb' }),
    (request, response) => {
      const order = request.body;
      if (
        !order ||
        typeof order !== 'object' ||
        Array.isArray(order) ||
        !Array.isArray(order.items) ||
        order.items.length < 1 ||
        order.items.length > menu.length
      ) {
        return response.status(400).json({ error: 'Provide an order with 1–6 distinct items.' });
      }

      const seenIds = new Set();
      const items = [];

      for (const item of order.items) {
        if (
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          typeof item.id !== 'string' ||
          !menuById.has(item.id)
        ) {
          return response.status(400).json({ error: 'Every item must have a known menu item ID.' });
        }
        if (seenIds.has(item.id)) {
          return response.status(400).json({ error: 'Each menu item ID may appear only once.' });
        }
        if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
          return response.status(400).json({ error: 'Item quantities must be integers from 1 to 99.' });
        }

        seenIds.add(item.id);
        const dish = menuById.get(item.id);
        items.push({
          id: dish.id,
          name: dish.name,
          quantity: item.quantity,
          priceCents: dish.priceCents,
          lineTotalCents: dish.priceCents * item.quantity,
        });
      }

      response.status(201).json({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        currency: 'SGD',
        items,
        totalCents: items.reduce((total, item) => total + item.lineTotalCents, 0),
      });
    },
  );

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use(express.static(distDirectory));
  app.use((_request, response) => {
    response.status(404).json({ error: 'Page not found.' });
  });

  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'Request body exceeds the 10 KB limit.' });
    }
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
      return response.status(415).json({ error: 'Unsupported request body encoding.' });
    }
    if (error.status === 400) {
      return response.status(400).json({ error: 'Invalid request body.' });
    }
    response.status(500).json({ error: 'An unexpected server error occurred.' });
  });

  return app;
}

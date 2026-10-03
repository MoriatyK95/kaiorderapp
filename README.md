# KaiOrderApp

A minimal restaurant ordering demo built with React and Express, packaged in a single Docker container.

Choose from six fictional dishes, adjust quantities, and submit a demo order. Prices are in SGD. The server calculates each order from its own menu data and returns an order ID, timestamp, items, and total.

**Demo only. No payment is collected and no real order is placed.**

## Architecture

The React frontend uses Vite for development and builds to static files. Express serves the built frontend and `/api` endpoints from one HTTP or HTTPS port in production. During development, Vite proxies `/api` requests to Express; the frontend always uses relative API URLs.

```text
client/          React interface and styles
server/          Static menu, Express app, and separate server entry point
test/            API and server startup tests using Node's built-in test runner
dist/            Generated frontend build (not committed)
Dockerfile       Multi-stage build and non-root runtime
vite.config.js   Frontend build and development proxy configuration
```

There is no database, authentication, payment system, or external service. Orders are not stored. The cart and confirmation live in frontend memory and reset on refresh. HTTP is the default; optional HTTPS uses Node's built-in server with certificates supplied at runtime. No reverse proxy or cloud infrastructure is configured.

## Local setup

Use **Node.js 24.13 or newer** and npm. Run all commands from the project root.

```bash
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). This starts Vite and Express together; Express defaults to port 3000. Leave `TLS_CERT_PATH` and `TLS_KEY_PATH` unset for `npm run dev`, because Vite's development proxy uses HTTP.

For a production build and server:

```bash
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000). Build before starting the production server. Vite is not used to serve production traffic.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Application port for HTTP or HTTPS; the server listens on `0.0.0.0`. The development proxy uses this port too. |
| `NODE_ENV` | Unset locally; `production` in Docker | Node environment; the container runs in production mode. |
| `TLS_CERT_PATH` | Unset | Path to a PEM certificate chain; configure together with `TLS_KEY_PATH` to enable HTTPS. |
| `TLS_KEY_PATH` | Unset | Path to the matching, unencrypted PEM private key. |

Local commands load an optional `.env` file. Exported environment variables take precedence. To customize the port locally:

```bash
cp .env.example .env
# Edit PORT in .env, then run npm run dev or npm start.
```

Do not commit `.env` files or credentials. No credentials are needed by this application.

### Optional HTTPS

When both TLS variables are unset or empty, the server uses HTTP. When both have paths, it loads those files and starts HTTPS on the same `PORT` (default `3000`), listening on `0.0.0.0`. There is no additional HTTP listener or redirect. Startup logs identify the active protocol.

After building, start HTTPS using files supplied outside the project:

```bash
TLS_CERT_PATH=/absolute/path/to/certs/fullchain.pem \
TLS_KEY_PATH=/absolute/path/to/certs/privkey.pem \
npm start
```

Open `https://<certificate-hostname>:3000` using a hostname covered by the certificate. Configuring only one TLS variable, unreadable files, or invalid certificate/key material causes startup to fail with a non-zero exit code. The server never falls back to HTTP or prints certificate/key contents.

## Docker

With Docker available:

```bash
docker build -t kaiorderapp .
docker run --rm -p 3000:3000 kaiorderapp
```

Open [http://localhost:3000](http://localhost:3000). The multi-stage image builds the frontend, installs only production dependencies in the runtime image, and runs Express as the non-root `node` user. It runs one application container, with no development server.

To change the application port:

```bash
docker run --rm -e PORT=4000 -p 4000:4000 kaiorderapp
```

Pass container environment variables with `-e`; local `.env` files are not included in the image.

For standard host ports, HTTP uses `-p 80:3000`. HTTPS instead uses `-p 443:3000` with a read-only certificate directory mount:

```bash
docker run --rm -p 443:3000 \
  --mount type=bind,src=/absolute/path/to/certs,dst=/certs,readonly \
  -e TLS_CERT_PATH=/certs/fullchain.pem \
  -e TLS_KEY_PATH=/certs/privkey.pem \
  kaiorderapp
```

Supply the certificate chain and matching private key separately at runtime. Keep them outside the repository, Docker build context, frontend, and image. The non-root `node` user needs directory traversal and file-read permissions through suitable ownership, group permissions, or ACLs. Do not make private keys world-readable. If certificates use symlinks, their targets must also be accessible inside the mount.

Certificates are loaded once at startup. After renewal, make the updated files available through the mount and restart the application to load them; it does not obtain or renew certificates automatically.

## API

All endpoints return JSON. Prices and totals use integer cents; currency is `SGD`.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/menu` | Returns `{currency, items}` with six dishes, each containing `id`, `name`, and `priceCents`. |
| `POST /api/orders` | Accepts `{items: [{id, quantity}]}` and returns HTTP 201 with `id`, `timestamp`, `currency`, `items`, and `totalCents`. Returned items include server-owned names and prices, quantities, and `lineTotalCents`. |
| `GET /api/health` | Returns `{ "status": "ok" }`. |
| `GET /api/headers` | Returns received normalized `headers` and the `rawHeaders` list, which preserves duplicate entries. Sets `Cache-Control: no-store`. |
| `GET /api/rate-test` | Returns HTTP 200 with `{ "ok": true }` without creating orders or changing state. There is no application-side rate limiting. |

Orders must contain 1–6 distinct known item IDs, each with an integer quantity from 1–99. Duplicate IDs, unknown items, malformed bodies, and empty orders are rejected. Browser-supplied prices, names, and totals do not affect calculations. Each accepted order gets a generated ID and ISO timestamp, then is returned without being stored.

Requests to the order endpoint must use `Content-Type: application/json`; JSON bodies are limited to 10 KB. Errors use `{ "error": "..." }`: HTTP 400 for invalid input or JSON, 413 for oversized bodies, 415 for unsupported content types, and 500 for unexpected server errors. Unknown API routes return HTTP 404 JSON, not the frontend HTML.

```bash
curl http://localhost:3000/api/menu

curl http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"items":[{"id":"ginger-chicken","quantity":2},{"id":"sambal-tofu","quantity":1}]}'

curl http://localhost:3000/api/health

curl http://localhost:3000/api/rate-test
```

The example order totals 2530 cents (S$25.30).

### Request-header diagnostics

The header endpoint echoes **all actual received headers** in the response body. Do not test it with real credentials, session cookies, or sensitive tokens. The application does not log echoed headers.

```bash
curl http://localhost:3000/api/headers \
  -H "X-Demo-Message: Hello Kai"
```

Use `-i` to display response headers and check `Cache-Control: no-store`:

```bash
curl -i http://localhost:3000/api/headers \
  -H "X-Demo-Message: Hello Kai"
```

## Tests

```bash
npm test
```

API tests use Node's built-in test runner and HTTP facilities. They cover menu data, valid and invalid orders, server-calculated totals, ignored client prices, JSON errors, body limits, unknown API routes, custom and duplicate headers, `Cache-Control: no-store`, health, and the rate-test endpoint.

Server startup tests cover HTTP and HTTPS modes, invalid TLS configuration, environment loading, port validation, and graceful shutdown. HTTPS tests use the optional `openssl` executable to generate temporary test certificates outside the repository, trust them explicitly, and remove them afterward. Checks requiring unavailable OpenSSL or permission-testing support are reported as skipped.

For a manual ordering check, open the application, add dishes, adjust quantities, remove an item, and submit. Submission is disabled for an empty cart and while a request is pending. A successful response clears the cart and displays the returned order ID and total; a failed submission preserves the cart so it can be retried.

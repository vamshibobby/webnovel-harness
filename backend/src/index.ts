import { withModelPolicy } from './lib/modelPolicy.js';
import { loadDotEnv } from './lib/env.js';
loadDotEnv();

import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { listStyles } from './engine/styles.js';
import { localUser, type AuthEnv } from './lib/authMiddleware.js';
import { DATA_DIR } from './lib/localdb.js';
import { accountRoutes } from './routes/account.js';
import { bibleRoutes } from './routes/bible.js';
import { chapterRoutes } from './routes/chapters.js';
import { arcRoutes } from './routes/arcs.js';
import { namingRoutes } from './routes/naming.js';
import { designRoutes } from './routes/designs.js';
import { mapRoutes } from './routes/maps.js';
import { powerRoutes } from './routes/power.js';
import { novelRoutes } from './routes/novels.js';
import { vaultRoutes } from './routes/vault.js';

const app = new Hono<AuthEnv>();

app.use(logger());

// Generous next to a chapter prompt. Per-field caps live in lib/validate.ts.
app.use(
  '*',
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: 'Request body is too large' }, 413),
  })
);

// Local only: the Vite dev server and the server itself. Add more with
// EXTRA_CORS_ORIGINS=https://a.example,https://b.example.
app.use(
  '*',
  cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      ...(process.env.EXTRA_CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    ],
    allowHeaders: ['Content-Type', 'X-OpenRouter-Key', 'X-Vault-Token'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })
);

app.get('/health', (c) => c.json({ ok: true, dataDir: DATA_DIR, serverKey: !!process.env.OPENROUTER_API_KEY }));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve one file from `root`, refusing anything that normalizes outside it. */
function sendFile(root: string, rel: string): Response | null {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root) || !existsSync(file)) return null;
  try {
    return new Response(readFileSync(file), {
      headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' },
    });
  } catch {
    return null; // a directory, or unreadable
  }
}

// Cover images written by lib/covers.ts.
app.get('/files/covers/:name', (c) => {
  return sendFile(join(DATA_DIR, 'covers'), c.req.param('name')) ?? c.notFound();
});

const api = new Hono<AuthEnv>();
api.use('*', (_c, next) => withModelPolicy({}, next));
api.use('*', localUser);
// Registered before /novels so these cannot be captured as a novel id.
api.get('/styles', (c) => c.json(listStyles()));
api.route('/account', accountRoutes);
api.route('/vault', vaultRoutes);
api.route('/novels', novelRoutes);
api.route('/novels/:novelId/chapters', chapterRoutes);
api.route('/novels/:novelId/bible', bibleRoutes);
api.route('/novels/:novelId/designs', designRoutes);
api.route('/novels/:novelId/arcs', arcRoutes);
api.route('/novels/:novelId/naming', namingRoutes);
api.route('/novels/:novelId/maps', mapRoutes);
api.route('/novels/:novelId/power', powerRoutes);

app.route('/api', api);

// After `npm run build` in frontend/, the API server also serves the UI, so a
// single `npm start` is the whole app at http://localhost:8787.
const UI_DIR = resolve(process.env.UI_DIR || join(process.cwd(), '..', 'frontend', 'dist'));
if (existsSync(join(UI_DIR, 'index.html'))) {
  app.get('*', (c) => {
    const path = c.req.path === '/' ? '/index.html' : c.req.path;
    return sendFile(UI_DIR, path) ?? sendFile(UI_DIR, '/index.html') ?? c.notFound();
  });
}

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port, hostname: process.env.HOST || '127.0.0.1' }, (info) => {
  console.log(`novel harness API on http://localhost:${info.port}  (data: ${DATA_DIR})`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('no OPENROUTER_API_KEY in env — the UI will send your key from Settings');
  }
});

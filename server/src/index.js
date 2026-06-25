// server/src/index.js
// Cloudflare Worker entry point — Hono router with CORS and auth middleware.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyToken, handleAuthRequest, handleAuthVerify } from './auth.js';
import { handleAnalyze } from './analyze.js';
import { handleTranslate } from './translate.js';
import {
  handleVocabGet, handleVocabPut,
  handleSettingsGet, handleSettingsPut,
  handleProfileGet, handleProfilePut,
} from './vocab.js';

const app = new Hono();

// ── CORS ──────────────────────────────────────────────────────────────────
// Allow Chrome/Firefox extension origins + local dev.
// Update to add your web app domain when Phase 4 is live.
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*';                           // wrangler dev / curl
    if (origin.startsWith('chrome-extension://')) return origin;
    if (origin.startsWith('moz-extension://'))   return origin;
    if (origin === 'http://localhost:3000')       return origin;
    return null; // Block all other origins
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ service: 'Smart Translation API', version: '1.0.0' }));

// ── Public auth routes ────────────────────────────────────────────────────
app.post('/v1/auth/request', (c) => handleAuthRequest(c.req.raw, c.env));
app.post('/v1/auth/verify',  (c) => handleAuthVerify(c.req.raw, c.env));

// ── Auth middleware (all /v1/* except /v1/auth/*) ─────────────────────────
app.use('/v1/*', async (c, next) => {
  if (c.req.path.startsWith('/v1/auth/')) return next();

  const userId = await verifyToken(c.req.header('Authorization'), c.env.DB);
  if (!userId) {
    return c.json({ error: 'Unauthorized — provide a valid Bearer token' }, 401);
  }
  c.set('userId', userId);
  return next();
});

// ── AI proxy routes ────────────────────────────────────────────────────────
app.post('/v1/analyze',   (c) => handleAnalyze(c.req.raw, c.env, c.get('userId')));
app.post('/v1/translate', (c) => handleTranslate(c.req.raw, c.env, c.get('userId')));

// ── Sync routes ────────────────────────────────────────────────────────────
app.get('/v1/vocab',    (c) => handleVocabGet(c.env, c.get('userId')));
app.put('/v1/vocab',    (c) => handleVocabPut(c.req.raw, c.env, c.get('userId')));

app.get('/v1/settings', (c) => handleSettingsGet(c.env, c.get('userId')));
app.put('/v1/settings', (c) => handleSettingsPut(c.req.raw, c.env, c.get('userId')));

app.get('/v1/profile',  (c) => handleProfileGet(c.env, c.get('userId')));
app.put('/v1/profile',  (c) => handleProfilePut(c.req.raw, c.env, c.get('userId')));

// ── 404 ────────────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;

// server/src/index.js
// Cloudflare Worker entry point — Hono router with CORS and auth middleware.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyToken, handleAuthRequest, handleAuthVerify } from './auth.js';
import { handleAnalyze, handleAnalyzeFast, handleAnalyzeTranslate } from './analyze.js';
import { handleTranslate } from './translate.js';
import {
  handleVocabGet, handleVocabPut,
  handleVocabWordPost,
  handleSettingsGet, handleSettingsPut,
  handleProfileGet, handleProfilePut,
} from './vocab.js';
import {
  handleBillingCheckout, handleBillingOrderGet, handleBillingStatus, handleSepayWebhook,
} from './billing.js';

const app = new Hono();

// ── CORS ──────────────────────────────────────────────────────────────────
// Allow Chrome/Firefox extension origins + local dev.
// Update to add your web app domain when Phase 4 is live.
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return '*';                           // Electron (file://) / curl
    if (origin === 'null') return '*';                 // WKWebView opaque origin (Tauri custom scheme edge case)
    if (origin.startsWith('chrome-extension://')) return origin;
    if (origin.startsWith('moz-extension://'))   return origin;
    if (origin === 'tauri://localhost')           return origin; // Tauri prod — macOS/Linux
    if (origin === 'http://tauri.localhost')      return origin; // Tauri prod — Windows (WebView2 uses http)
    if (origin === 'https://tauri.localhost')     return origin;
    // Local dev: web app (:3000) AND Tauri's built-in dev server, which serves
    // a static frontendDist from 127.0.0.1:<port> during `tauri dev`
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return null; // Block all other origins
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (c) => c.json({ service: 'Semantica API', version: '1.0.0' }));

// ── Public auth routes ────────────────────────────────────────────────────
app.post('/v1/auth/request', (c) => handleAuthRequest(c.req.raw, c.env));
app.post('/v1/auth/verify',  (c) => handleAuthVerify(c.req.raw, c.env));

// ── SePay webhook ─────────────────────────────────────────────────────────
// Called by SePay's servers, not an app user — deliberately OUTSIDE the
// /v1/* Bearer-auth middleware below. Authenticated instead by a static
// `Authorization: Apikey <SEPAY_WEBHOOK_KEY>` header checked inside the
// handler (must match what's configured in the SePay dashboard's webhook
// Security step). See server/src/billing.js.
app.post('/webhooks/sepay', (c) => handleSepayWebhook(c.req.raw, c.env));

// ── Auth middleware (all /v1/* except /v1/auth/*) ─────────────────────────
app.use('/v1/*', async (c, next) => {
  if (c.req.path.startsWith('/v1/auth/')) return next();

  const auth = await verifyToken(c.req.header('Authorization'), c.env.DB);
  if (!auth) {
    return c.json({ error: 'Unauthorized — provide a valid Bearer token' }, 401);
  }
  c.set('userId', auth.userId);
  c.set('isPro', auth.isPro);
  c.set('planExpiresAt', auth.planExpiresAt);
  return next();
});

// ── AI proxy routes ────────────────────────────────────────────────────────
app.post('/v1/analyze',            (c) => handleAnalyze(c.req.raw, c.env, c.get('userId'), c.get('isPro')));
// Two-step variant of /v1/analyze for progressive rendering (translate popup):
// fast = Phase 1 (English content) only; translate = Phase 2 (translation)
// patched in after. See server/src/analyze.js for the shared pipeline.
app.post('/v1/analyze/fast',       (c) => handleAnalyzeFast(c.req.raw, c.env, c.get('userId'), c.get('isPro')));
app.post('/v1/analyze/translate',  (c) => handleAnalyzeTranslate(c.req.raw, c.env, c.get('userId'), c.get('isPro')));
app.post('/v1/translate',          (c) => handleTranslate(c.req.raw, c.env, c.get('userId'), c.get('isPro')));

// ── Billing routes (SePay) ──────────────────────────────────────────────────
app.post('/v1/billing/checkout',   (c) => handleBillingCheckout(c.req.raw, c.env, c.get('userId')));
app.get('/v1/billing/order/:id',   (c) => handleBillingOrderGet(c.env, c.get('userId'), c.req.param('id')));
app.get('/v1/billing/status',      (c) => handleBillingStatus(c.get('isPro'), c.get('planExpiresAt')));

// ── Sync routes ────────────────────────────────────────────────────────────
app.get('/v1/vocab',       (c) => handleVocabGet(c.env, c.get('userId')));
app.put('/v1/vocab',       (c) => handleVocabPut(c.req.raw, c.env, c.get('userId')));
app.post('/v1/vocab/word', (c) => handleVocabWordPost(c.req.raw, c.env, c.get('userId')));

app.get('/v1/settings', (c) => handleSettingsGet(c.env, c.get('userId')));
app.put('/v1/settings', (c) => handleSettingsPut(c.req.raw, c.env, c.get('userId')));

app.get('/v1/profile',  (c) => handleProfileGet(c.env, c.get('userId')));
app.put('/v1/profile',  (c) => handleProfilePut(c.req.raw, c.env, c.get('userId')));

// ── 404 ────────────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ── Error handler ──────────────────────────────────────────────────────────
// Without this, an uncaught exception returns Hono's default PLAIN-TEXT 500 —
// clients calling res.json() then fail with a cryptic parse error instead of
// seeing what actually broke.
app.onError((err, c) => c.json({ error: `Server error: ${err.message}` }, 500));

export default app;

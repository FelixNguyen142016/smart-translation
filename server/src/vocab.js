// server/src/vocab.js
// Vocabulary, settings, and profile sync endpoints.
// Last-write-wins model (v1 — YAGNI on CRDT).

// ── Vocabulary ─────────────────────────────────────────────────────────────

/** GET /v1/vocab */
export async function handleVocabGet(env, userId) {
  const row = await env.DB.prepare(
    'SELECT data_json, updated_at FROM vocab WHERE user_id = ?'
  ).bind(userId).first();

  return okResponse({
    data: JSON.parse(row?.data_json || '[]'),
    updatedAt: row?.updated_at || 0,
  });
}

/** PUT /v1/vocab — replace entire vocab array */
export async function handleVocabPut(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON', 400);
  }

  if (!Array.isArray(body?.data)) return errResponse('Missing data array', 400);

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO vocab (user_id, data_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).bind(userId, JSON.stringify(body.data), now).run();

  return okResponse({ ok: true, updatedAt: now });
}

/**
 * POST /v1/vocab/word — append a single word record server-side.
 * Replaces the client's GET-full-list → mutate → PUT-full-list dance for
 * single saves (popup): the read-modify-write happens in one request here,
 * so a save can no longer clobber a concurrent full-list write from the
 * dashboard with a stale copy, and the request payload stays one record
 * instead of the entire vocabulary.
 * Dedupes (case-insensitive) against both the record's `text` and its
 * `aiAnalysis.baseForm`, mirroring the popup's old client-side check.
 * Returns { ok, added, updatedAt } — added: false means it already existed.
 */
export async function handleVocabWordPost(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON', 400);
  }

  const record = body?.record;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.text !== 'string' || !record.text.trim()) {
    return errResponse('Missing record with non-empty text', 400);
  }

  const row = await env.DB.prepare(
    'SELECT data_json FROM vocab WHERE user_id = ?'
  ).bind(userId).first();
  const words = JSON.parse(row?.data_json || '[]');

  const textLower = record.text.trim().toLowerCase();
  const baseLower = String(record.aiAnalysis?.baseForm || record.text).trim().toLowerCase();
  const exists = words.some(w => {
    const t = typeof w?.text === 'string' ? w.text.toLowerCase() : null;
    return t === textLower || t === baseLower;
  });

  if (exists) {
    return okResponse({ ok: true, added: false });
  }

  const now = Math.floor(Date.now() / 1000);
  words.unshift(record); // newest first, matching the dashboard's ordering
  await env.DB.prepare(
    `INSERT INTO vocab (user_id, data_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).bind(userId, JSON.stringify(words), now).run();

  return okResponse({ ok: true, added: true, updatedAt: now });
}

// ── Settings ───────────────────────────────────────────────────────────────

/** GET /v1/settings */
export async function handleSettingsGet(env, userId) {
  const row = await env.DB.prepare(
    'SELECT data_json FROM user_settings WHERE user_id = ?'
  ).bind(userId).first();
  return okResponse(JSON.parse(row?.data_json || '{}'));
}

/** PUT /v1/settings — replace settings object */
export async function handleSettingsPut(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errResponse('Settings must be a JSON object', 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, data_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).bind(userId, JSON.stringify(body), now).run();

  return okResponse({ ok: true });
}

// ── Profile ────────────────────────────────────────────────────────────────

/** GET /v1/profile */
export async function handleProfileGet(env, userId) {
  const row = await env.DB.prepare(
    'SELECT data_json FROM user_profile WHERE user_id = ?'
  ).bind(userId).first();
  return okResponse(JSON.parse(row?.data_json || '{}'));
}

/** PUT /v1/profile — replace profile object */
export async function handleProfilePut(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errResponse('Profile must be a JSON object', 400);
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO user_profile (user_id, data_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).bind(userId, JSON.stringify(body), now).run();

  return okResponse({ ok: true });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function okResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function errResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

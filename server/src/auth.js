// server/src/auth.js
// POST /v1/auth/request — send 6-digit code to email via Resend
// POST /v1/auth/verify  — verify code, issue opaque bearer token
// verifyToken()         — middleware helper: header → userId

const CODE_TTL_SECONDS = 600; // 10 minutes

// ── Public handlers ────────────────────────────────────────────────────────

/**
 * POST /v1/auth/request
 * Body: { email: string }
 */
export async function handleAuthRequest(req, env) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON', 400);
  }

  const email = body?.email?.trim().toLowerCase();
  if (!email || !_isValidEmail(email)) return errResponse('Invalid email', 400);

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
  const codeHash = await _sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS;

  // Upsert — one active code per email at a time
  await env.DB.prepare(
    `INSERT INTO auth_codes (email, code_hash, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`
  ).bind(email, codeHash, expiresAt).run();

  await _sendEmail(env.RESEND_KEY, email, code);

  return okResponse({ message: 'Code sent. Check your email.' });
}

/**
 * POST /v1/auth/verify
 * Body: { email: string, code: string }
 */
export async function handleAuthVerify(req, env) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON', 400);
  }

  const email = body?.email?.trim().toLowerCase();
  const code  = body?.code?.trim();
  if (!email || !code) return errResponse('Missing email or code', 400);

  const row = await env.DB.prepare(
    'SELECT code_hash, expires_at FROM auth_codes WHERE email = ?'
  ).bind(email).first();

  if (!row) return errResponse('No code found — request a new one', 401);

  if (Math.floor(Date.now() / 1000) > row.expires_at) {
    return errResponse('Code expired — request a new one', 401);
  }

  const inputHash = await _sha256(code);
  if (inputHash !== row.code_hash) return errResponse('Incorrect code', 401);

  // One-time use — delete immediately
  await env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(email).run();

  // Get or create user
  let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(id, email).run();
    user = { id };
  }

  // Issue opaque token — store hash only
  const token = _generateToken();
  const tokenHash = await _sha256(token);
  await env.DB.prepare('UPDATE users SET token_hash = ? WHERE id = ?').bind(tokenHash, user.id).run();

  return okResponse({ token, userId: user.id });
}

/**
 * Verify a bearer token from an Authorization header.
 * Returns userId string or null.
 * @param {string|null} authHeader
 * @param {D1Database} db
 */
export async function verifyToken(authHeader, db) {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) return null;

  const tokenHash = await _sha256(token);
  const user = await db.prepare('SELECT id FROM users WHERE token_hash = ?').bind(tokenHash).first();
  return user?.id || null;
}

// ── Private helpers ────────────────────────────────────────────────────────

function _generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function _sendEmail(resendKey, to, code) {
  // Dev mode: no key → log to Worker console (visible in wrangler dev output)
  if (!resendKey) {
    console.error(`[DEV] Auth code for ${to}: ${code}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Semantica <send@mysemantica.com>',
      to: [to],
      subject: 'Your Semantica login code',
      text: `Your login code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Email delivery failed (Resend ${res.status}): ${body}`);
  }
}

function _isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function errResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

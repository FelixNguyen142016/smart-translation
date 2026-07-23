// renderer/api.js
// API client for VocabAI backend + in-memory word cache

const BACKEND_URL = 'https://smart-translation-api.fukumakino613.workers.dev';

// ─── In-memory cache ──────────────────────────────────────────────────────────
let _wordCache = [];
let _cacheLoaded = false;

function getToken() {
  return localStorage.getItem('cloud_auth_token') || null;
}

function getEmail() {
  return localStorage.getItem('cloud_user_email') || null;
}

function authHeaders() {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// ─── Vocab ────────────────────────────────────────────────────────────────────

/**
 * Load vocabulary from backend into the in-memory cache.
 * Must be called on startup (and after sync).
 */
export async function loadVocab() {
  const token = getToken();
  if (!token) {
    _wordCache = [];
    _cacheLoaded = true;
    return [];
  }
  try {
    const res = await fetch(`${BACKEND_URL}/v1/vocab`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    _wordCache = Array.isArray(json.data) ? json.data : [];
    _cacheLoaded = true;
    return _wordCache;
  } catch (err) {
    console.error('VocabAI: failed to load vocab', err);
    _cacheLoaded = true;
    return _wordCache;
  }
}

/** Return cached words (instant, no network) */
export function getCachedWords() {
  return _wordCache;
}

/** Push the full word cache to the backend */
async function pushVocab() {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${BACKEND_URL}/v1/vocab`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ data: _wordCache }),
    });
  } catch (err) {
    console.error('VocabAI: failed to push vocab', err);
  }
}

/** Add a word to cache and persist */
export async function apiSaveWord(record) {
  const exists = _wordCache.some(w => w.text.toLowerCase() === record.text.toLowerCase());
  if (!exists) {
    _wordCache = [record, ..._wordCache];
    await pushVocab();
  }
}

/**
 * Bulk-import word records: dedupe against the cache, prepend, persist once.
 * @param {Array<Object>} records - sanitized word records
 * @returns {{ added: number, skipped: number }}
 */
export async function apiImportWords(records) {
  const existing = new Set(_wordCache.map(w => w.text.toLowerCase()));
  const fresh = [];
  for (const r of records) {
    const key = r.text.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key); // also dedupes within the imported file
    fresh.push(r);
  }
  if (fresh.length) {
    _wordCache = [...fresh, ..._wordCache];
    await pushVocab(); // single network write for the whole import
  }
  return { added: fresh.length, skipped: records.length - fresh.length };
}

/** Update a word in cache and persist */
export async function apiUpdateWord(text, updates) {
  const idx = _wordCache.findIndex(w => w.text.toLowerCase() === text.toLowerCase());
  if (idx !== -1) {
    _wordCache[idx] = { ..._wordCache[idx], ...updates };
    await pushVocab();
  }
}

/** Delete a word from cache and persist */
export async function apiDeleteWord(text) {
  _wordCache = _wordCache.filter(w => w.text.toLowerCase() !== text.toLowerCase());
  await pushVocab();
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function apiGetSettings() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/v1/settings`, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiSaveSettings(settings) {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${BACKEND_URL}/v1/settings`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(settings),
    });
  } catch (err) {
    console.error('VocabAI: failed to save settings', err);
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export async function apiGetProfile() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/v1/profile`, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiSaveProfile(profile) {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${BACKEND_URL}/v1/profile`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(profile),
    });
  } catch (err) {
    console.error('VocabAI: failed to save profile', err);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function apiRequestCode(email) {
  const res = await fetch(`${BACKEND_URL}/v1/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to send code.');
  return data;
}

export async function apiVerifyCode(email, code) {
  const res = await fetch(`${BACKEND_URL}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Incorrect or expired code.');
  return data; // { token, userId }
}

// ─── Analyze ──────────────────────────────────────────────────────────────────

export async function apiAnalyzeText(text, context, targetLanguage) {
  const token = getToken();
  const res = await fetch(`${BACKEND_URL}/v1/analyze`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ text, context, targetLanguage }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Analysis failed.');
  return data;
}

// ─── Billing (SePay) ────────────────────────────────────────────────────────

/** Create a pending checkout order and get back a VietQR image URL. */
export async function apiCreateCheckout(plan) {
  const res = await fetch(`${BACKEND_URL}/v1/billing/checkout`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not start checkout.');
  return data; // { orderId, plan, label, amount, bankAccount, bankName, transferContent, qrUrl }
}

/** Current plan status for the logged-in user — { isPro, planExpiresAt }. */
export async function apiGetBillingStatus() {
  const res = await fetch(`${BACKEND_URL}/v1/billing/status`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not check plan status.');
  return data;
}

/** Poll an order's status — 'pending' until the SePay webhook confirms it, then 'paid'. */
export async function apiGetOrder(orderId) {
  const res = await fetch(`${BACKEND_URL}/v1/billing/order/${encodeURIComponent(orderId)}`, {
    headers: authHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not check order status.');
  return data; // { id, plan, amount, status, created_at, paid_at }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

export function setAuthSession(token, email) {
  localStorage.setItem('cloud_auth_token', token);
  if (email) localStorage.setItem('cloud_user_email', email);
}

export function clearAuthSession() {
  localStorage.removeItem('cloud_auth_token');
  localStorage.removeItem('cloud_user_email');
}

export function isLoggedIn() {
  return !!getToken();
}

export { getToken, getEmail, BACKEND_URL };

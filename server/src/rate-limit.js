// server/src/rate-limit.js
// KV-based rate limiter. Key format: rl_{type}_{userId}_{yyyymmdd}
// TTL auto-resets at midnight UTC. Tolerates rare double-counts on race conditions (acceptable for v1).

/** Daily limits per user */
const LIMITS = {
  analyze:   50,   // /v1/analyze
  translate: 200,  // /v1/translate
};

/**
 * Check and increment rate limit counter.
 * @param {KVNamespace} kv
 * @param {string} userId
 * @param {'analyze'|'translate'} type
 * @returns {{ allowed: boolean, remaining: number, limit: number }}
 */
export async function checkRateLimit(kv, userId, type) {
  const limit = LIMITS[type];
  if (!limit) return { allowed: true, remaining: 999, limit: 999 };

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // yyyymmdd
  const key = `rl_${type}_${userId}_${date}`;

  // Seconds until next midnight UTC
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  // Cloudflare KV requires expirationTtl >= 60 — a smaller value makes kv.put
  // THROW, crashing every request in the last minute before midnight UTC
  const ttl = Math.max(60, Math.floor((midnight - now) / 1000));

  // KV enforces hard caps that are easy to hit here: max 1 write/sec to the
  // SAME key (both plans — two concurrent requests for the same user racing
  // on this key will trip it), and on the free plan, max 1,000 writes/day to
  // DIFFERENT keys account-wide (a large one-off bulk upload, e.g. the IPA
  // dataset, can exhaust that instantly for the rest of the day). Either one
  // throws from kv.get/kv.put. Rate limiting is a soft cost control, not a
  // security boundary, so on any KV failure we fail OPEN (allow the request)
  // rather than 500 the whole feature — logged so it's still visible.
  let current = 0;
  try {
    current = parseInt((await kv.get(key)) || '0', 10);
  } catch (err) {
    console.error(`Rate limit KV read failed for ${key}: ${err?.message || err} — failing open`);
    return { allowed: true, remaining: -1, limit };
  }

  if (current >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  try {
    await kv.put(key, String(current + 1), { expirationTtl: ttl });
  } catch (err) {
    console.error(`Rate limit KV write failed for ${key}: ${err?.message || err} — failing open`);
  }
  return { allowed: true, remaining: limit - current - 1, limit };
}

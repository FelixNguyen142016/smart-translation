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
  const ttl = Math.max(1, Math.floor((midnight - now) / 1000));

  const current = parseInt((await kv.get(key)) || '0', 10);

  if (current >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  await kv.put(key, String(current + 1), { expirationTtl: ttl });
  return { allowed: true, remaining: limit - current - 1, limit };
}

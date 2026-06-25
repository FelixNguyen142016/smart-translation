// utils/api-storage-adapter.js
// StorageAdapter implementation backed by the Cloudflare Worker API.
// Active when the user is logged in (cloud sync enabled).
//
// Strategy:
//   READS  → local Chrome adapter (fast, offline-safe)
//   WRITES → local first, then push relevant keys to cloud (write-through)
//   SYNC   → call syncFromCloud() on dashboard focus to pull latest from server

import { getBackendUrl } from './api-config.js';
import { createChromeAdapter } from './chrome-storage-adapter.js';

const LOCAL = createChromeAdapter();

/**
 * Create the API storage adapter.
 * @param {string} token  Bearer token from login
 * @returns {import('./storage-adapter.js').StorageAdapter & { syncFromCloud: () => Promise<void> }}
 */
export function createApiAdapter(token) {
  const base = getBackendUrl();

  async function apiFetch(path, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== null) opts.body = JSON.stringify(body);

    const res = await fetch(`${base}${path}`, opts);
    if (!res.ok) throw new Error(`API ${method} ${path}: ${res.status}`);
    return res.json();
  }

  return {
    // ── Reads: always from local for speed and offline support ─────────────

    get: (key) => LOCAL.get(key),
    getMany: (keys) => LOCAL.getMany(keys),
    getAll: () => LOCAL.getAll(),

    // ── Writes: local first, push relevant stores to cloud ─────────────────

    async set(obj) {
      await LOCAL.set(obj);

      // Push each recognised store to the API (fire-and-forget; failures are silent)
      if ('vocabulary_list' in obj) {
        apiFetch('/v1/vocab', 'PUT', { data: obj.vocabulary_list }).catch(() => {});
      }
      if ('extension_settings' in obj) {
        apiFetch('/v1/settings', 'PUT', obj.extension_settings).catch(() => {});
      }
      if ('user_profile' in obj) {
        apiFetch('/v1/profile', 'PUT', obj.user_profile).catch(() => {});
      }
    },

    remove: (keys) => LOCAL.remove(keys),

    // ── Pull latest from cloud (call on dashboard focus) ───────────────────

    async syncFromCloud() {
      try {
        const [vocabRes, settingsRes, profileRes] = await Promise.allSettled([
          apiFetch('/v1/vocab'),
          apiFetch('/v1/settings'),
          apiFetch('/v1/profile'),
        ]);

        const toSet = {};

        if (vocabRes.status === 'fulfilled') {
          const cloudVocab = vocabRes.value.data || [];
          // MERGE instead of replace: union cloud + local, deduped by word text.
          // Local always wins for the same word (background.js writes local first).
          // Never overwrite local with empty cloud data (prevents blank list on first sync).
          if (cloudVocab.length > 0) {
            const localVocab = (await LOCAL.get('vocabulary_list')) || [];
            const localTexts = new Set(localVocab.map(w => w.text?.toLowerCase()));
            const merged = [...localVocab];
            cloudVocab.forEach(w => {
              if (w.text && !localTexts.has(w.text.toLowerCase())) merged.push(w);
            });
            toSet.vocabulary_list = merged;
          }
          // cloud empty → skip (don't wipe local words saved offline)
        }

        if (settingsRes.status === 'fulfilled' && Object.keys(settingsRes.value).length > 0) {
          toSet.extension_settings = settingsRes.value;
        }
        if (profileRes.status === 'fulfilled' && Object.keys(profileRes.value).length > 0) {
          toSet.user_profile = profileRes.value;
        }

        if (Object.keys(toSet).length > 0) await LOCAL.set(toSet);
      } catch {
        // Silent — offline is fine, reads still go to local cache
      }
    },

    // ── Change notifications: delegate to local adapter ────────────────────
    // Local writes fire this, keeping UI reactive. Cloud writes are pulled on next sync.

    onChanged: (cb) => LOCAL.onChanged(cb),
  };
}

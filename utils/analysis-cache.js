// utils/analysis-cache.js
// Persisted cache for word analysis results (separate from vocabulary_list).
// Prevents redundant API calls for words that have been looked up but not saved.
//
// Storage format: one key per word+language — 'wac_{word}_{lang}' — so each
// read/write only serializes a single entry. Language is included in the key
// so changing Spanish→French fetches fresh results instead of returning stale ones.

import { getAdapter } from './storage-adapter.js';

const CACHE_PREFIX = 'wac_';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

/**
 * Build a cache key that includes both word and target language.
 * @param {string} word
 * @param {string} targetLanguage
 * @returns {string}
 */
const _cacheKey = (word, targetLanguage) =>
  `${CACHE_PREFIX}${word.toLowerCase()}_${targetLanguage.toLowerCase()}`;

/**
 * Retrieve a cached analysis for a word+language pair.
 * Returns null if missing or expired.
 * @param {string} word
 * @param {string} targetLanguage
 * @returns {Promise<object|null>}
 */
export async function getCachedAnalysis(word, targetLanguage) {
  const key = _cacheKey(word, targetLanguage);
  const entry = await getAdapter().get(key);
  if (!entry || Date.now() - entry.timestamp > CACHE_TTL) return null;
  return entry.analysis;
}

/**
 * Store an analysis result for a word+language pair with current timestamp.
 * Zero overhead in the normal case — only runs cleanup if storage throws a
 * quota error, then retries once. Vocabulary saves are never crowded out.
 * @param {string} word
 * @param {object} analysis
 * @param {string} targetLanguage
 */
export async function setCachedAnalysis(word, analysis, targetLanguage) {
  const key = _cacheKey(word, targetLanguage);
  const entry = { analysis, timestamp: Date.now() };
  try {
    await getAdapter().set({ [key]: entry });
  } catch (err) {
    if (err?.message?.includes('QUOTA_BYTES')) {
      await _cleanExpiredCache();
      // Retry once after cleanup — if still full, skip silently
      try { await getAdapter().set({ [key]: entry }); } catch { /* skip */ }
    }
  }
}

async function _cleanExpiredCache() {
  const all = await getAdapter().getAll();
  const expiredKeys = Object.keys(all).filter(k =>
    k.startsWith(CACHE_PREFIX) &&
    (!all[k] || Date.now() - all[k].timestamp > CACHE_TTL)
  );
  if (expiredKeys.length) await getAdapter().remove(expiredKeys);
  return expiredKeys.length;
}

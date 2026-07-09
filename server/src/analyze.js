// server/src/analyze.js
// POST /v1/analyze — Claude Haiku 4.5 (definition) + DeepL (translation) in parallel, KV cached.
// Response shape is identical to analyzeWithPerplexity in the extension's ai-service.js.
//
// Also exposes the same pipeline split into two steps for callers that want to
// render progressively instead of waiting for both phases (see popup.js):
//   POST /v1/analyze/fast      — Phase 1 only (English content), fast
//   POST /v1/analyze/translate — Phase 2 only (translation), patches in after
// All three share the same _getOrBuildEnglishContent / _applyTranslation
// helpers and the same two-tier cache, so a lookup started on one endpoint
// benefits every other endpoint that touches the same word.

import { systemPrompt, userMessage } from './prompts.js';
import { checkRateLimit } from './rate-limit.js';

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// DeepL target language codes. Vietnamese became a supported DeepL target in
// June 2025 — critical for Semantica, which is fixed to English → Vietnamese.
const DEEPL_LANG_CODES = {
  Vietnamese: 'VI',
  Spanish: 'ES', French: 'FR', German: 'DE', Italian: 'IT', Portuguese: 'PT',
  Japanese: 'JA', Chinese: 'ZH', Korean: 'KO', Dutch: 'NL', Polish: 'PL',
  Russian: 'RU', Turkish: 'TR', Swedish: 'SV', Norwegian: 'NB', Danish: 'DA',
  Indonesian: 'ID', Ukrainian: 'UK', Czech: 'CS', Romanian: 'RO', Hungarian: 'HU',
};

/** Full, per-language cache key — both phases done. */
function fullCacheKey(text, targetLanguage) {
  return `wac_${text.toLowerCase().trim()}_${targetLanguage.toLowerCase()}`;
}

/** English-only cache key — language-independent, since Claude's output never varies by target language. */
function englishCacheKey(text) {
  return `wac_en_${text.toLowerCase().trim()}`;
}

/**
 * Phase 1: Claude (English definition/POS/example/tags/topics) + Google TTS +
 * Datamuse synonyms + IPA, all in parallel. Cached under a language-independent
 * key so any target language benefits from one word ever being looked up once.
 * Throws on Claude failure — callers convert that into an error response.
 * @param {string} text
 * @param {string} context
 * @param {{ CACHE: KVNamespace, ANTHROPIC_KEY: string, GOOGLE_TTS_KEY: string }} env
 */
async function _getOrBuildEnglishContent(text, context, env) {
  const enKey = englishCacheKey(text);
  try {
    const cachedEn = await env.CACHE.get(enKey, 'json');
    if (cachedEn) return cachedEn;
  } catch (err) {
    console.error(`English-content cache read failed for ${enKey}: ${err?.message || err}`);
  }

  const [claudeResult, ttsResult, synResult, ipaResult] = await Promise.allSettled([
    _callClaude(text, context, env.ANTHROPIC_KEY),
    _callGoogleTTS(text, env.GOOGLE_TTS_KEY),
    _callDatamuse(text),
    _getIPA(env.CACHE, text),
  ]);

  if (claudeResult.status === 'rejected') {
    throw new Error(claudeResult.reason?.message || 'Claude call failed');
  }

  const analysis = claudeResult.value;

  // IPA from the bundled dataset (silent blank if the word isn't in it)
  analysis.pronunciation =
    (ipaResult.status === 'fulfilled' && ipaResult.value) || analysis.pronunciation || '';

  // Synonyms from Datamuse (free, no key)
  analysis.synonyms =
    (synResult.status === 'fulfilled' && synResult.value?.length) ? synResult.value : [];

  // Attach audio if TTS succeeded (silent fallback if key missing or API error)
  if (ttsResult.status === 'fulfilled' && ttsResult.value) {
    analysis.audioBase64 = ttsResult.value;
  }

  try {
    await env.CACHE.put(enKey, JSON.stringify(analysis), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error(`English-content cache write failed for ${enKey}: ${err?.message || err}`);
  }

  return analysis;
}

/**
 * Phase 2: translate word + definition + example via DeepL (Claude fallback
 * if DeepL fails/rejects the language). Mutates and returns `analysis` with
 * translation, definitionTranslated, exampleSentenceTranslated, and source set.
 * @param {object} analysis - English content from _getOrBuildEnglishContent
 * @param {string} text
 * @param {string} targetLanguage
 * @param {{ ANTHROPIC_KEY: string, DEEPL_KEY: string }} env
 */
async function _applyTranslation(analysis, text, targetLanguage, env) {
  const toTranslate = [text.trim(), analysis.definition || '', analysis.exampleSentence || ''];
  let translated = await _callDeepLTexts(toTranslate, targetLanguage, env.DEEPL_KEY);

  // Vietnamese runs on DeepL's next-gen model, which some plans/keys reject —
  // fall back to a tiny Claude translation call so users never get English-only
  if (!translated) {
    translated = await _claudeTranslateFallback(toTranslate, targetLanguage, env.ANTHROPIC_KEY);
  }
  analysis.translation               = translated?.[0] || analysis.translation || '';
  analysis.definitionTranslated      = translated?.[1] || '';
  analysis.exampleSentenceTranslated = translated?.[2] || '';
  analysis.source = 'Claude Haiku (EN) + DeepL + Google TTS';

  return analysis;
}

/**
 * @param {Request} req
 * @param {{ DB: D1Database, CACHE: KVNamespace, ANTHROPIC_KEY: string, DEEPL_KEY: string }} env
 * @param {string} userId
 */
export async function handleAnalyze(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON body', 400);
  }

  const { text, context = '', targetLanguage = 'Spanish' } = body || {};
  if (!text?.trim()) return errResponse('Missing text', 400);

  // ── SUBSCRIPTION CHECK ──────────────────────────────────────────────────
  // Uncomment the block below when launching the paid tier.
  // Default is_subscribed = 1 in schema, so all users pass during testing.
  //
  // const user = await env.DB.prepare('SELECT is_subscribed FROM users WHERE id = ?').bind(userId).first();
  // if (!user?.is_subscribed) {
  //   return new Response(
  //     JSON.stringify({ error: 'Subscription required', code: 'SUBSCRIPTION_REQUIRED' }),
  //     { status: 402, headers: { 'Content-Type': 'application/json' } }
  //   );
  // }
  // ────────────────────────────────────────────────────────────────────────

  // Rate limit check
  const rl = await checkRateLimit(env.CACHE, userId, 'analyze');
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'Daily analysis limit reached', limit: rl.limit }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '0' } }
    );
  }

  const rlHeaders = {
    'Content-Type': 'application/json',
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Limit': String(rl.limit),
  };

  // KV cache lookup — key matches client-side analysis-cache.js pattern.
  // A KV outage here (e.g. daily different-key write quota exhausted on the
  // free plan, or a transient read error) should degrade to a cache miss —
  // not break the whole lookup — since the analysis pipeline still works fine.
  const cacheKey = fullCacheKey(text, targetLanguage);
  let cached = null;
  try {
    cached = await env.CACHE.get(cacheKey, 'json');
  } catch (err) {
    console.error(`Analysis cache read failed for ${cacheKey}: ${err?.message || err}`);
  }
  if (cached) {
    return new Response(JSON.stringify({ ...cached, cached: true }), { headers: rlHeaders });
  }

  let analysis;
  try {
    analysis = await _getOrBuildEnglishContent(text, context, env);
  } catch (err) {
    return errResponse(`Analysis failed: ${err.message}`, 502);
  }

  await _applyTranslation(analysis, text, targetLanguage, env);

  // Cache result. A write failure here (KV quota/rate limit) must not turn an
  // already-successful analysis into a 500 — the user still gets their result,
  // they just won't get a cached instant-hit next time.
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(analysis), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error(`Analysis cache write failed for ${cacheKey}: ${err?.message || err}`);
  }

  return new Response(JSON.stringify(analysis), { headers: rlHeaders });
}

/**
 * POST /v1/analyze/fast — Phase 1 only. Returns English content (definition,
 * POS, phonetic, example, synonyms, audio) without waiting for translation.
 * `complete: true` means the full per-language result was already cached —
 * the caller can skip calling /v1/analyze/translate entirely.
 * `complete: false` means translation is not included yet; call
 * /v1/analyze/translate next to get it.
 */
export async function handleAnalyzeFast(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON body', 400);
  }

  const { text, context = '', targetLanguage = 'Spanish' } = body || {};
  if (!text?.trim()) return errResponse('Missing text', 400);

  // This step runs (or reuses the cache for) the Claude call, so it consumes
  // the same daily 'analyze' quota as the single-shot endpoint.
  const rl = await checkRateLimit(env.CACHE, userId, 'analyze');
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'Daily analysis limit reached', limit: rl.limit }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '0' } }
    );
  }

  const rlHeaders = {
    'Content-Type': 'application/json',
    'X-RateLimit-Remaining': String(rl.remaining),
    'X-RateLimit-Limit': String(rl.limit),
  };

  // Already fully cached for this language? No need for a step 2 at all.
  const fullKey = fullCacheKey(text, targetLanguage);
  let cachedFull = null;
  try {
    cachedFull = await env.CACHE.get(fullKey, 'json');
  } catch (err) {
    console.error(`Analysis cache read failed for ${fullKey}: ${err?.message || err}`);
  }
  if (cachedFull) {
    return new Response(JSON.stringify({ ...cachedFull, cached: true, complete: true }), { headers: rlHeaders });
  }

  let analysis;
  try {
    analysis = await _getOrBuildEnglishContent(text, context, env);
  } catch (err) {
    return errResponse(`Analysis failed: ${err.message}`, 502);
  }

  return new Response(JSON.stringify({ ...analysis, complete: false }), { headers: rlHeaders });
}

/**
 * POST /v1/analyze/translate — Phase 2 only. Translates word + definition +
 * example for a word whose English content should already be cached from a
 * prior /v1/analyze/fast call (rebuilt on demand if it isn't, so this endpoint
 * is safe to call on its own too). Persists the merged full result to the
 * per-language cache so future lookups of this word+language are instant.
 * Returns only the translation delta fields — the caller already has the rest.
 */
export async function handleAnalyzeTranslate(req, env, userId) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON body', 400);
  }

  const { text, targetLanguage = 'Spanish' } = body || {};
  if (!text?.trim()) return errResponse('Missing text', 400);

  // DeepL-only work from here — shares the lighter 'translate' quota, same as
  // the plain /v1/translate endpoint.
  const rl = await checkRateLimit(env.CACHE, userId, 'translate');
  if (!rl.allowed) {
    return errResponse('Daily translation limit reached', 429);
  }

  let analysis;
  try {
    // Context isn't available at this step (and Claude already ran with the
    // real context during /v1/analyze/fast under normal use) — this call
    // almost always hits the English-content cache and skips Claude entirely.
    analysis = await _getOrBuildEnglishContent(text, '', env);
  } catch (err) {
    return errResponse(`Translation failed: ${err.message}`, 502);
  }

  await _applyTranslation(analysis, text, targetLanguage, env);

  try {
    await env.CACHE.put(fullCacheKey(text, targetLanguage), JSON.stringify(analysis), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error(`Analysis cache write failed for ${fullCacheKey(text, targetLanguage)}: ${err?.message || err}`);
  }

  return new Response(JSON.stringify({
    translation: analysis.translation,
    definitionTranslated: analysis.definitionTranslated,
    exampleSentenceTranslated: analysis.exampleSentenceTranslated,
  }), { headers: { 'Content-Type': 'application/json' } });
}

// ── AI call helpers ────────────────────────────────────────────────────────

// AI Gateway routes through Cloudflare US infrastructure, bypassing regional IP blocks.
// Replace ACCOUNT_ID with your Cloudflare Account ID (dash.cloudflare.com → top right).
const ANTHROPIC_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/eeebef75914ebf0dddf7c498417a4e41/smart-translation/anthropic/v1/messages';

async function _callClaude(text, context, apiKey) {
  const res = await fetch(ANTHROPIC_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      // English-only output is ~110 tokens; 400 is a safety cap that still
      // cuts worst-case latency vs the old 1024
      max_tokens: 400,
      system: systemPrompt(),
      messages: [{ role: 'user', content: userMessage(text, context) }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Empty Claude response');

  // Parse JSON — try direct, then regex extraction as fallback
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude response was not valid JSON');
  }
}

/**
 * Translate multiple texts in ONE DeepL request (order preserved).
 * Returns an array of translations, or null on any failure.
 */
async function _callDeepLTexts(texts, targetLanguage, apiKey) {
  const langCode = DEEPL_LANG_CODES[targetLanguage];
  if (!langCode) {
    console.error(`DeepL: no language code mapped for "${targetLanguage}"`);
    return null;
  }
  if (!apiKey) {
    console.error('DeepL: DEEPL_KEY is not set on this environment (check `wrangler secret list`)');
    return null;
  }

  // Empty strings would error — translate only non-empty, restore positions after
  const nonEmptyIdx = texts.map((t, i) => (t ? i : -1)).filter(i => i !== -1);
  if (!nonEmptyIdx.length) return null;

  // Free keys end with ':fx' and use api-free.deepl.com; paid use api.deepl.com
  const host = apiKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';

  try {
    const res = await fetch(`https://${host}/v2/translate`, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: nonEmptyIdx.map(i => texts[i]),
        target_lang: langCode,
        source_lang: 'EN',
      }),
    });
    if (!res.ok) {
      // Surface WHY DeepL failed (bad/expired key, quota, unsupported pair, etc.)
      // instead of swallowing it — visible via `wrangler tail` in prod or the
      // `wrangler dev` console locally. Body is truncated in case of HTML error pages.
      const errBody = await res.text().catch(() => '');
      console.error(`DeepL translate failed: ${res.status} ${res.statusText} — ${errBody.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const out = new Array(texts.length).fill('');
    nonEmptyIdx.forEach((origIdx, k) => { out[origIdx] = data.translations?.[k]?.text || ''; });
    return out;
  } catch (err) {
    console.error(`DeepL translate threw: ${err?.message || err}`);
    return null;
  }
}

/**
 * Translation fallback when DeepL is unavailable or rejects the target language:
 * one small Claude call translating the strings array, order preserved.
 */
async function _claudeTranslateFallback(texts, targetLanguage, apiKey) {
  try {
    const res = await fetch(ANTHROPIC_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `You are a professional translator. Translate each string in the user's JSON array into ${targetLanguage}. Return ONLY a valid JSON array of the translated strings — same order, same length, no commentary, no markdown.`,
        messages: [{ role: 'user', content: JSON.stringify(texts) }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`Claude translation fallback failed: ${res.status} ${res.statusText} — ${errBody.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    const content = data.content?.[0]?.text || '';
    const match = content.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : content);
    if (!Array.isArray(arr) || arr.length !== texts.length) {
      console.error(`Claude translation fallback returned malformed array: ${content.slice(0, 300)}`);
      return null;
    }
    return arr;
  } catch (err) {
    console.error(`Claude translation fallback threw: ${err?.message || err}`);
    return null;
  }
}

/** Synonyms via Datamuse — free, no key, ~100ms. Word-level, good enough for chips. */
async function _callDatamuse(text) {
  try {
    const res = await fetch(
      `https://api.datamuse.com/words?rel_syn=${encodeURIComponent(text.trim())}&max=5`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.map(d => d.word).filter(Boolean).slice(0, 5);
  } catch {
    return null;
  }
}

/**
 * IPA pronunciation from the en_UK dataset stored in KV (key prefix "ipa:").
 * The dataset includes inflected forms, so an exact lowercase match covers most words.
 */
async function _getIPA(kv, text) {
  const w = text.trim().toLowerCase();
  if (!w || w.includes(' ')) return null; // phrases aren't in the dataset
  try {
    return (await kv.get(`ipa:${w}`)) || null;
  } catch {
    return null;
  }
}

async function _callGoogleTTS(text, apiKey) {
  if (!apiKey) return null;

  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: text.trim() },
        voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.85 },
      }),
    }
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data.audioContent || null; // base64-encoded MP3
}

function errResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

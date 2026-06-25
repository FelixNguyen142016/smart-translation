// server/src/analyze.js
// POST /v1/analyze — Claude Haiku 4.5 (definition) + DeepL (translation) in parallel, KV cached.
// Response shape is identical to analyzeWithPerplexity in the extension's ai-service.js.

import { systemPrompt, userMessage } from './prompts.js';
import { checkRateLimit } from './rate-limit.js';

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// DeepL target language codes (covers all 20 in LANG_CODES, minus Arabic/Vietnamese/Thai/Hindi)
const DEEPL_LANG_CODES = {
  Spanish: 'ES', French: 'FR', German: 'DE', Italian: 'IT', Portuguese: 'PT',
  Japanese: 'JA', Chinese: 'ZH', Korean: 'KO', Dutch: 'NL', Polish: 'PL',
  Russian: 'RU', Turkish: 'TR', Swedish: 'SV', Norwegian: 'NB', Danish: 'DA',
  Indonesian: 'ID', Ukrainian: 'UK', Czech: 'CS', Romanian: 'RO', Hungarian: 'HU',
};

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

  // KV cache lookup — key matches client-side analysis-cache.js pattern
  const cacheKey = `wac_${text.toLowerCase().trim()}_${targetLanguage.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, 'json');
  if (cached) {
    return new Response(JSON.stringify({ ...cached, cached: true }), { headers: rlHeaders });
  }

  // Parallel: Claude Haiku (definition) + DeepL (translation)
  const [claudeResult, deeplResult] = await Promise.allSettled([
    _callClaude(text, context, targetLanguage, env.ANTHROPIC_KEY),
    _callDeepL(text, targetLanguage, env.DEEPL_KEY),
  ]);

  if (claudeResult.status === 'rejected') {
    return errResponse(`Analysis failed: ${claudeResult.reason?.message}`, 502);
  }

  const analysis = claudeResult.value;

  // Prefer DeepL translation; keep Claude's translation field as fallback
  if (deeplResult.status === 'fulfilled' && deeplResult.value) {
    analysis.translation = deeplResult.value;
  }
  analysis.source = 'Claude Haiku 4.5 + DeepL';

  // Cache result
  await env.CACHE.put(cacheKey, JSON.stringify(analysis), { expirationTtl: CACHE_TTL_SECONDS });

  return new Response(JSON.stringify(analysis), { headers: rlHeaders });
}

// ── AI call helpers ────────────────────────────────────────────────────────

async function _callClaude(text, context, targetLanguage, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: systemPrompt(targetLanguage),
          cache_control: { type: 'ephemeral' }, // Cache per targetLanguage
        },
      ],
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

async function _callDeepL(text, targetLanguage, apiKey) {
  const langCode = DEEPL_LANG_CODES[targetLanguage];
  if (!langCode || !apiKey) return null;

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
        text: [text.trim()],
        target_lang: langCode,
        source_lang: 'EN',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.translations?.[0]?.text || null;
  } catch {
    return null;
  }
}

function errResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

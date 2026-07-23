// server/src/translate.js
// POST /v1/translate — sentence-level translation (YouTube dual subtitles).
// DeepL primary; MyMemory free fallback for unsupported languages.

import { checkRateLimit } from './rate-limit.js';

const DEEPL_LANG_CODES = {
  Spanish: 'ES', French: 'FR', German: 'DE', Italian: 'IT', Portuguese: 'PT',
  Japanese: 'JA', Chinese: 'ZH', Korean: 'KO', Dutch: 'NL', Polish: 'PL',
  Russian: 'RU', Turkish: 'TR', Swedish: 'SV', Norwegian: 'NB', Danish: 'DA',
  Indonesian: 'ID', Ukrainian: 'UK', Czech: 'CS', Romanian: 'RO', Hungarian: 'HU',
};

const MYMEMORY_CODES = {
  Spanish: 'es', French: 'fr', German: 'de', Italian: 'it', Portuguese: 'pt',
  Japanese: 'ja', Chinese: 'zh', Korean: 'ko', Arabic: 'ar', Russian: 'ru',
  Dutch: 'nl', Polish: 'pl', Vietnamese: 'vi', Turkish: 'tr', Thai: 'th',
  Hindi: 'hi', Indonesian: 'id', Swedish: 'sv', Norwegian: 'no', Danish: 'da',
};

/**
 * @param {Request} req
 * @param {{ CACHE: KVNamespace, DEEPL_KEY: string }} env
 * @param {string} userId
 * @param {boolean} isPro
 */
export async function handleTranslate(req, env, userId, isPro = false) {
  let body;
  try { body = await req.json(); } catch {
    return errResponse('Invalid JSON body', 400);
  }

  const { text, targetLanguage = 'Spanish' } = body || {};
  if (!text?.trim()) return errResponse('Missing text', 400);

  const rl = await checkRateLimit(env.CACHE, userId, 'translate', isPro);
  if (!rl.allowed) {
    return errResponse('Daily translation limit reached', 429);
  }

  const translation = await _translateText(text, targetLanguage, env.DEEPL_KEY);

  return new Response(
    JSON.stringify({ translation }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function _translateText(text, targetLanguage, deeplKey) {
  // Try DeepL first if key exists and language is supported
  if (deeplKey && DEEPL_LANG_CODES[targetLanguage]) {
    const host = deeplKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    try {
      const res = await fetch(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${deeplKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: [text.trim()],
          target_lang: DEEPL_LANG_CODES[targetLanguage],
          source_lang: 'EN',
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const result = data.translations?.[0]?.text;
        if (result) return result;
      }
    } catch { /* fall through to MyMemory */ }
  }

  // Fallback: MyMemory — free, no key, wider language coverage
  const code = MYMEMORY_CODES[targetLanguage];
  if (!code) return '';

  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.trim())}&langpair=en|${code}`
    );
    if (!res.ok) return '';
    const data = await res.json();
    return data?.responseData?.translatedText || '';
  } catch {
    return '';
  }
}

function errResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

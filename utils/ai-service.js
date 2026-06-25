// utils/ai-service.js
import { getSettings } from './storage.js';
import { getBackendUrl, getAuthToken } from './api-config.js';

/**
 * Analyze text using configured provider:
 *   'cloud'      → Cloudflare Worker backend (Claude Haiku 4.5 + DeepL, server key)
 *   'perplexity' → Perplexity direct (user BYOK, legacy)
 *   default      → Free Dictionary + Google Translate (no key required)
 */
export const analyzeText = async (text, context) => {
  const settings = await getSettings();

  if (settings.provider === 'cloud') {
    return await analyzeWithBackend(text, context, settings);
  }
  if (settings.provider === 'perplexity' && settings.apiKey) {
    return await analyzeWithPerplexity(text, context, settings);
  }
  // Pass targetLanguage so analyzeWithFreeDict avoids a redundant getSettings() call
  return await analyzeWithFreeDict(text, settings.targetLanguage);
};

// Language name (from settings) → Google Translate language code
const LANG_CODES = {
  Spanish: 'es', French: 'fr', German: 'de', Italian: 'it', Portuguese: 'pt',
  Japanese: 'ja', Chinese: 'zh', Korean: 'ko', Arabic: 'ar', Russian: 'ru',
  Dutch: 'nl', Polish: 'pl', Vietnamese: 'vi', Turkish: 'tr', Thai: 'th',
  Hindi: 'hi', Indonesian: 'id', Swedish: 'sv', Norwegian: 'no', Danish: 'da',
};

export async function analyzeWithFreeDict(text, targetLanguage = 'Spanish') {
  // Run dictionary lookup and translation in parallel for speed
  const [dictResult, translation] = await Promise.all([
    _fetchFreeDictData(text),
    _fetchGoogleTranslation(text, targetLanguage),
  ]);
  return { ...dictResult, translation };
}

async function _fetchFreeDictData(text) {
  const normalized = text.trim().toLowerCase();
  const firstWord = normalized.split(' ')[0];
  const attempts = normalized !== firstWord ? [normalized, firstWord] : [normalized];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(attempt)}`);
      if (!response.ok) {
        if (response.status === 404 && i < attempts.length - 1) continue;
        throw new Error(response.status === 404 ? "Word not found" : `API Error: ${response.status}`);
      }
      const data = await response.json();
      const entry = data[0];
      const meaning = entry.meanings[0];
      const defEntry = meaning.definitions[0];
      const truncated = attempt !== normalized;
      return {
        // baseForm: the dictionary's canonical lemma (e.g. "running" → "run")
        // Used by background.js to deduplicate inflected forms in storage
        baseForm: entry.word || attempt,
        definition: defEntry.definition,
        partOfSpeech: meaning.partOfSpeech,
        synonyms: meaning.synonyms || [],
        exampleSentence: defEntry.example || "No example available.",
        pronunciation: entry.phonetic || entry.phonetics?.[0]?.text || "",
        tags: [meaning.partOfSpeech],
        source: truncated ? `Free Dictionary (truncated to: "${attempt}")` : "Free Dictionary API",
      };
    } catch (error) {
      if (i < attempts.length - 1) continue;
      return {
        definition: "Definition unavailable.",
        partOfSpeech: "Unknown",
        synonyms: [],
        exampleSentence: `Error: ${error.message}`,
        pronunciation: "",
        tags: [],
        error: error.message,
      };
    }
  }
}

// Google Translate unofficial free endpoint — no API key required
// targetLanguage is passed from the caller to avoid a redundant getSettings() IPC call
async function _fetchGoogleTranslation(text, targetLanguage = 'Spanish') {
  const tl = LANG_CODES[targetLanguage];
  if (!tl) return ''; // language not supported — don't silently fall back to Spanish
  const trimmed = text.trim();

  // Primary: unofficial Google endpoint (no key, fast)
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${tl}&dt=t&q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      // Response structure: [[[translatedText, original, ...]], ...]
      const result = data?.[0]?.[0]?.[0] || '';
      if (result) return result;
    }
  } catch { /* fall through to MyMemory */ }

  // Fallback: MyMemory (free, no key, more stable)
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=en|${tl}`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const data = await res.json();
    return data?.responseData?.translatedText || '';
  } catch {
    return '';
  }
}

/**
 * Call the Cloudflare Worker backend for analysis.
 * Falls back to Free Dictionary on 429 (rate limit) or network error.
 * @param {string} text
 * @param {string} context
 * @param {object} settings
 */
async function analyzeWithBackend(text, context, settings) {
  const targetLanguage = settings.targetLanguage || 'Spanish';
  try {
    const token = await getAuthToken();
    if (!token) {
      // Not logged in — fall through to free dict
      return await analyzeWithFreeDict(text, targetLanguage);
    }

    const res = await fetch(`${getBackendUrl()}/v1/analyze`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, context, targetLanguage }),
    });

    if (res.status === 429) {
      // Daily limit hit — silent fallback to free tier
      return await analyzeWithFreeDict(text, targetLanguage);
    }
    if (res.status === 402) {
      // Subscription required — silent fallback to free tier
      return await analyzeWithFreeDict(text, targetLanguage);
    }
    if (!res.ok) throw new Error(`Backend ${res.status}`);

    return await res.json();
  } catch {
    // Network error or server down — silent fallback
    return await analyzeWithFreeDict(text, targetLanguage);
  }
}

async function analyzeWithPerplexity(text, context, settings) {
  const targetLang = settings.targetLanguage || "Spanish"; // Default if missing
  const prompt = generatePrompt(text, context, targetLang);
  
  // Construct Payload explicitly for debugging
  const payload = {
    model: "sonar-pro",
    messages: [
        { role: "system", content: "You are a helpful dictionary assistant. Return JSON only." },
        { role: "user", content: prompt }
    ],
    temperature: 0.2,
    top_p: 0.9,
    return_citations: false
  };

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    return await parseAIResponse(response, "Perplexity");
  } catch (error) {
    return handleAIError(error, "Perplexity");
  }
}

function generatePrompt(text, context, targetLang) {
  const safeContext = context && context.trim()
    ? context
    : "General English usage (non-technical).";

  return `
You are a PROFESSIONAL ENGLISH LEARNER DICTIONARY
(similar to Cambridge, Oxford, and Longman).

Word: "${text}"
Context: "${safeContext}"
Target translation language: ${targetLang}

STRICT RULES (DO NOT BREAK):
- Prefer GENERAL, MODERN, EVERYDAY English meanings.
- DO NOT give biological, taxonomic, medical, or highly technical definitions
  unless the context EXPLICITLY mentions science or biology.
- If a word has multiple meanings, YOU MUST include them.
- Never place multiple definitions on the same line.

INSTRUCTIONS:
1. Identify the PRIMARY meaning used in everyday English.
2. If the word has multiple meanings:
   - List up to 3 meanings
   - Order them by frequency of use in modern English
3. Clearly separate meanings by part of speech if applicable.
4. Select the meaning that best fits the context as the FIRST definition.
5. Use learner-friendly language (B2–C1 level).
6. If a rare or technical meaning exists, mention it LAST and label it as "rare" or "technical".

DEFINITION FORMATTING (MANDATORY):
- If there is more than one meaning, format the "definition" value EXACTLY like this:
  1. First meaning
  2. Second meaning
  3. Third meaning
- EACH numbered meaning MUST be on its own line.
- Use newline characters between meanings.

OUTPUT FORMAT:
Return ONLY a valid JSON object.
No markdown. No explanations. No extra text.

Required keys:
{
  "definition": "string (numbered, one meaning per line if multiple)",
  "translation": "string (${targetLang})",
  "partOfSpeech": "string",
  "synonyms": ["string"],
  "exampleSentence": "string",
  "pronunciation": "string (IPA)",
  "tags": ["string"]
}
`;
}


async function parseAIResponse(response, providerName) {
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`${providerName} Raw Error Body:`, errorText);
        throw new Error(`${providerName} API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
         throw new Error("Invalid API Response Format");
    }

    const content = data.choices[0].message.content;
    try {
        // Aggressive JSON extraction
        try {
            return { ...JSON.parse(content), source: providerName };
        } catch (e) {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return { ...JSON.parse(jsonMatch[0]), source: providerName };
            }
            throw new Error("No JSON found in response");
        }
    } catch (e) {
        console.error("JSON Parse Error. Content was:", content);
        throw new Error("Failed to parse AI response. Check console.");
    }
}

function handleAIError(error, providerName) {
    console.error(`${providerName} Integration Error:`, error);
    return {
        definition: "AI Analysis Failed",
        translation: "",
        partOfSpeech: "Error",
        synonyms: [],
        exampleSentence: "",
        pronunciation: "",
        tags: [],
        error: error.message
    };
}

/**
 * Translate a full sentence using Perplexity. Returns null if no API key configured.
 * Used for dual subtitle overlay on YouTube.
 */
export const translateSentence = async (text) => {
  const settings = await getSettings();
  const targetLang = settings.targetLanguage || 'Spanish';

  // Cloud provider — use backend /v1/translate (DeepL, no user key required)
  if (settings.provider === 'cloud') {
    try {
      const token = await getAuthToken();
      if (token) {
        const res = await fetch(`${getBackendUrl()}/v1/translate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text, targetLanguage: targetLang }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.translation) return data.translation;
        }
      }
    } catch { /* fall through */ }
    return _fetchGoogleTranslation(text, targetLang);
  }

  if (settings.provider === 'perplexity' && settings.apiKey) {
    try {
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [
            { role: 'system', content: 'You are a translator. Return ONLY the translated text, no explanations, no quotes.' },
            { role: 'user', content: `Translate to ${targetLang}: ${text}` }
          ],
          temperature: 0.1
        })
      });
      if (!response.ok) return _fetchGoogleTranslation(text, targetLang);
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch {
      return _fetchGoogleTranslation(text, targetLang);
    }
  }

  // Free tier: Google Translate (same endpoint used for single-word lookups)
  return await _fetchGoogleTranslation(text, targetLang) || null;
};

export const speakText = (text, lang = 'en-US') => {
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    window.speechSynthesis.speak(utterance);
  } else {
    console.warn("Text-to-speech not supported");
  }
};

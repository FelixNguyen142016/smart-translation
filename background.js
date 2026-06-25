// background.js
import { saveWord, getWords, getSettings } from './utils/storage.js';
import { analyzeText, analyzeWithFreeDict, translateSentence } from './utils/ai-service.js';
import { getCachedAnalysis, setCachedAnalysis } from './utils/analysis-cache.js';
import { getBackendUrl, getAuthToken } from './utils/api-config.js';

// In-memory dedup map: word (lowercase) → pending Promise<analysis>
// Prevents simultaneous duplicate API calls for the same word within a service worker session.
const _inflight = new Map();

// Handle messages from content scripts and youtube-handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "lookupAndSave") {
    // 1. Show loading popup immediately — no waiting for API
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, {
        action: "showDefinitionPopup",
        data: { loading: true, text: request.data.text }
      });
    }
    // 2. Fetch in background, update popup with full data when ready
    handleLookupAndSave(request.data)
      .then(result => {
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, { action: "showDefinitionPopup", data: result });
        }
      })
      .catch(err => console.error('Language Learning: lookupAndSave failed', err));
    return; // do NOT return true — no sendResponse used for this branch
  }

  if (request.action === "translateSentence") {
    translateSentence(request.text).then(translation => {
      sendResponse({ translation });
    });
    return true; // keep message channel open for async sendResponse
  }

  // YouTube hover tooltip: fetch definition WITHOUT saving
  if (request.action === "lookupOnly") {
    handleLookupOnly(request.data).then(result => sendResponse(result));
    return true;
  }

  // YouTube hover tooltip: save a word that already has a fetched analysis
  if (request.action === "saveFromYoutube") {
    handleSaveFromYoutube(request.data).then(result => sendResponse(result));
    return true;
  }
});

/**
 * Fetch analysis for a word, with two layers of deduplication:
 *   1. Persistent analysis cache (chrome.storage.local, 7-day TTL)
 *   2. In-flight map (service worker memory) — collapses simultaneous calls
 * @param {string} word
 * @param {string} context
 * @param {Function} fetchFn  — (word, context) => Promise<analysis>
 */
async function fetchAnalysis(word, context, fetchFn) {
  const settings = await getSettings();
  const targetLanguage = settings.targetLanguage || 'Spanish';
  // In-flight dedup key includes language so parallel lookups for different languages don't collide
  const inflightKey = `${word.toLowerCase()}_${targetLanguage.toLowerCase()}`;

  // Layer 1: persistent cache (language-aware — cache handles key building internally)
  const cached = await getCachedAnalysis(word, targetLanguage);
  if (cached) return cached;

  // Layer 2: in-flight dedup — return same Promise if already pending
  if (_inflight.has(inflightKey)) return _inflight.get(inflightKey);

  // Layer 3: fetch, cache on success, always clean up the in-flight slot
  const promise = fetchFn(word, context)
    .then(async (analysis) => {
      if (!analysis?.error) await setCachedAnalysis(word, analysis, targetLanguage);
      return analysis;
    })
    .finally(() => _inflight.delete(inflightKey));

  _inflight.set(inflightKey, promise);
  return promise;
}

// Fetch definition without saving — used by YouTube hover tooltip
// Uses FreeDict directly (no AI, no API key required)
async function handleLookupOnly(data) {
  try {
    const existing = await getWords();
    const found = existing.find(w => w.text.toLowerCase() === data.text.toLowerCase());
    if (found) return { ...found.aiAnalysis, alreadySaved: true };
    return await fetchAnalysis(data.text, data.context, (w) => analyzeWithFreeDict(w));
  } catch (error) {
    return { error: error.message };
  }
}

// Save a word that already has a fetched analysis — used by YouTube hover tooltip save button
async function handleSaveFromYoutube(data) {
  try {
    const record = {
      // Use lemma from analysis if available, else fall back to raw word
      text: data.analysis?.baseForm || data.text,
      context: data.context,
      url: data.url,
      title: data.title,
      timestamp: data.timestamp,
      videoId: data.videoId || '',       // YouTube video ID (empty for non-YouTube sources)
      videoTime: data.videoTime || 0,    // Playback position in seconds at time of save
      aiAnalysis: data.analysis,
      learningState: 'new',
      stats: { seen: 0, correct: 0, skipped: 0, consecutiveCorrect: 0 }
    };
    await saveWord(record);
    _pushVocabToCloud().catch(() => {});
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
}

async function handleLookupAndSave(data) {
  try {
    // Check if word already exists — skip API call + return existing record instantly
    const existing = await getWords();
    const found = existing.find(w => w.text.toLowerCase() === data.text.toLowerCase());
    if (found) return { ...found, alreadySaved: true };

    // Fetch via cache → in-flight dedup → API (respects configured provider)
    const analysis = await fetchAnalysis(data.text, data.context, analyzeText);

    // Use the API's canonical base form (lemma) as the storage key so inflected
    // forms ("running", "ran", "runs") all deduplicate to the same entry ("run")
    const canonicalText = analysis.baseForm || data.text;

    // Second dedup check: the lemma might already be saved under a different inflection
    // Reuse the same `existing` array — no second storage read needed
    if (canonicalText.toLowerCase() !== data.text.toLowerCase()) {
      const lemmaFound = existing.find(w => w.text.toLowerCase() === canonicalText.toLowerCase());
      if (lemmaFound) return { ...lemmaFound, alreadySaved: true };
    }

    const record = {
      ...data,
      text: canonicalText,  // store lemma, not the raw inflected form
      aiAnalysis: analysis,
      learningState: 'new',
      stats: { seen: 0, correct: 0, skipped: 0, consecutiveCorrect: 0 }
    };

    await saveWord(record);
    // Push entire vocab list to cloud when provider is 'cloud' (best-effort, silent)
    _pushVocabToCloud().catch(() => {});
    return record;
  } catch (error) {
    console.error("Error in lookup/save:", error);
    return { ...data, error: error.message };
  }
}

/**
 * Push the full local vocab list to the Cloudflare Worker so the dashboard
 * always sees the latest words. Fire-and-forget — never throws.
 */
async function _pushVocabToCloud() {
  const [settings, token] = await Promise.all([getSettings(), getAuthToken()]);
  const provider = settings?.provider || 'cloud';
  if (provider !== 'cloud' || !token) return;
  const words = await getWords();
  await fetch(`${getBackendUrl()}/v1/vocab`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: words }),
  });
}

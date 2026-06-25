// utils/storage.js
import { getAdapter } from './storage-adapter.js';

const STORAGE_KEY = 'vocabulary_list';

/**
 * Save a new vocabulary item
 * @param {Object} item - { text, context, url, title, timestamp, aiAnalysis? }
 * @returns {Promise<void>}
 */
export const saveWord = async (item) => {
  const items = await getWords();
  // Simple deduplication based on text
  if (!items.some(i => i.text.toLowerCase() === item.text.toLowerCase())) {
    await getAdapter().set({ [STORAGE_KEY]: [item, ...items] });
  }
};

/**
 * Retrieve all saved vocabulary items
 * @returns {Promise<Array>}
 */
export const getWords = async () => {
  return (await getAdapter().get(STORAGE_KEY)) || [];
};

/**
 * Delete a vocabulary item by text
 * @param {string} text
 * @returns {Promise<void>}
 */
export const deleteWord = async (text) => {
  const items = await getWords();
  // Case-insensitive match to stay consistent with saveWord
  await getAdapter().set({
    [STORAGE_KEY]: items.filter(i => i.text.toLowerCase() !== text.toLowerCase())
  });
};

/**
 * Update a vocabulary item
 * @param {string} text - Identifier
 * @param {Object} updates - Fields to update
 * @returns {Promise<void>}
 */
export const updateWord = async (text, updates) => {
  const items = await getWords();
  // Case-insensitive match to stay consistent with saveWord
  const index = items.findIndex(i => i.text.toLowerCase() === text.toLowerCase());
  if (index !== -1) {
    items[index] = { ...items[index], ...updates };
    await getAdapter().set({ [STORAGE_KEY]: items });
  }
};


const SETTINGS_KEY = 'extension_settings';

export const getSettings = async () => {
  return {
    apiKey: '',
    targetLanguage: 'Spanish',
    provider: 'freedict',
    theme: 'cyan',       // legacy — used when accentHue is absent
    accentHue: 190,      // default cyan hue; drives the new hue slider
    darkMode: false,
    ...((await getAdapter().get(SETTINGS_KEY)) || {})
  };
};

export const saveSettings = async (settings) => {
  await getAdapter().set({ [SETTINGS_KEY]: settings });
};

// ─── Player Profile ───────────────────────────────────────────────────────────

const PROFILE_KEY = 'player_profile';

const DEFAULT_PROFILE = {
  level: 1,
  xp: 0,
  xpToNext: 140, // matches xpForLevel(2) = Math.round(100 * 1.4^1) = 140
  accuracy: 0,
  wordsMastered: 0,
  streak: 0,
  lastPlayedDate: null,
  achievements: [],
  titles: [],
  totalCorrect: 0,
  totalSeen: 0,
  hintCount: 0
};

export const getProfile = async () => {
  return { ...DEFAULT_PROFILE, ...((await getAdapter().get(PROFILE_KEY)) || {}) };
};

export const saveProfile = async (profile) => {
  await getAdapter().set({ [PROFILE_KEY]: profile });
};

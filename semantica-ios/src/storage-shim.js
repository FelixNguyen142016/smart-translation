// renderer/storage-shim.js
// Shim that mirrors the extension's storage.js API, backed by api.js (in-memory cache + backend)

import {
  getCachedWords,
  apiSaveWord,
  apiUpdateWord,
  apiDeleteWord,
  apiSaveSettings,
  apiSaveProfile,
} from './api.js';

// ─── Settings key (localStorage) ──────────────────────────────────────────────
const SETTINGS_KEY = 'extension_settings';
const PROFILE_KEY  = 'player_profile';

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/** Returns the in-memory word cache (instant, no network). */
export function getWords() {
  return getCachedWords();
}

/** Add a new word record to the cache and persist to backend. */
export async function saveWord(record) {
  await apiSaveWord(record);
}

/** Update fields on an existing word and persist. */
export async function updateWord(text, updates) {
  await apiUpdateWord(text, updates);
}

/** Remove a word from the cache and persist. */
export async function deleteWord(text) {
  await apiDeleteWord(text);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  apiKey: '',
  targetLanguage: 'Vietnamese', // fixed: Semantica is English → Vietnamese
  provider: 'freedict',
  theme: 'cyan',
  accentHue: 190,
  darkMode: false,
  visualPreset: null, // Visual Theme preset id (see theme.js VISUAL_PRESET_GROUPS), or null for the plain hue-driven look
};

/** Get settings from localStorage (with API fallback if token present). */
export function getSettings() {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Save settings to localStorage and persist to backend. */
export async function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  await apiSaveSettings(settings);
}

// ─── Player Profile ───────────────────────────────────────────────────────────

const DEFAULT_PROFILE = {
  level: 1,
  xp: 0,
  xpToNext: 140,
  accuracy: 0,
  wordsMastered: 0,
  streak: 0,
  lastPlayedDate: null,
  achievements: [],
  titles: [],
  totalCorrect: 0,
  totalSeen: 0,
  hintCount: 0,
};

/** Get player profile from localStorage (fast path for game). */
export function getProfile() {
  try {
    const stored = localStorage.getItem(PROFILE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return { ...DEFAULT_PROFILE, ...parsed };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/** Save player profile to localStorage and persist to backend. */
export async function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  await apiSaveProfile(profile);
}

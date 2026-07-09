// renderer/player.js
// Player profile management — load, save, XP, level, streaks
// Adapted from utils/player.js: imports from ./storage-shim.js and ./game-engine.js

import { getProfile, saveProfile } from './storage-shim.js';
import { applyXP, xpForLevel } from './game-engine.js';

export { getProfile, saveProfile };

/**
 * Add XP to player profile and handle level-ups.
 * @param {number} amount
 * @returns {Promise<{ profile: Object, leveledUp: boolean }>}
 */
export async function addXP(amount) {
  const profile = await getProfile();
  const before = profile.level;
  const updated = applyXP(profile, amount);
  const newProfile = { ...profile, ...updated };
  await saveProfile(newProfile);
  return { profile: newProfile, leveledUp: newProfile.level > before };
}

/**
 * Record session completion: update accuracy, streak, masteredCount, lastPlayedDate.
 * @param {Object} sessionStats - { correct, totalAnswered, wordsMastered }
 */
export async function recordSession(sessionStats) {
  const profile = await getProfile();
  const total = profile.totalSeen + sessionStats.totalAnswered;
  const totalCorrect = profile.totalCorrect + sessionStats.correct;
  const accuracy = total > 0 ? Math.round((totalCorrect / total) * 100) : 0;

  const today = new Date().toDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const streak = profile.lastPlayedDate === yesterday.toDateString()
    ? profile.streak + 1
    : profile.lastPlayedDate === today ? profile.streak : 1;

  const updated = {
    ...profile,
    totalSeen: total,
    totalCorrect,
    accuracy,
    streak,
    lastPlayedDate: today,
    wordsMastered: profile.wordsMastered + (sessionStats.wordsMastered || 0),
    hintCount: profile.hintCount + (sessionStats.hintCount || 0)
  };

  await saveProfile(updated);
  return updated;
}

/**
 * Add a new achievement ID to the profile (prevents duplicates).
 * @param {string} achievementId
 * @param {string} title
 */
export async function unlockAchievement(achievementId, title) {
  const profile = await getProfile();
  if (profile.achievements.includes(achievementId)) return profile;
  const updated = {
    ...profile,
    achievements: [...profile.achievements, achievementId],
    titles: [...profile.titles, title]
  };
  await saveProfile(updated);
  return updated;
}

/**
 * Format XP progress string: "450 / 700 XP"
 */
export function formatXPBar(profile) {
  return `${profile.xp} / ${profile.xpToNext} XP`;
}

/**
 * XP percentage for progress bar display (0–100)
 */
export function xpPercent(profile) {
  return Math.min(100, Math.round((profile.xp / profile.xpToNext) * 100));
}

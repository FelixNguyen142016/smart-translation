// renderer/game-engine.js
// Spaced repetition, scoring, XP, and achievement logic
// Copied from utils/game-engine.js — no changes needed

// ─── Spaced Repetition ────────────────────────────────────────────────────────

/**
 * Select next word using spaced repetition priority:
 * Relearn (1) > Learning (2) > New (3) > Known (4, 5% chance)
 * @param {Array} words - vocabulary array with learningState
 * @returns {Object|null} selected word (with ensured learning fields)
 */
export function selectNextWord(words) {
  if (!words.length) return null;

  // Single pass instead of 4 filter calls — reduces allocations with large vocabularies
  const relearn = [], learning = [], new_ = [], known = [];
  for (const w of words) {
    const s = w.learningState;
    if (s === 'relearn')       relearn.push(w);
    else if (s === 'learning') learning.push(w);
    else if (s === 'known')    known.push(w);
    else                       new_.push(w);
  }

  let pool;
  if (relearn.length)                            pool = relearn;
  else if (learning.length)                      pool = learning;
  else if (new_.length)                          pool = new_;
  else if (known.length && Math.random() < 0.05) pool = known;
  else                                           pool = words; // fallback: all words

  return ensureFields(pool[Math.floor(Math.random() * pool.length)]);
}

function ensureFields(word) {
  return {
    learningState: 'new',
    stats: { seen: 0, correct: 0, skipped: 0, consecutiveCorrect: 0 },
    ...word
  };
}

// ─── Learning State Machine ───────────────────────────────────────────────────

/**
 * Compute new learningState after a round result
 * @param {Object} word
 * @param {{ correct: boolean, hintUsed: boolean, skipped: boolean }} result
 * @returns {string} new learningState
 */
export function nextLearningState(word, result) {
  const state = word.learningState || 'new';
  const stats = word.stats || { consecutiveCorrect: 0 };

  if (result.skipped) return state === 'known' ? 'learning' : state;
  if (!result.correct) return 'relearn';

  if (result.hintUsed) return 'learning';

  if (state === 'relearn' || state === 'new') return 'learning';
  if (state === 'learning') {
    return ((stats.consecutiveCorrect ?? 0) + 1) >= 3 ? 'known' : 'learning';
  }
  return 'known';
}

/**
 * Return updated stats object after a result
 */
export function updateStats(stats, result) {
  const s = { ...(stats || { seen: 0, correct: 0, skipped: 0, consecutiveCorrect: 0 }) };
  s.consecutiveCorrect = s.consecutiveCorrect ?? 0;
  s.seen += 1;
  if (result.correct) {
    s.correct += 1;
    s.consecutiveCorrect = result.hintUsed ? 0 : s.consecutiveCorrect + 1;
  } else {
    s.consecutiveCorrect = 0;
  }
  if (result.skipped) s.skipped += 1;
  return s;
}

// ─── XP & Scoring ─────────────────────────────────────────────────────────────

// quickear sits between survival and mission: recalling spelling from audio
// alone (no visible word/definition, unlike every other mode) is harder than
// survival's continuous-pressure typing but doesn't require the sustained
// multi-objective consistency mission does.
const MODE_MULTIPLIERS = { race: 1.0, survival: 1.2, mission: 1.5, quickear: 1.35 };
const STATE_DIFFICULTY = { new: 1, relearn: 2, learning: 2, known: 3 };

/**
 * Calculate XP earned for a correct answer
 */
export function calcXP(word, result, mode) {
  if (!result.correct || result.skipped) return 0;
  const difficulty = STATE_DIFFICULTY[word.learningState] || 1;
  const base = 10 * difficulty;
  const hintPenalty = result.hintUsed ? 0.5 : 1;
  const multiplier = MODE_MULTIPLIERS[mode] || 1;
  return Math.round(base * hintPenalty * multiplier);
}

// ─── Achievements ─────────────────────────────────────────────────────────────

const ACHIEVEMENT_DEFS = [
  { id: 'first_correct',  title: 'First Word!',    desc: 'Answer correctly for the first time', condition: (p) => p.totalCorrect >= 1 },
  { id: 'streak_5',       title: 'On a Roll',      desc: '5-word correct streak',               condition: (p, s) => s.maxStreak >= 5 },
  { id: 'no_hints',       title: 'Unaided',        desc: 'Complete a session without hints',     condition: (_, s) => s.hintCount === 0 && s.totalAnswered >= 5 },
  { id: 'master_10',      title: 'Word Master',    desc: 'Master 10 words (Known state)',        condition: (p) => p.wordsMastered >= 10 },
  { id: 'accuracy_90',    title: 'Sharpshooter',   desc: '90%+ accuracy in a session',          condition: (_, s) => s.totalAnswered >= 10 && (s.correct / s.totalAnswered) >= 0.9 },
  { id: 'level_5',        title: 'Scholar',        desc: 'Reach level 5',                       condition: (p) => p.level >= 5 },
];

/**
 * Check for newly unlocked achievements
 */
export function checkAchievements(profile, sessionStats) {
  const earned = new Set(profile.achievements || []);
  const newOnes = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (!earned.has(def.id) && def.condition(profile, sessionStats)) {
      newOnes.push(def);
    }
  }
  return newOnes;
}

// ─── Level Thresholds ─────────────────────────────────────────────────────────

/** XP required to reach a given level */
export function xpForLevel(level) {
  return Math.round(100 * Math.pow(1.4, level - 1));
}

/** Compute new level + xp after adding xpGained */
export function applyXP(profile, xpGained) {
  let { level, xp } = profile;
  xp += xpGained;
  let xpToNext = xpForLevel(level + 1);
  while (xp >= xpToNext) {
    xp -= xpToNext;
    level += 1;
    xpToNext = xpForLevel(level + 1);
  }
  return { level, xp, xpToNext };
}

// ─── Difficulty Hint Rules ────────────────────────────────────────────────────

/**
 * Max hints allowed per word based on player level
 */
export function maxHintsForLevel(playerLevel) {
  if (playerLevel <= 3) return 3;
  if (playerLevel <= 6) return 1;
  return 0; // level 7+ no hints
}

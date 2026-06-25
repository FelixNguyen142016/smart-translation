// renderer/game-controller.js
// Main game state machine: screen routing, gameplay loop, hint/skip handling
// Adapted from dashboard/game-controller.js: import paths updated to local renderer/

import { getWords, updateWord } from './storage-shim.js';
import { selectNextWord, nextLearningState, updateStats, calcXP, checkAchievements, maxHintsForLevel } from './game-engine.js';
import { getProfile, addXP, recordSession, unlockAchievement } from './player.js';
import { RaceMode, SurvivalMode, MissionMode } from './game-modes.js';
import { renderMenu, renderResults, renderMissionObjectives, renderReview } from './game-render.js';

// ─── State ────────────────────────────────────────────────────────────────────
let words = [], currentWord = null, modeInstance = null, selectedMode = 'race';
let sessionStats = { correct: 0, totalAnswered: 0, hintCount: 0, wordsMastered: 0, streak: 0 };
let hintsUsedThisWord = 0, maxHints = 3;
let isSessionActive = false;
let gameInitialized = false;

// ─── Screen Router ────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.game-screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ─── Public Init ─────────────────────────────────────────────────────────────
export async function initGame() {
  words = await getWords();
  const profile = await getProfile();
  maxHints = maxHintsForLevel(profile.level);
  renderMenu(profile);

  if (!isSessionActive) showScreen('screen-menu');

  if (gameInitialized) return;
  gameInitialized = true;

  document.getElementById('btn-play')?.addEventListener('click', () => showScreen('screen-mode'));
  document.getElementById('btn-review')?.addEventListener('click', () => { renderReview(); showScreen('screen-review'); });
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedMode = card.dataset.mode;
    });
  });
  document.getElementById('btn-start-game')?.addEventListener('click', startSession);
  document.getElementById('btn-hint')?.addEventListener('click', useHint);
  document.getElementById('btn-skip')?.addEventListener('click', skipWord);
  document.getElementById('btn-play-again')?.addEventListener('click', () => { resetSession(); showScreen('screen-mode'); });
  document.getElementById('btn-back-menu')?.addEventListener('click', async () => { const p = await getProfile(); renderMenu(p); showScreen('screen-menu'); });
  document.getElementById('btn-back-menu-review')?.addEventListener('click', async () => { const p = await getProfile(); renderMenu(p); showScreen('screen-menu'); });
  document.getElementById('btn-quit-game')?.addEventListener('click', () => { modeInstance?.stop?.(); endSession(); });
  document.getElementById('answer-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitAnswer(); });
}

// ─── Session Management ───────────────────────────────────────────────────────
function resetSession() {
  isSessionActive = false;
  currentWord = null;
  sessionStats = { correct: 0, totalAnswered: 0, hintCount: 0, wordsMastered: 0, streak: 0 };
  if (modeInstance) modeInstance.stop?.();
  modeInstance = null;
  // Clear mission objectives so they don't bleed into other game modes
  const missionEl = document.getElementById('mission-objectives');
  if (missionEl) missionEl.innerHTML = '';
}

async function startSession() {
  resetSession();
  words = await getWords();
  if (!words.length) { alert('Save some words first!'); return; }

  const onTick = (val) => {
    const el = document.getElementById('mode-status');
    if (el) el.textContent = modeInstance?.statusLabel() || '';
    if (selectedMode === 'race') {
      const bar = document.getElementById('race-bar');
      if (bar) bar.style.width = val + '%';
    }
  };
  const onGameOver = () => endSession();

  if (selectedMode === 'race')          modeInstance = new RaceMode(onTick, onGameOver);
  else if (selectedMode === 'survival') modeInstance = new SurvivalMode(onTick, onGameOver);
  else if (selectedMode === 'mission')  modeInstance = new MissionMode();

  isSessionActive = true;
  modeInstance.start?.();
  showScreen('screen-play');
  nextRound();
}

// ─── Gameplay Loop ────────────────────────────────────────────────────────────
async function nextRound() {
  if (!isSessionActive) return;
  currentWord = selectNextWord(words);
  if (!currentWord) { endSession(); return; }
  hintsUsedThisWord = 0;

  document.getElementById('game-definition').textContent = currentWord.aiAnalysis?.definition || 'No definition available.';
  document.getElementById('hint-area').innerHTML = '';
  document.getElementById('feedback-area').textContent = '';
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-input').disabled = false;
  document.getElementById('answer-input').focus();

  const hintBtn = document.getElementById('btn-hint');
  if (hintBtn) hintBtn.disabled = maxHints === 0;

  const status = document.getElementById('mode-status');
  if (status && modeInstance) status.textContent = modeInstance.statusLabel();

  const missionEl = document.getElementById('mission-objectives');
  if (selectedMode === 'mission') {
    renderMissionObjectives(modeInstance?.objectives);
  } else if (missionEl) {
    missionEl.innerHTML = ''; // clear leftover objectives from a previous mission game
  }
}

function submitAnswer() {
  if (!currentWord || !isSessionActive) return;
  if (!currentWord.text) { skipWord(); return; }
  const input = document.getElementById('answer-input');
  const answer = input.value.trim().toLowerCase();
  const correct = answer === currentWord.text.toLowerCase();

  const wordSnapshot = currentWord;
  currentWord = null;
  const result = { correct, hintUsed: hintsUsedThisWord > 0, skipped: false };
  processResult(result, correct ? null : wordSnapshot.text, wordSnapshot);
}

async function processResult(result, revealWord, word) {
  const feedback = document.getElementById('feedback-area');
  document.getElementById('answer-input').disabled = true;

  if (result.correct) {
    feedback.innerHTML = `<span class="feedback-correct">✓ Correct! +${calcXP(word, result, selectedMode)} XP</span>`;
    sessionStats.correct += 1;
    sessionStats.streak += 1;
    modeInstance?.onCorrect?.(result.hintUsed);
  } else {
    feedback.innerHTML = `<span class="feedback-wrong">✗ The answer was: <strong>${revealWord || '(skipped)'}</strong></span>`;
    sessionStats.streak = 0;
    modeInstance?.onWrong?.();
  }

  // Re-render mission objectives immediately after onCorrect/onWrong
  const missionEl = document.getElementById('mission-objectives');
  if (selectedMode === 'mission') {
    renderMissionObjectives(modeInstance?.objectives);
  } else if (missionEl) {
    missionEl.innerHTML = '';
  }

  sessionStats.totalAnswered += 1;
  if (result.hintUsed) sessionStats.hintCount += 1;

  // Check mission complete before scheduling next round
  if (selectedMode === 'mission' && modeInstance.isComplete?.()) { endSession(); return; }

  // Schedule next round NOW (before async persistence) so the timer race condition
  // in Survival mode can't prevent nextRound from being scheduled.
  // nextRound() itself guards with isSessionActive.
  if (isSessionActive) setTimeout(() => nextRound(), 800);

  // Persist result asynchronously — doesn't block the next round timer
  try {
    const newState = nextLearningState(word, result);
    const newStats = updateStats(word.stats, result);
    if (newState === 'known' && word.learningState !== 'known') sessionStats.wordsMastered += 1;
    const idx = words.findIndex(w => w.text.toLowerCase() === word.text.toLowerCase());
    if (idx !== -1) words[idx] = { ...words[idx], learningState: newState, stats: newStats };
    await updateWord(word.text, { learningState: newState, stats: newStats });
    const xp = calcXP(word, result, selectedMode);
    if (xp > 0) await addXP(xp);
  } catch (err) {
    const fb = document.getElementById('feedback-area');
    if (fb) fb.innerHTML += '<span style="color:#f59e0b;font-size:11px;margin-left:6px;">(progress not saved)</span>';
  }
}

function useHint() {
  if (!currentWord || hintsUsedThisWord >= maxHints) return;
  hintsUsedThisWord += 1;
  const hintArea = document.getElementById('hint-area');
  const analysis = currentWord.aiAnalysis || {};
  const hints = [];
  if (hintsUsedThisWord === 1 && analysis.translation) hints.push(`Translation: ${analysis.translation}`);
  if (hintsUsedThisWord >= 2) hints.push(`First letter: ${currentWord.text?.[0]?.toUpperCase() ?? '?'}`);
  if (hintsUsedThisWord >= 3 && analysis.exampleSentence) hints.push(`Example: "${analysis.exampleSentence}"`);
  hintArea.innerHTML = '';
  hints.forEach(h => {
    const div = document.createElement('div');
    div.className = 'hint-item';
    div.textContent = h;
    hintArea.appendChild(div);
  });
  if (hintsUsedThisWord >= maxHints) document.getElementById('btn-hint').disabled = true;
}

function skipWord() {
  if (!currentWord || !isSessionActive) return;
  const wordSnapshot = currentWord;
  currentWord = null;
  processResult({ correct: false, hintUsed: false, skipped: true }, null, wordSnapshot);
}

// ─── End Session ──────────────────────────────────────────────────────────────
async function endSession() {
  if (!isSessionActive) return;
  isSessionActive = false;
  currentWord = null;
  modeInstance?.stop?.();
  const profile = await recordSession(sessionStats);
  const newAchievements = checkAchievements(profile, sessionStats);
  for (const a of newAchievements) await unlockAchievement(a.id, a.title);
  renderResults(profile, sessionStats, newAchievements);
  showScreen('screen-results');
}

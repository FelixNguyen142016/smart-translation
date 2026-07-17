// renderer/game-controller.js
// Main game state machine: screen routing, gameplay loop, hint/skip handling
// Adapted from dashboard/game-controller.js: import paths updated to local renderer/

import { getWords, updateWord } from './storage-shim.js';
import { selectNextWord, nextLearningState, updateStats, calcXP, checkAchievements, maxHintsForLevel } from './game-engine.js';
import { getProfile, addXP, recordSession, unlockAchievement } from './player.js';
import { RaceMode, SurvivalMode, MissionMode, QuickEarMode } from './game-modes.js';
import { renderMenu, renderResults, renderMissionObjectives, renderReview } from './game-render.js';
import { escapeHtml } from './dom-utils.js';
import { speakText } from './audio-utils.js';
import {
  mountRaceScene, isRaceSceneAvailable, setRaceProgress, resetRaceScene,
  raceCorrect, raceWrong, raceSkip, raceWin, raceLose,
  pauseRaceScene, resumeRaceScene,
} from './race-scene.js';
import {
  mountSurvivalScene, isSurvivalSceneAvailable, setSurvivalTime, resetSurvivalScene,
  survivalCorrect, survivalWrong, survivalSkip, survivalEnd,
  pauseSurvivalScene, resumeSurvivalScene,
} from './survival-scene.js';
import {
  mountMissionScene, isMissionSceneAvailable, updateMissionScene, resetMissionScene,
  missionCorrect, missionWrong, missionSkip, missionWin,
  pauseMissionScene, resumeMissionScene,
} from './mission-scene.js';
import {
  mountQuickEarScene, isQuickEarSceneAvailable, resetQuickEarScene, setQuickEarTimeLeft,
  quickEarPlayWord, quickEarCorrect, quickEarWrong, quickEarSkip, quickEarWin,
  pauseQuickEarScene, resumeQuickEarScene,
} from './radio-scene.js';

// ─── State ────────────────────────────────────────────────────────────────────
let words = [], currentWord = null, modeInstance = null, selectedMode = 'race';
// maxStreak tracks peak streak this session (Bug 1 fix)
let sessionStats = { correct: 0, totalAnswered: 0, hintCount: 0, wordsMastered: 0, streak: 0, maxStreak: 0 };
let hintsUsedThisWord = 0, maxHints = 3;
let isSessionActive = false;
let gameInitialized = false;
// Race mode: finite word queue for win condition (Bug 4)
let raceQueue = [], raceWordLimit = 10;
// Race mode: per-round log for results review
let raceLog = []; // [{ word, correct, skipped }]
// Quick Ear mode: finite word queue (same pattern as Race), per-round log,
// and per-round 15s timer state. Unlike Race/Survival, no GameMode class
// owns this timer — it's driven directly here off real elapsed time (see
// _startQuickEarRound below), since the 15s window is tied to each round,
// not to a continuous session-level clock.
let quickEarQueue = [], quickEarWordLimit = 10;
let quickEarLog = []; // [{ word, correct, skipped }]
const QE_ROUND_SECONDS = 15;
let _qeTimerId = null, _qeTimeLeft = QE_ROUND_SECONDS, _qeReplayCount = 0;

// Fisher-Yates shuffle (returns a new array) — replaces the statistically
// biased `.sort(() => Math.random() - 0.5)` that was duplicated for both
// Race's and Quick Ear's finite word queues.
function shuffled(arr) {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─── Screen Router ────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.game-screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ─── Game-mode visual registry ─────────────────────────────────────────────
// Every mode's Phaser-canvas-or-fallback visual follows the same shape: show
// the canvas container, mount/reset the scene once available, and pause/
// resume its render loop when the mode isn't the active one. Mode-specific
// extras (Race/Survival's shared .race-bar-wrap fallback, Survival's
// immersive-card class, Quick Ear's extra HTML timer + button toggles) live
// in each entry's onSetup/onTeardown hooks so this table is a single source
// of truth instead of 4 near-identical function pairs that can silently
// drift apart (this refactor is what closed that exact gap: Race's
// container-visible-before-mount ordering had never been backported from
// Survival/Mission/Quick Ear before this table unified them all).
//
// mount-before-visible ordering rationale (why `container.style.display =
// 'block'` always runs before `mount()`): Phaser's Scale.FIT mode measures
// its parent container's size at construction time and doesn't automatically
// pick up a later CSS-driven resize. Each mount*Scene() is idempotent-once
// (the Phaser.Game instance is only ever constructed the first time a mode
// is played in a session) — if the container were still display:none at
// that first call, Phaser would lock onto a collapsed 0-size measurement and
// the canvas would render tiny/wrong for the rest of the session. Each
// reset*Scene() also force-refreshes the scale manager as a second line of
// defense on every subsequent replay.
const VISUAL_MODES = {
  race: {
    containerId: 'race-canvas-container',
    isAvailable: isRaceSceneAvailable,
    mount: () => mountRaceScene('race-canvas-container'),
    reset: resetRaceScene,
    pause: pauseRaceScene,
    resume: resumeRaceScene,
    onSetup(available) {
      const wrap = document.querySelector('.race-bar-wrap');
      if (wrap) wrap.style.display = available ? 'none' : '';
    },
    onTeardown() {
      const wrap = document.querySelector('.race-bar-wrap');
      if (wrap) wrap.style.display = '';
    },
  },
  survival: {
    containerId: 'survival-canvas-container',
    isAvailable: isSurvivalSceneAvailable,
    mount: () => mountSurvivalScene('survival-canvas-container'),
    reset: resetSurvivalScene,
    pause: pauseSurvivalScene,
    resume: resumeSurvivalScene,
    // The immersive full-card layout (.immersive-survival, see index.html)
    // only applies when the Phaser scene actually mounted — if Phaser failed
    // to load, Survival falls back to the same plain-bar/text layout Race
    // mode uses, so the class only ever gets added in the available branch.
    onSetup(available) {
      const wrap = document.querySelector('.race-bar-wrap');
      if (wrap) wrap.style.display = available ? 'none' : '';
      if (available) document.querySelector('.game-play-card')?.classList.add('immersive-survival');
    },
    onTeardown() {
      const wrap = document.querySelector('.race-bar-wrap');
      if (wrap) wrap.style.display = '';
      document.querySelector('.game-play-card')?.classList.remove('immersive-survival');
    },
  },
  // Mission has no bar equivalent to fall back to (#mission-objectives'
  // plain-text checklist is always rendered regardless, in nextRound()/
  // processResult() — this canvas is purely additive ambiance alongside it),
  // so unlike Race/Survival there's no wrap element to toggle.
  mission: {
    containerId: 'mission-canvas-container',
    isAvailable: isMissionSceneAvailable,
    mount: () => mountMissionScene('mission-canvas-container'),
    reset: resetMissionScene,
    pause: pauseMissionScene,
    resume: resumeMissionScene,
  },
  // Unlike every other mode, #quickear-timer-wrap isn't a Phaser-vs-fallback
  // either/or — it's the actual numeric "N seconds left" readout (the canvas
  // ring is deliberately text-free, see radio-scene.js), so it's shown
  // whenever Quick Ear is active regardless of whether Phaser loaded. Also
  // toggles the Hint button off (a hint would trivialize a dictation test)
  // and the Replay button on, since both only make sense for this mode.
  quickear: {
    containerId: 'quickear-canvas-container',
    isAvailable: isQuickEarSceneAvailable,
    mount: () => mountQuickEarScene('quickear-canvas-container'),
    reset: resetQuickEarScene,
    pause: pauseQuickEarScene,
    resume: resumeQuickEarScene,
    onSetup() {
      const timerWrap = document.getElementById('quickear-timer-wrap');
      const hintBtn   = document.getElementById('btn-hint');
      const replayBtn = document.getElementById('btn-replay-audio');
      if (timerWrap) timerWrap.style.display = 'flex';
      if (hintBtn) hintBtn.style.display = 'none';
      if (replayBtn) replayBtn.style.display = 'inline-flex';
    },
    onTeardown() {
      const timerWrap = document.getElementById('quickear-timer-wrap');
      const hintBtn   = document.getElementById('btn-hint');
      const replayBtn = document.getElementById('btn-replay-audio');
      if (timerWrap) timerWrap.style.display = 'none';
      if (hintBtn) hintBtn.style.display = '';
      if (replayBtn) replayBtn.style.display = 'none';
      _clearQuickEarTimer();
    },
  },
};

function setupVisual(mode) {
  const def = VISUAL_MODES[mode];
  if (!def) return;
  const available = def.isAvailable();
  def.onSetup?.(available);
  const container = document.getElementById(def.containerId);
  if (!container) return;
  if (available) {
    container.style.display = 'block';
    def.mount();
    def.reset();
    def.resume?.();
  } else {
    container.style.display = 'none';
  }
}

function teardownVisual(mode) {
  const def = VISUAL_MODES[mode];
  if (!def) return;
  const container = document.getElementById(def.containerId);
  if (container) container.style.display = 'none';
  def.pause?.();
  def.onTeardown?.();
}

/** Tear down every mode's visual except the one becoming active (or all, if activeMode isn't a registered mode). */
function teardownAllVisualsExcept(activeMode) {
  Object.keys(VISUAL_MODES).forEach(mode => {
    if (mode !== activeMode) teardownVisual(mode);
  });
}

// ─── Quick Ear per-round timer ──────────────────────────────────────────────
// The real countdown — ticks every 100ms for a smooth bar/ring, clamped at 0.
// Auto-submits as a timeout when it runs out. Cleared on every manual
// submit/skip and at round/session boundaries so no stray timer can fire
// into a later round.
function _startQuickEarRound(word) {
  _clearQuickEarTimer();
  _qeTimeLeft = QE_ROUND_SECONDS;
  _qeReplayCount = 0;
  _renderQuickEarTimer();
  quickEarPlayWord();
  speakText(word.text, word.aiAnalysis?.audioBase64);
  _armQuickEarTimer();
}

// Split out of _startQuickEarRound so resumeGameSession() can re-arm the
// countdown after a pause without replaying audio or resetting the clock —
// the player already heard this word before navigating away.
function _armQuickEarTimer() {
  _qeTimerId = setInterval(() => {
    _qeTimeLeft = Math.max(0, _qeTimeLeft - 0.1);
    _renderQuickEarTimer();
    if (_qeTimeLeft <= 0) {
      _clearQuickEarTimer();
      _quickEarTimeout();
    }
  }, 100);
}

function _clearQuickEarTimer() {
  if (_qeTimerId) { clearInterval(_qeTimerId); _qeTimerId = null; }
}

function _renderQuickEarTimer() {
  const bar  = document.getElementById('quickear-timer-bar');
  const text = document.getElementById('quickear-timer-text');
  const frac = Math.max(0, _qeTimeLeft / QE_ROUND_SECONDS);
  if (bar) {
    bar.style.width = (frac * 100) + '%';
    bar.style.background = frac > 0.5
      ? 'linear-gradient(90deg, var(--brand), var(--brand-2))'
      : frac > 0.2 ? '#f59e0b' : '#ef4444';
  }
  if (text) text.textContent = Math.ceil(_qeTimeLeft) + 's';
  setQuickEarTimeLeft(_qeTimeLeft, QE_ROUND_SECONDS);
}

function _quickEarTimeout() {
  if (!currentWord || !isSessionActive || selectedMode !== 'quickear') return;
  const wordSnapshot = currentWord;
  currentWord = null;
  processResult({ correct: false, hintUsed: false, skipped: false, timedOut: true }, wordSnapshot.text, wordSnapshot);
}

// Unlimited replays (user-confirmed policy) — each one costs points via
// QuickEarMode's replay penalty and forfeits the first-try bonus, but never
// resets or extends the running countdown, so replaying is a genuine
// points-vs-clarity trade-off rather than a free reset.
function replayQuickEarAudio() {
  if (!currentWord || selectedMode !== 'quickear' || !isSessionActive) return;
  _qeReplayCount += 1;
  quickEarPlayWord();
  speakText(currentWord.text, currentWord.aiAnalysis?.audioBase64);
}

// ─── Tab-visibility pause/resume ────────────────────────────────────────────
// Bug: navigating away from the Game tab (to Vocab List/Review/Practice/
// Settings) never ran any teardown — only the *incoming* tab's dataset.target
// got special-cased in app.js's nav-tab handler, nothing fired for the
// *outgoing* one. Quick Ear's round loop is self-sustaining once started
// (timeout → processResult → nextRound → _startQuickEarRound → speakText →
// re-arm timer), completely independent of Phaser's render loop or whether
// #game-view is even visible, so it just kept playing audio and burning
// through the word queue in the background indefinitely. Race/Survival have
// the same latent issue (their modeInstance keeps ticking unseen), just
// without an audible symptom. app.js calls these two functions on every
// tab-away-from/tab-back-to game-view, regardless of whether a session is
// even active (both are no-ops via the isSessionActive guard when idle).
export function pauseGameSession() {
  if (!isSessionActive) return;
  VISUAL_MODES[selectedMode]?.pause?.();
  modeInstance?.pause?.();
  _clearQuickEarTimer();
}

export function resumeGameSession() {
  if (!isSessionActive) return;
  VISUAL_MODES[selectedMode]?.resume?.();
  modeInstance?.resume?.();
  // Only re-arm if a round was actually in progress (currentWord set) and
  // isn't already ticking — guards against double-arming if resume is ever
  // called twice in a row (e.g. a stray extra tab-click) without an
  // intervening pause.
  if (selectedMode === 'quickear' && currentWord && !_qeTimerId) {
    _armQuickEarTimer();
  }
}

// ─── Public Init ─────────────────────────────────────────────────────────────
export function initGame() {
  words = getWords();                      // Bug 6: sync — no await needed
  const profile = getProfile();            // Bug 6: sync — no await needed
  maxHints = maxHintsForLevel(profile.level);
  renderMenu(profile);

  if (!isSessionActive) showScreen('screen-menu');

  if (gameInitialized) return;
  gameInitialized = true;

  document.getElementById('btn-play')?.addEventListener('click', () => showScreen('screen-mode'));
  document.getElementById('btn-review')?.addEventListener('click', () => { renderReview(); showScreen('screen-review'); });
  // Scoped to #screen-mode: .mode-card is shared with the Practice tab's own
  // mode picker (index.html #practice-screen-modes), which uses the same CSS
  // class for visual consistency but a different data attribute
  // (data-practice-mode, not data-mode). An unscoped querySelectorAll here
  // would also bind this handler to those cards, setting selectedMode to
  // undefined whenever one is clicked and leaving the Game tab's next
  // session with no matching race/survival/mission branch.
  document.querySelectorAll('#screen-mode .mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('#screen-mode .mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedMode = card.dataset.mode;
      // Show/hide race word-count selector
      const racePicker = document.getElementById('race-word-count-wrap');
      if (racePicker) racePicker.style.display = selectedMode === 'race' ? '' : 'none';
      // Show/hide Quick Ear word-count selector (same pattern as Race's)
      const quickEarPicker = document.getElementById('quickear-word-count-wrap');
      if (quickEarPicker) quickEarPicker.style.display = selectedMode === 'quickear' ? 'flex' : 'none';
    });
  });

  // Race word-count selector (Bug 4)
  document.getElementById('race-word-count')?.addEventListener('change', e => {
    raceWordLimit = e.target.value === 'all' ? Infinity : parseInt(e.target.value, 10);
  });

  // Quick Ear word-count selector — same pattern as Race's
  document.getElementById('quickear-word-count')?.addEventListener('change', e => {
    quickEarWordLimit = e.target.value === 'all' ? Infinity : parseInt(e.target.value, 10);
  });

  document.getElementById('btn-start-game')?.addEventListener('click', startSession);
  document.getElementById('btn-hint')?.addEventListener('click', useHint);
  document.getElementById('btn-replay-audio')?.addEventListener('click', replayQuickEarAudio);
  document.getElementById('btn-skip')?.addEventListener('click', skipWord);
  document.getElementById('btn-play-again')?.addEventListener('click', () => { resetSession(); showScreen('screen-mode'); });
  document.getElementById('btn-back-menu')?.addEventListener('click', () => { const p = getProfile(); renderMenu(p); showScreen('screen-menu'); });
  document.getElementById('btn-back-menu-review')?.addEventListener('click', () => { const p = getProfile(); renderMenu(p); showScreen('screen-menu'); });
  document.getElementById('btn-quit-game')?.addEventListener('click', () => { modeInstance?.stop?.(); endSession({ quit: true }); });
  document.getElementById('answer-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitAnswer(); });
}

// ─── Session Management ───────────────────────────────────────────────────────
function resetSession() {
  isSessionActive = false;
  currentWord = null;
  // Bug 1: reset maxStreak alongside streak
  sessionStats = { correct: 0, totalAnswered: 0, hintCount: 0, wordsMastered: 0, streak: 0, maxStreak: 0 };
  raceQueue = [];
  raceLog = [];
  quickEarQueue = [];
  quickEarLog = [];
  _clearQuickEarTimer();
  _qeTimeLeft = QE_ROUND_SECONDS;
  _qeReplayCount = 0;
  if (modeInstance) modeInstance.stop?.();
  modeInstance = null;
  const missionEl = document.getElementById('mission-objectives');
  if (missionEl) missionEl.innerHTML = '';
}

async function startSession() {
  resetSession();
  words = getWords();                      // Bug 6: sync
  if (!words.length) { alert('Save some words first!'); return; }

  const onTick = (val) => {
    const el = document.getElementById('mode-status');
    if (el) el.textContent = modeInstance?.statusLabel() || '';
    if (selectedMode === 'race') {
      const bar = document.getElementById('race-bar');
      if (bar) bar.style.width = val + '%';
      setRaceProgress(val);
    } else if (selectedMode === 'survival') {
      // Fallback bar for when Phaser didn't load — previously this never
      // updated at all for Survival mode (a latent bug: the bar just sat
      // frozen at its default 50% width). val here is timeLeft in seconds
      // (0-120, starts at 60), so normalize against the 60s baseline the
      // same way survival-scene.js's fireLevel does.
      const bar = document.getElementById('race-bar');
      if (bar) bar.style.width = Math.min(100, (val / 60) * 100) + '%';
      setSurvivalTime(val);
    }
  };
  const onGameOver = () => endSession();

  if (selectedMode === 'race') {
    // Bug 4: build a finite shuffled queue
    const raceShuffled = shuffled(words);
    raceQueue = raceWordLimit === Infinity ? raceShuffled : raceShuffled.slice(0, raceWordLimit);
    modeInstance = new RaceMode(onTick, onGameOver);
  } else if (selectedMode === 'survival') {
    modeInstance = new SurvivalMode(onTick, onGameOver);
  } else if (selectedMode === 'mission') {
    modeInstance = new MissionMode();
  } else if (selectedMode === 'quickear') {
    // Same finite shuffled-queue pattern as Race (Bug 4) — Quick Ear also
    // ends by running out of words, not a continuous clock/objective check.
    const quickEarShuffled = shuffled(words);
    quickEarQueue = quickEarWordLimit === Infinity ? quickEarShuffled : quickEarShuffled.slice(0, quickEarWordLimit);
    modeInstance = new QuickEarMode();
  }

  isSessionActive = true;
  modeInstance.start?.();
  showScreen('screen-play');
  teardownAllVisualsExcept(selectedMode);
  setupVisual(selectedMode);
  nextRound();
}

// ─── Gameplay Loop ────────────────────────────────────────────────────────────
function nextRound() {
  if (!isSessionActive) return;

  if (selectedMode === 'race') {
    // Bug 4: pop from finite queue; empty queue = win
    if (!raceQueue.length) { endSession(); return; }
    currentWord = raceQueue.pop();
  } else if (selectedMode === 'quickear') {
    // Same finite-queue-pop pattern as Race
    if (!quickEarQueue.length) { endSession(); return; }
    currentWord = quickEarQueue.pop();
  } else {
    currentWord = selectNextWord(words);
    if (!currentWord) { endSession(); return; }
  }

  hintsUsedThisWord = 0;

  if (selectedMode === 'quickear') {
    // Audio-only — the word's definition would give away spelling context
    // a dictation test is meant to test without.
    document.getElementById('game-definition').textContent = '🎧 Listen and type what you hear';
  } else {
    document.getElementById('game-definition').textContent = currentWord.aiAnalysis?.definition || 'No definition available.';
  }
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
    updateMissionScene(modeInstance?.objectives);
  } else if (missionEl) {
    missionEl.innerHTML = '';
  }

  // Auto-play the word + start the 15s countdown. Must run after the input
  // is reset/focused above so the player can start typing the instant audio
  // begins — no extra click needed.
  if (selectedMode === 'quickear') {
    _startQuickEarRound(currentWord);
  }
}

function submitAnswer() {
  if (!currentWord || !isSessionActive) return;
  if (!currentWord.text) { skipWord(); return; }
  if (selectedMode === 'quickear') _clearQuickEarTimer();
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

  // Bug 3: calculate XP once, reuse for display and persistence
  const xp = calcXP(word, result, selectedMode);

  if (result.correct) {
    feedback.innerHTML = `<span class="feedback-correct">✓ Correct! +${xp} XP</span>`;
    sessionStats.correct += 1;
    sessionStats.streak += 1;
    // Bug 1: track peak streak
    if (sessionStats.streak > sessionStats.maxStreak) sessionStats.maxStreak = sessionStats.streak;
    if (selectedMode === 'quickear') {
      // QuickEarMode.onCorrect() has a different signature from every other
      // mode's onCorrect(hintUsed) — it scores off time remaining + replay
      // count, not hint usage (hints don't exist in this mode at all).
      const points = modeInstance?.onCorrect?.(_qeTimeLeft, _qeReplayCount) ?? 0;
      feedback.innerHTML += ` <span class="feedback-correct">(+${points} pts)</span>`;
      quickEarCorrect(modeInstance?.streak ?? 0);
    } else {
      modeInstance?.onCorrect?.(result.hintUsed);
    }
    if (selectedMode === 'race') raceCorrect();
    if (selectedMode === 'survival') survivalCorrect();
    if (selectedMode === 'mission') missionCorrect();
  } else if (result.skipped) {
    // Bug 2: skip is a soft action — show neutral feedback, don't call onWrong
    feedback.innerHTML = `<span class="feedback-wrong">→ Skipped: <strong>${escapeHtml(word.text)}</strong></span>`;
    sessionStats.streak = 0;
    modeInstance?.onSkip?.();
    if (selectedMode === 'race') raceSkip();
    if (selectedMode === 'survival') survivalSkip();
    if (selectedMode === 'mission') missionSkip();
    if (selectedMode === 'quickear') quickEarSkip();
  } else {
    // timedOut is Quick Ear-only (the 15s countdown ran out with nothing
    // submitted) — same scoring consequence as a wrong answer, distinguished
    // only in the feedback text so the player knows which one happened.
    const label = result.timedOut ? "⏱ Time's up! The answer was:" : '✗ The answer was:';
    feedback.innerHTML = `<span class="feedback-wrong">${label} <strong>${escapeHtml(revealWord)}</strong></span>`;
    sessionStats.streak = 0;
    modeInstance?.onWrong?.();
    if (selectedMode === 'race') raceWrong();
    if (selectedMode === 'survival') survivalWrong();
    if (selectedMode === 'mission') missionWrong();
    if (selectedMode === 'quickear') quickEarWrong();
  }

  // Quick Ear has no onTick-driven status refresh (QuickEarMode owns no
  // interval, unlike Race/Survival) — refresh the score readout here so it
  // updates immediately instead of lagging to the next round's nextRound() call.
  if (selectedMode === 'quickear') {
    const status = document.getElementById('mode-status');
    if (status && modeInstance) status.textContent = modeInstance.statusLabel();
  }

  // Race/Quick Ear log: record every answered word for the results-screen review
  if (selectedMode === 'race') {
    raceLog.push({ word, correct: result.correct, skipped: result.skipped });
  }
  if (selectedMode === 'quickear') {
    quickEarLog.push({ word, correct: result.correct, skipped: result.skipped });
  }

  // Re-render mission objectives immediately after onCorrect/onWrong/onSkip
  const missionEl = document.getElementById('mission-objectives');
  if (selectedMode === 'mission') {
    renderMissionObjectives(modeInstance?.objectives);
    updateMissionScene(modeInstance?.objectives);
  } else if (missionEl) {
    missionEl.innerHTML = '';
  }

  sessionStats.totalAnswered += 1;
  if (result.hintUsed) sessionStats.hintCount += 1;

  if (selectedMode === 'mission' && modeInstance.isComplete?.()) { endSession(); return; }

  if (isSessionActive) setTimeout(() => nextRound(), 800);

  try {
    const newState = nextLearningState(word, result);
    const newStats = updateStats(word.stats, result);
    if (newState === 'known' && word.learningState !== 'known') sessionStats.wordsMastered += 1;
    const idx = words.findIndex(w => w.text.toLowerCase() === word.text.toLowerCase());
    if (idx !== -1) words[idx] = { ...words[idx], learningState: newState, stats: newStats };
    await updateWord(word.text, { learningState: newState, stats: newStats });
    // Bug 3: reuse xp computed above
    if (xp > 0) await addXP(xp);
  } catch (err) {
    const fb = document.getElementById('feedback-area');
    if (fb) fb.innerHTML += '<span style="color:#f59e0b;font-size:11px;margin-left:6px;">(progress not saved)</span>';
  }
}

function useHint() {
  // Quick Ear has no hint mechanism (the button is hidden — see the
  // quickear entry's onSetup in VISUAL_MODES) — any hint would reveal
  // spelling info a dictation test is meant to test recall of. Defensive
  // guard in case this is ever reachable from somewhere other than the
  // hidden button.
  if (selectedMode === 'quickear') return;
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
  if (selectedMode === 'quickear') _clearQuickEarTimer();
  const wordSnapshot = currentWord;
  currentWord = null;
  processResult({ correct: false, hintUsed: false, skipped: true }, null, wordSnapshot);
}

// ─── End Session ──────────────────────────────────────────────────────────────
async function endSession(opts = {}) {
  if (!isSessionActive) return;
  isSessionActive = false;
  currentWord = null;
  _clearQuickEarTimer();

  // Race visual: win if the queue ran out while progress was still alive,
  // lose if RaceMode already ended it at 0 (see RaceMode.end() in
  // game-modes.js). A manual quit gets neither — just stop where it is.
  if (selectedMode === 'race' && !opts.quit) {
    if (modeInstance && modeInstance.progress > 0) raceWin();
    else raceLose();
  }

  // Survival visual: SurvivalMode has no win state — it always ends via
  // timeout (see SurvivalMode.end() in game-modes.js), so there's only one
  // terminal animation (fire dies out). A manual quit skips it, same as Race.
  if (selectedMode === 'survival' && !opts.quit) {
    survivalEnd();
  }

  // Mission visual: MissionMode has no "lose" state — the only non-quit way
  // a Mission session ends is isComplete() returning true (see the
  // isComplete?.() check in processResult()), so this is always a win.
  if (selectedMode === 'mission' && !opts.quit) {
    missionWin();
  }

  // Quick Ear visual: like Race, ends via the word queue running out — no
  // separate lose state (a wrong/timeout doesn't end the session early, it
  // just scores 0 and moves on), so a non-quit end is always a completion.
  if (selectedMode === 'quickear' && !opts.quit) {
    quickEarWin();
  }

  modeInstance?.stop?.();
  const profile = await recordSession(sessionStats);
  const newAchievements = checkAchievements(profile, sessionStats);
  for (const a of newAchievements) await unlockAchievement(a.id, a.title);

  // Word-review log: Race and Quick Ear both build one (see the log pushes
  // in processResult()); other modes don't have a natural per-word list to show.
  let reviewLog = null;
  if (selectedMode === 'race') reviewLog = raceLog;
  if (selectedMode === 'quickear') reviewLog = quickEarLog;

  // Quick Ear's running point total isn't represented anywhere in the
  // shared sessionStats shape (correct/accuracy/mastered) — pass it through
  // as an extra results-screen stat tile instead of overloading an existing field.
  const extraScore = (selectedMode === 'quickear' && modeInstance)
    ? { label: 'Score', value: modeInstance.score }
    : null;

  renderResults(profile, sessionStats, newAchievements, reviewLog, extraScore);
  showScreen('screen-results');
}

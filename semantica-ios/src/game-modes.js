// renderer/game-modes.js
// Race, Survival, and Mission mode implementations
// Copied from dashboard/game-modes.js — no changes needed

// ─── Race Mode ────────────────────────────────────────────────────────────────

export class RaceMode {
  constructor(onTick, onGameOver) {
    this.progress = 50;
    this.drainRate = 0.8;
    this.intervalId = null;
    this.onTick = onTick;
    this.onGameOver = onGameOver;
    this.active = false;
  }

  start() {
    this.active = true;
    this.progress = 50;
    this.intervalId = setInterval(() => {
      if (!this.active) return;
      this.progress = Math.max(0, this.progress - this.drainRate);
      this.onTick(this.progress);
      if (this.progress <= 0) this.end('lost');
    }, 200);
  }

  onCorrect() { this.progress = Math.min(100, this.progress + 20); }
  onWrong()   { this.progress = Math.max(0,  this.progress - 10); }
  onSkip()    { this.progress = Math.max(0,  this.progress - 5); } // half penalty vs wrong

  end(reason) {
    this.active = false;
    clearInterval(this.intervalId);
    this.onGameOver(reason);
  }

  stop() { this.active = false; clearInterval(this.intervalId); }

  statusLabel() { return `Progress: ${Math.round(this.progress)}%`; }
}

// ─── Survival Mode ────────────────────────────────────────────────────────────

export class SurvivalMode {
  constructor(onTick, onGameOver, initialSeconds = 60) {
    this.timeLeft = initialSeconds;
    this.intervalId = null;
    this.onTick = onTick;
    this.onGameOver = onGameOver;
    this.active = false;
  }

  start() {
    this.active = true;
    this.intervalId = setInterval(() => {
      if (!this.active) return;
      this.timeLeft = Math.max(0, this.timeLeft - 1);
      this.onTick(this.timeLeft);
      if (this.timeLeft <= 0) this.end();
    }, 1000);
  }

  onCorrect() { this.timeLeft = Math.min(120, this.timeLeft + 5); }
  onWrong()   {
    this.timeLeft = Math.max(0, this.timeLeft - 10);
    if (this.timeLeft <= 0 && this.active) this.end(); // end immediately; don't wait for next tick
  }
  onSkip()    { this.timeLeft = Math.max(0, this.timeLeft - 5); } // half penalty vs wrong; never triggers immediate end

  end() {
    this.active = false;
    clearInterval(this.intervalId);
    this.onGameOver('timeout');
  }

  stop() { this.active = false; clearInterval(this.intervalId); }

  statusLabel() {
    const m = Math.floor(this.timeLeft / 60);
    const s = String(this.timeLeft % 60).padStart(2, '0');
    return `${m}:${s}`;
  }
}

// ─── Mission Mode ─────────────────────────────────────────────────────────────

export class MissionMode {
  constructor(objectives) {
    this.objectives = objectives || MissionMode.defaultObjectives();
    this.correct = 0;
    this.totalAnswered = 0;
    this.hintCount = 0;
    this.noHintStreak = 0;
    this.active = true;
  }

  static defaultObjectives() {
    return [
      { type: 'correct',   label: 'Answer correctly', target: 10, current: 0 },
      { type: 'accuracy',  label: 'Accuracy ≥ 80%',   target: 80, current: 0 },
      { type: 'no_hints',  label: 'No-hint streak',   target: 3,  current: 0 }
    ];
  }

  onCorrect(hintUsed) {
    this.correct += 1;
    this.totalAnswered += 1;
    if (hintUsed) {
      this.hintCount += 1;
      this.noHintStreak = 0;
    } else {
      this.noHintStreak += 1;
    }
    this._updateObjectives();
  }

  onWrong() {
    this.totalAnswered += 1;
    this.noHintStreak = 0;
    this._updateObjectives();
  }

  onSkip() {
    // Skip doesn't count as wrong for accuracy, but resets no-hint streak
    this.noHintStreak = 0;
    this._updateObjectives();
  }

  _updateObjectives() {
    const accuracy = this.totalAnswered > 0
      ? Math.round((this.correct / this.totalAnswered) * 100) : 0;
    for (const obj of this.objectives) {
      if (obj.type === 'correct')  obj.current = this.correct;
      if (obj.type === 'accuracy') obj.current = accuracy;
      if (obj.type === 'no_hints') obj.current = this.noHintStreak;
    }
  }

  isComplete() {
    return this.objectives.every(o => o.current >= o.target);
  }

  statusLabel() {
    const done = this.objectives.filter(o => o.current >= o.target).length;
    return `Objectives: ${done}/${this.objectives.length}`;
  }

  stop() { this.active = false; }
}

// ─── Quick Ear Mode ───────────────────────────────────────────────────────────
// Hear the word, type what you heard, 15 seconds per word. Unlike Race/Survival,
// there is no continuous session-level clock for this class to own — the real
// per-word 15s countdown is driven by game-controller.js off actual elapsed
// time (see its _qe* timer, and radio-scene.js's cosmetic countdown ring that
// mirrors it), the same Hybrid Architecture split used everywhere else: this
// class only ever reacts to a round's outcome, it never runs its own interval.
//
// Scoring (per word, on a correct answer within the 15s window):
//   100 base
// + speed bonus, up to 50, linear on time remaining at submit (timeLeft/15 * 50)
// + first-try bonus, +20, only if the word was never replayed this round
// - replay penalty, 25 per replay, capped so a single word's total never goes
//   negative (Math.max(0, ...) at the end)
// + streak bonus, +5 per consecutive correct word, capped at +50
//
// A wrong answer or a timeout scores 0 for that word and resets the streak,
// but never subtracts from the running total — same non-punishing philosophy
// as MissionMode (a miss costs you the opportunity for that word's points,
// not previously-earned points).
export class QuickEarMode {
  constructor() {
    this.score = 0;
    this.correct = 0;
    this.wrong = 0; // includes timeouts — both are "didn't get it" for accuracy purposes
    this.totalAnswered = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.active = true;
  }

  /**
   * @param {number} timeLeft - seconds remaining (0-15) at the moment of submission
   * @param {number} replayCount - how many times the audio was replayed this round
   * @returns {number} points earned for this word (also added to this.score)
   */
  onCorrect(timeLeft, replayCount = 0) {
    this.correct += 1;
    this.totalAnswered += 1;
    this.streak += 1;
    if (this.streak > this.maxStreak) this.maxStreak = this.streak;

    const speedBonus    = Math.round(clampTimeLeft(timeLeft) / 15 * 50);
    const firstTryBonus = replayCount === 0 ? 20 : 0;
    const streakBonus   = Math.min(50, (this.streak - 1) * 5);
    const replayPenalty = replayCount * 25;

    const points = Math.max(0, 100 + speedBonus + firstTryBonus + streakBonus - replayPenalty);
    this.score += points;
    return points;
  }

  // Covers both a submitted-wrong answer and a timeout — same scoring
  // consequence either way (0 points, streak reset). game-controller.js
  // still distinguishes them in the feedback text shown to the user.
  onWrong() {
    this.wrong += 1;
    this.totalAnswered += 1;
    this.streak = 0;
    return 0;
  }

  onSkip() {
    this.totalAnswered += 1;
    this.streak = 0;
    return 0;
  }

  stop() { this.active = false; }

  statusLabel() { return `Score: ${this.score}`; }
}

// Guards against a caller passing a negative/undefined timeLeft (shouldn't
// happen — game-controller.js clamps its own countdown at 0 — but a scoring
// function should never let a bad input produce a negative bonus).
function clampTimeLeft(timeLeft) {
  const n = Number(timeLeft);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(15, n));
}

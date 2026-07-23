// renderer/game-modes.js
// Race, Survival, Mission, and Quick Ear mode implementations
// Originally copied from dashboard/game-modes.js; QuickEarMode was added
// here later (RaceMode/SurvivalMode/MissionMode are still unchanged copies).

// ─── Race Mode ────────────────────────────────────────────────────────────────

export class RaceMode {
  /**
   * @param {number} drainRate - progress lost per 200ms tick. Difficulty knob:
   *   Medium is the original 0.8; Easy drains 1.5× slower (the "time frame is
   *   1.5× longer than Medium" spec — same idle progress lasts 1.5× as long);
   *   Hard drains 1.5× faster (shortest time). See RACE_DRAIN_RATES in
   *   game-controller.js for the three values.
   */
  constructor(onTick, onGameOver, drainRate = 0.8) {
    this.progress = 50;
    this.drainRate = drainRate;
    this.intervalId = null;
    this.onTick = onTick;
    this.onGameOver = onGameOver;
    this.active = false;
  }

  start() {
    this.active = true;
    this.progress = 50;
    this._arm();
  }

  // Interval body lives here (not inlined in start()) so pause()/resume() can
  // re-arm the same tick logic without going through start()'s progress reset —
  // a bare interval-clear/recreate pair, unlike start()'s full restart.
  _arm() {
    clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      if (!this.active) return;
      this.progress = Math.max(0, this.progress - this.drainRate);
      this.onTick(this.progress);
      if (this.progress <= 0) this.end('lost');
    }, 200);
  }

  // Freezes progress in place (e.g. the player navigated away from the Game
  // tab) without ending the run — resume() picks back up from wherever
  // progress was left, unlike end()/stop() which are terminal.
  pause() { this.active = false; clearInterval(this.intervalId); }
  resume() { if (this.active) return; this.active = true; this._arm(); }

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
    this._arm();
  }

  // See RaceMode._arm() for why this is split out of start().
  _arm() {
    clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      if (!this.active) return;
      this.timeLeft = Math.max(0, this.timeLeft - 1);
      this.onTick(this.timeLeft);
      if (this.timeLeft <= 0) this.end();
    }, 1000);
  }

  // See RaceMode.pause()/resume() for the rationale.
  pause() { this.active = false; clearInterval(this.intervalId); }
  resume() { if (this.active) return; this.active = true; this._arm(); }

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
  }

  static defaultObjectives() {
    // Kept as the Medium tier for backward compatibility — a bare
    // `new MissionMode()` still behaves exactly as before difficulties existed.
    return MissionMode.objectivesForDifficulty('medium');
  }

  /**
   * Objective sets per difficulty. Medium is the original (pre-difficulty)
   * criteria unchanged; Easy lowers every bar, Hard raises them.
   */
  static objectivesForDifficulty(difficulty) {
    const tiers = {
      easy: [
        { type: 'correct',   label: 'Answer correctly', target: 6,  current: 0 },
        { type: 'accuracy',  label: 'Accuracy ≥ 65%',   target: 65, current: 0 },
        { type: 'no_hints',  label: 'No-hint streak',   target: 2,  current: 0 },
      ],
      medium: [
        { type: 'correct',   label: 'Answer correctly', target: 10, current: 0 },
        { type: 'accuracy',  label: 'Accuracy ≥ 80%',   target: 80, current: 0 },
        { type: 'no_hints',  label: 'No-hint streak',   target: 3,  current: 0 },
      ],
      hard: [
        { type: 'correct',   label: 'Answer correctly', target: 15, current: 0 },
        { type: 'accuracy',  label: 'Accuracy ≥ 90%',   target: 90, current: 0 },
        { type: 'no_hints',  label: 'No-hint streak',   target: 5,  current: 0 },
      ],
    };
    return tiers[difficulty] || tiers.medium;
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

  // Purely reactive — no interval/timer of its own to clean up (unlike
  // Race/Survival's stop()), kept for a consistent lifecycle interface.
  stop() {}
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

  // Purely reactive — no interval/timer of its own to clean up (unlike
  // Race/Survival's stop()), kept for a consistent lifecycle interface.
  stop() {}

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

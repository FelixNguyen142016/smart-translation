// dashboard/game-modes.js
// Race, Survival, and Mission mode implementations

// ─── Race Mode ────────────────────────────────────────────────────────────────
// Progress bar drains over time; correct answers push it forward, wrong pull it back.

export class RaceMode {
  constructor(onTick, onGameOver) {
    this.progress = 50;      // 0–100
    this.drainRate = 0.8;    // % per tick
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

  end(reason) {
    this.active = false;
    clearInterval(this.intervalId);
    this.onGameOver(reason);
  }

  stop() { this.active = false; clearInterval(this.intervalId); }

  statusLabel() { return `Progress: ${Math.round(this.progress)}%`; }
}

// ─── Survival Mode ────────────────────────────────────────────────────────────
// Countdown timer; correct +5s, wrong -10s. Reaches 0 → game over.

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
      this.timeLeft = Math.max(0, this.timeLeft - 1); // clamp to 0 so statusLabel never shows negative
      this.onTick(this.timeLeft);
      if (this.timeLeft <= 0) this.end();
    }, 1000);
  }

  onCorrect() { this.timeLeft = Math.min(120, this.timeLeft + 5); }
  onWrong()   { this.timeLeft = Math.max(0,   this.timeLeft - 10); }

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
// Complete 3 objectives to win: correct count, accuracy, no-hint streak.

export class MissionMode {
  constructor(objectives) {
    // objectives: [{ label, target, type: 'correct'|'accuracy'|'no_hints' }]
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

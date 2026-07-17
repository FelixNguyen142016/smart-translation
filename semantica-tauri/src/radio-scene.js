// renderer/radio-scene.js
// Phaser-powered visual for Game > Quick Ear mode: a retro radio broadcast
// tuning dial. Purely cosmetic — QuickEarMode (game-modes.js) only ever
// tracks score/streak, and the real 15-second-per-word countdown lives in
// game-controller.js (driven off actual elapsed time, with a plain-HTML
// fallback bar/text as the source of truth). This scene's countdown ring is
// a mirror of that real timer, not an independent clock — game-controller.js
// calls setQuickEarTimeLeft() on every tick and this scene just redraws.
//
// Same small-banner treatment as Race/Mission (800x130) — user explicitly
// confirmed this over an immersive full-card redesign, since the 15s
// speed-pressure mode needs the typing input front-and-center, not competing
// with a large scene for screen space.
//
// Deliberately renders no text in Phaser (same reasoning as the reverted
// Survival meteor text: native HTML anti-aliases far more crisply at small
// sizes than Phaser's text objects, especially for a fast-changing number
// like a countdown). The exact "N seconds left" readout lives in the HTML
// fallback/companion element in index.html; this canvas is the ambient
// visual layer around it — the countdown ring communicates urgency through
// color and fill, not digits.
//
// Every asset here is procedural (Graphics-generated textures + a live,
// per-tick-redrawn Graphics object for the ring + particle emitters) — same
// approach as survival-scene.js/mission-scene.js, no external image to load.

const LOGICAL_WIDTH  = 800;
const LOGICAL_HEIGHT = 130;
const DIAL_X = LOGICAL_WIDTH / 2;
const DIAL_Y = LOGICAL_HEIGHT / 2;
const DIAL_RADIUS = 34;
const RING_RADIUS = 46;
const RING_WIDTH  = 6;

// Dial tint tiers by streak length — grey (no streak) climbing to warm gold
// (long streak), same "reward sustained focus" idea as the flag colors in
// mission-scene.js, just expressed as a single glowing dial instead of
// discrete checkpoints.
const STREAK_TIERS = [
  { min: 0, color: 0x64748b },
  { min: 2, color: 0x38bdf8 },
  { min: 5, color: 0x22d3ee },
  { min: 8, color: 0xfbbf24 },
];

class RadioScene extends Phaser.Scene {
  constructor() {
    super('RadioScene');
  }

  create() {
    this.buildTextures();

    // Deep-dusk studio background — distinct from every other scene's palette
    // (Road Trip's blue sky, Survival's night sky, Mission's warm parchment).
    const sky = this.add.graphics();
    sky.fillGradientStyle(0x1e1b4b, 0x1e1b4b, 0x0f172a, 0x0f172a, 1);
    sky.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    // Faint static-noise specks scattered across the background for texture.
    for (let i = 0; i < 26; i++) {
      const x = Phaser.Math.Between(8, LOGICAL_WIDTH - 8);
      const y = Phaser.Math.Between(8, LOGICAL_HEIGHT - 8);
      const speck = this.add.image(x, y, 'speck').setAlpha(Phaser.Math.FloatBetween(0.08, 0.22));
      speck.setScale(Phaser.Math.FloatBetween(0.5, 1.1));
    }

    // The dial itself — white-based texture, tinted per streak tier via setTint().
    this.dial = this.add.image(DIAL_X, DIAL_Y, 'dial').setTint(STREAK_TIERS[0].color);
    this.dialGlow = this.add.image(DIAL_X, DIAL_Y, 'dialGlow').setTint(STREAK_TIERS[0].color).setAlpha(0.35).setBlendMode('ADD');

    // Countdown ring — a live Graphics object, cleared and redrawn every
    // setQuickEarTimeLeft() call (it changes too often to bake as a texture).
    this.ring = this.add.graphics();
    this.drawRing(1);

    // Sound-wave ripple emitter — bursts outward from the dial each time the
    // word plays (round start + every replay).
    this.rippleEmitter = this.add.particles(DIAL_X, DIAL_Y, 'ripple', {
      speed: 0,
      scale: { start: 0.3, end: 2.4 },
      alpha: { start: 0.55, end: 0 },
      lifespan: 650,
      quantity: 1,
    });
    this.rippleEmitter.stop();

    // Correct-answer burst.
    this.sparkEmitter = this.add.particles(DIAL_X, DIAL_Y, 'spark', {
      speed: { min: 60, max: 140 },
      angle: { min: 0, max: 360 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 300, max: 500 },
      quantity: 1,
      blendMode: 'ADD',
    });
    this.sparkEmitter.stop();

    // Wrong/timeout static burst.
    this.staticEmitter = this.add.particles(DIAL_X, DIAL_Y, 'staticBit', {
      speed: { min: 40, max: 160 },
      angle: { min: 0, max: 360 },
      scale: { start: 0.8, end: 0 },
      alpha: { start: 0.9, end: 0 },
      lifespan: { min: 200, max: 400 },
      quantity: 1,
      tint: 0xcbd5e1,
    });
    this.staticEmitter.stop();

    this.currentStreakTier = 0;

    if (_pendingTimeLeft !== null) {
      this.drawRing(_pendingTimeLeft.frac);
      _pendingTimeLeft = null;
    }
  }

  buildTextures() {
    const speck = this.add.graphics();
    speck.fillStyle(0xffffff, 1);
    speck.fillCircle(2, 2, 2);
    speck.generateTexture('speck', 4, 4);
    speck.destroy();

    // Dial: white base so a single texture tints cleanly per streak tier.
    const dial = this.add.graphics();
    dial.fillStyle(0xffffff, 1);
    dial.fillCircle(DIAL_RADIUS, DIAL_RADIUS, DIAL_RADIUS);
    dial.fillStyle(0x0f172a, 0.55);
    dial.fillCircle(DIAL_RADIUS, DIAL_RADIUS, DIAL_RADIUS * 0.62);
    dial.fillStyle(0xffffff, 0.9);
    dial.fillCircle(DIAL_RADIUS, DIAL_RADIUS, DIAL_RADIUS * 0.12);
    dial.generateTexture('dial', DIAL_RADIUS * 2, DIAL_RADIUS * 2);
    dial.destroy();

    const glow = this.add.graphics();
    glow.fillStyle(0xffffff, 1);
    glow.fillCircle(DIAL_RADIUS * 1.4, DIAL_RADIUS * 1.4, DIAL_RADIUS * 1.4);
    glow.generateTexture('dialGlow', DIAL_RADIUS * 2.8, DIAL_RADIUS * 2.8);
    glow.destroy();

    const ripple = this.add.graphics();
    ripple.lineStyle(3, 0xffffff, 1);
    ripple.strokeCircle(RING_RADIUS, RING_RADIUS, RING_RADIUS * 0.7);
    ripple.generateTexture('ripple', RING_RADIUS * 2, RING_RADIUS * 2);
    ripple.destroy();

    const spark = this.add.graphics();
    spark.fillStyle(0xffffff, 1);
    spark.fillCircle(3, 3, 3);
    spark.generateTexture('spark', 6, 6);
    spark.destroy();

    const staticBit = this.add.graphics();
    staticBit.fillStyle(0xffffff, 1);
    staticBit.fillRect(0, 0, 4, 4);
    staticBit.generateTexture('staticBit', 4, 4);
    staticBit.destroy();
  }

  // frac: 0-1 fraction of time remaining. Color shifts green -> amber -> red
  // as the deadline approaches, independent of the streak-tint on the dial
  // itself, so urgency is always readable regardless of streak color.
  drawRing(frac) {
    if (!this.ring) { _pendingTimeLeft = { frac }; return; }
    const clamped = Phaser.Math.Clamp(frac, 0, 1);
    const color = clamped > 0.5 ? 0x34d399 : clamped > 0.2 ? 0xfbbf24 : 0xf87171;
    this.ring.clear();
    if (clamped <= 0) return;
    this.ring.lineStyle(RING_WIDTH, color, 0.9);
    const start = -Math.PI / 2; // 12 o'clock
    const end = start + clamped * Math.PI * 2;
    this.ring.beginPath();
    this.ring.arc(DIAL_X, DIAL_Y, RING_RADIUS, start, end, false);
    this.ring.strokePath();
  }

  playWord() {
    this.rippleEmitter.explode(1, DIAL_X, DIAL_Y);
    this.time.delayedCall(120, () => this.rippleEmitter?.explode(1, DIAL_X, DIAL_Y));
    this.time.delayedCall(240, () => this.rippleEmitter?.explode(1, DIAL_X, DIAL_Y));
  }

  playCorrect(streak = 0) {
    let tier = STREAK_TIERS[0];
    for (const t of STREAK_TIERS) if (streak >= t.min) tier = t;
    this.dial.setTint(tier.color);
    this.dialGlow.setTint(tier.color);
    this.sparkEmitter.explode(14, DIAL_X, DIAL_Y);
    this.tweens.add({ targets: [this.dial, this.dialGlow], scale: 1.18, duration: 120, yoyo: true, ease: 'Quad.easeOut' });
  }

  playWrong() {
    this.cameras.main.shake(120, 0.006);
    this.staticEmitter.explode(16, DIAL_X, DIAL_Y);
    this.dial.setTint(STREAK_TIERS[0].color);
    this.dialGlow.setTint(STREAK_TIERS[0].color);
    this.tweens.add({ targets: this.dial, angle: 6, duration: 60, yoyo: true, repeat: 2, ease: 'Sine.easeInOut', onComplete: () => { this.dial.angle = 0; } });
  }

  playSkip() {
    this.tweens.add({ targets: [this.dial, this.dialGlow], alpha: 0.4, duration: 100, yoyo: true });
  }

  playWin() {
    for (let i = 0; i < 3; i++) {
      this.time.delayedCall(i * 130, () => this.sparkEmitter.explode(18, DIAL_X, DIAL_Y));
    }
    this.tweens.add({ targets: [this.dial, this.dialGlow], scale: 1.3, duration: 260, yoyo: true, repeat: 2, ease: 'Sine.easeInOut' });
  }

  reset() {
    this.dial.setTint(STREAK_TIERS[0].color).setScale(1).setAlpha(1).setAngle(0);
    this.dialGlow.setTint(STREAK_TIERS[0].color).setScale(1).setAlpha(0.35);
    this.drawRing(1);
    this.rippleEmitter.stop();
    this.sparkEmitter.stop();
    this.staticEmitter.stop();
  }
}

let _game = null;
let _scene = null;
let _pendingTimeLeft = null;

export function mountQuickEarScene(containerId) {
  if (_game || typeof Phaser === 'undefined') return;
  const container = document.getElementById(containerId);
  if (!container) return;

  _game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: containerId,
    transparent: true,
    banner: false,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
    },
    scene: RadioScene,
  });

  _game.events.once('ready', () => {
    _scene = _game.scene.getScene('RadioScene');
  });
}

export function isQuickEarSceneAvailable() {
  return typeof Phaser !== 'undefined';
}

export function resetQuickEarScene() {
  _game?.scale?.refresh();
  _scene?.reset?.();
}

// Pause/resume the Phaser render loop (not destroy — see race-scene.js's
// pauseRaceScene() for the full rationale) so an inactive mode's RAF loop,
// tweens, and particle emitters don't keep running in a hidden container.
export function pauseQuickEarScene()  { _game?.loop?.sleep(); }
export function resumeQuickEarScene() { _game?.loop?.wake(); }

/** secondsLeft/totalSeconds — called every controller tick to keep the ring in sync with the real countdown. */
export function setQuickEarTimeLeft(secondsLeft, totalSeconds = 15) {
  const frac = totalSeconds > 0 ? secondsLeft / totalSeconds : 0;
  if (_scene) _scene.drawRing(frac);
  else _pendingTimeLeft = { frac };
}

export function quickEarPlayWord()      { _scene?.playWord?.(); }
export function quickEarCorrect(streak) { _scene?.playCorrect?.(streak); }
export function quickEarWrong()         { _scene?.playWrong?.(); }
export function quickEarSkip()          { _scene?.playSkip?.(); }
export function quickEarWin()           { _scene?.playWin?.(); }

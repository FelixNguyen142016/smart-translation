// renderer/mission-scene.js
// Phaser-powered visual for Game > Mission mode: an "Expedition Path" —
// an explorer marker advancing across a map toward 3 flagged checkpoints,
// one per MissionMode objective. Purely cosmetic — MissionMode (game-modes.js)
// still owns all objective tracking; this module only ever receives the
// current objectives array plus discrete correct/wrong/skip/win events.
//
// Deliberately kept as a small banner (same 800x130 treatment as Race mode's
// original layout), NOT the full-immersive-canvas treatment Survival mode
// got — that redesign was specifically requested for Survival's own layout
// problem, not asked for here, so this stays with the lower-risk, already-
// proven small-banner pattern. #mission-objectives' existing plain-text
// checklist stays exactly as-is alongside this scene (the flags can't show
// exact numbers like "7/10" — the text list still does that).
//
// Every asset here is procedural (Graphics-generated textures + particle
// emitters), same approach as survival-scene.js — no external image to
// load, so none of Road Trip's WKWebView/XHR-on-data-URI issues apply.
//
// Design note on the explorer's position: it's driven by the *average*
// fractional progress across all 3 objectives, using a high-water-mark
// (this.bestProgress) that only ever increases. MissionMode's onWrong()
// doesn't reset any objective's progress — it only resets the no-hint
// streak — but a wrong answer *can* nudge the accuracy objective's current
// value down (more total answers, same correct count). Rather than letting
// the explorer visibly slide backward on a wrong answer (which would read
// as a punishment the mode doesn't actually apply), the high-water-mark
// keeps forward motion monotonic; playWrong() plays a stumble wobble
// instead, which is the intended "something went wrong" signal.
//
// Checkpoint flags light up independently, keyed to their own objective's
// completion — they are achievement markers, not waypoints the explorer
// must physically reach in order. A flag can light up "ahead of" the
// explorer's current position if that specific objective (e.g. the no-hint
// streak) completes before the others; this is intentional, same as ticking
// item 3 off a checklist before items 1-2.

import { readBrandColor } from './scene-color-utils.js';

const LOGICAL_WIDTH  = 800;
const LOGICAL_HEIGHT = 130;
const GROUND_TOP = 92;   // sky/map above, path area below
const TRAIL_Y    = 108;  // dashed trail line
const EXPLORER_Y = 100;  // explorer sits just above the trail
const MARGIN     = 50;
const CHECKPOINT_FRACS = [0.28, 0.58, 0.88]; // positions along the trail, one per objective (in objectives[] order)
const CHECKPOINT_COLORS = [0x34d399, 0xfbbf24, 0x60a5fa]; // emerald / amber / sky — purely for variety, not tied to objective type

class ExpeditionScene extends Phaser.Scene {
  constructor() {
    super('ExpeditionScene');
    this.bestProgress = 0;
    this.checkpointLit = [false, false, false];
  }

  create() {
    this.bestProgress = 0;
    this.checkpointLit = [false, false, false];

    this.buildTextures();

    // Warm parchment/map-style background (distinct from Road Trip's blue
    // sky and Survival's night sky, so each mode has its own visual identity)
    const sky = this.add.graphics();
    sky.fillGradientStyle(0xfef3c7, 0xfef3c7, 0xfde68a, 0xfde68a, 1);
    sky.fillRect(0, 0, LOGICAL_WIDTH, GROUND_TOP);

    const ground = this.add.graphics();
    ground.fillStyle(0xd6c9a8, 1);
    ground.fillRect(0, GROUND_TOP, LOGICAL_WIDTH, LOGICAL_HEIGHT - GROUND_TOP);

    // Dashed trail — static (the explorer moves across it; the world doesn't scroll)
    const trail = this.add.graphics();
    trail.fillStyle(0x92714a, 0.85);
    for (let x = MARGIN; x < LOGICAL_WIDTH - MARGIN; x += 26) {
      trail.fillRect(x, TRAIL_Y - 2, 14, 3);
    }

    // Checkpoint flags — unlit (grey) until their objective completes
    this.checkpoints = CHECKPOINT_FRACS.map((frac) => {
      const x = MARGIN + (LOGICAL_WIDTH - MARGIN * 2) * frac;
      return this.add.image(x, TRAIL_Y - 2, 'flagPole').setOrigin(0.5, 1).setTint(0x9ca3af);
    });

    // Explorer — container so the idle bob (child image's local y) and
    // forward movement (container's x) never fight over the same property.
    this.explorerContainer = this.add.container(this.xForProgress(0), EXPLORER_Y);
    this.explorerPin = this.add.image(0, 0, 'explorerPin').setOrigin(0.5, 1).setTint(readBrandColor());
    this.explorerContainer.add(this.explorerPin);
    this.bobTween = this.tweens.add({
      targets: this.explorerPin, y: -4, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    // Dust puff — idle by default, only bursts while the explorer is moving
    this.dustEmitter = this.add.particles(0, 0, 'dustPuff', {
      speed: { min: 10, max: 30 },
      angle: { min: 200, max: 340 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.6, end: 0 },
      tint: 0xa88a5c,
      lifespan: 300,
      quantity: 1,
      frequency: 40,
    });
    this.dustEmitter.startFollow(this.explorerContainer, 0, 2);
    this.dustEmitter.stop();

    // Checkpoint/win celebration bursts — idle by default, only used via .explode()
    this.sparkleEmitter = this.add.particles(0, 0, 'sparkle', {
      speed: { min: 40, max: 90 },
      angle: { min: 0, max: 360 },
      scale: { start: 1, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 300, max: 500 },
      quantity: 1,
      blendMode: 'ADD',
    });
    this.sparkleEmitter.stop();

    if (_pendingObjectives !== null) {
      this.updateProgress(_pendingObjectives);
      _pendingObjectives = null;
    }
  }

  buildTextures() {
    // Flag pole — white base so a single texture can be tinted grey
    // (unlit) or a bright color (lit) via setTint() rather than needing
    // two separate texture variants.
    const flag = this.add.graphics();
    flag.fillStyle(0xffffff, 1);
    flag.fillRect(11, 4, 3, 46);
    flag.beginPath();
    flag.moveTo(14, 4); flag.lineTo(34, 12); flag.lineTo(14, 20);
    flag.closePath(); flag.fillPath();
    flag.generateTexture('flagPole', 38, 52);
    flag.destroy();

    // Map-pin marker, polygon-approximated teardrop (same lineTo/moveTo
    // technique proven safe elsewhere in this codebase) + a dark accent dot.
    const pin = this.add.graphics();
    pin.fillStyle(0xffffff, 1);
    pin.beginPath();
    pin.moveTo(12, 34);
    pin.lineTo(3, 18); pin.lineTo(1, 10); pin.lineTo(6, 2);
    pin.lineTo(18, 2); pin.lineTo(23, 10); pin.lineTo(21, 18);
    pin.closePath();
    pin.fillPath();
    pin.fillStyle(0x1e293b, 0.85);
    pin.fillCircle(12, 11, 5);
    pin.generateTexture('explorerPin', 24, 36);
    pin.destroy();

    const dust = this.add.graphics();
    dust.fillStyle(0xffffff, 1);
    dust.fillCircle(3, 3, 3);
    dust.generateTexture('dustPuff', 6, 6);
    dust.destroy();

    const sparkle = this.add.graphics();
    sparkle.fillStyle(0xffffff, 1);
    sparkle.fillCircle(3, 3, 3);
    sparkle.generateTexture('sparkle', 6, 6);
    sparkle.destroy();
  }

  xForProgress(p) {
    const clamped = Phaser.Math.Clamp(p, 0, 1);
    return MARGIN + (LOGICAL_WIDTH - MARGIN * 2) * clamped;
  }

  // Called after every processResult() with the live MissionMode.objectives
  // array. Advances the explorer (high-water-mark, see module comment) and
  // lights up any checkpoint whose objective has newly completed.
  updateProgress(objectives) {
    if (!this.explorerContainer) { _pendingObjectives = objectives; return; }
    if (!objectives || !objectives.length) return;

    const fracs = objectives.map(o => Phaser.Math.Clamp((o.current || 0) / (o.target || 1), 0, 1));
    const avg = fracs.reduce((a, b) => a + b, 0) / fracs.length;

    if (avg > this.bestProgress) {
      this.bestProgress = avg;
      if (this.posTween) this.posTween.stop();
      this.dustEmitter.start();
      this.posTween = this.tweens.add({
        targets: this.explorerContainer,
        x: this.xForProgress(this.bestProgress),
        duration: 420,
        ease: 'Sine.easeOut',
        onComplete: () => this.dustEmitter.stop(),
      });
    }

    fracs.forEach((f, i) => {
      if (f >= 1 && !this.checkpointLit[i] && this.checkpoints[i]) {
        this.checkpointLit[i] = true;
        this._lightCheckpoint(i);
      }
    });
  }

  _lightCheckpoint(i) {
    const flag = this.checkpoints[i];
    flag.setTint(CHECKPOINT_COLORS[i] ?? 0x34d399);
    this.tweens.add({ targets: flag, scale: 1.3, duration: 140, yoyo: true, ease: 'Quad.easeOut' });
    this.sparkleEmitter.explode(10, flag.x, flag.y - 30);
  }

  // Small hop for correct-answer feedback — the actual forward movement
  // (if any) is handled by updateProgress(), called separately.
  playCorrect() {
    this.tweens.add({ targets: this.explorerContainer, y: EXPLORER_Y - 10, duration: 100, yoyo: true, ease: 'Quad.easeOut' });
  }

  // Stumble — a soft wobble, deliberately no lost ground (see module comment).
  playWrong() {
    this.cameras.main.shake(90, 0.004);
    this.tweens.add({
      targets: this.explorerContainer,
      angle: -12,
      duration: 80,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => { this.explorerContainer.angle = 0; },
    });
  }

  playSkip() {
    this.tweens.add({ targets: this.explorerContainer, alpha: 0.5, duration: 100, yoyo: true });
  }

  // Mission complete — MissionMode has no "lose" state (only a manual quit
  // skips this), so this is the only terminal animation.
  playWin() {
    const x = this.explorerContainer.x, y = this.explorerContainer.y - 20;
    for (let i = 0; i < 3; i++) {
      this.time.delayedCall(i * 120, () => this.sparkleEmitter.explode(16, x, y));
    }
    this.tweens.add({
      targets: this.explorerContainer, y: EXPLORER_Y - 16, duration: 260, yoyo: true, repeat: 2, ease: 'Sine.easeInOut',
    });
  }

  reset() {
    this.bestProgress = 0;
    this.checkpointLit = [false, false, false];
    if (this.posTween) this.posTween.stop();
    this.explorerContainer.setPosition(this.xForProgress(0), EXPLORER_Y);
    this.explorerContainer.setAngle(0);
    this.explorerContainer.setAlpha(1);
    this.checkpoints.forEach(f => { f.setTint(0x9ca3af); f.setScale(1); });
    this.dustEmitter.stop();
  }
}

let _game = null;
let _scene = null;
let _pendingObjectives = null;

/** Mount the Phaser game into the given container element (idempotent — only creates once, safe to call every mission start). */
export function mountMissionScene(containerId) {
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
    scene: ExpeditionScene,
  });

  _game.events.once('ready', () => {
    _scene = _game.scene.getScene('ExpeditionScene');
  });
}

export function isMissionSceneAvailable() {
  return typeof Phaser !== 'undefined';
}

export function updateMissionScene(objectives) {
  if (_scene) _scene.updateProgress(objectives);
  else _pendingObjectives = objectives;
}

export function resetMissionScene() {
  _game?.scale?.refresh();
  _scene?.reset?.();
}

export function missionCorrect() { _scene?.playCorrect?.(); }
export function missionWrong()   { _scene?.playWrong?.(); }
export function missionSkip()    { _scene?.playSkip?.(); }
export function missionWin()     { _scene?.playWin?.(); }

// Pause/resume the Phaser render loop (not destroy — see race-scene.js's
// pauseRaceScene() for the full rationale) so an inactive mode's RAF loop,
// tweens, and particle emitters don't keep running in a hidden container.
export function pauseMissionScene()  { _game?.loop?.sleep(); }
export function resumeMissionScene() { _game?.loop?.wake(); }

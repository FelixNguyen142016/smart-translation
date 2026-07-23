// renderer/survival-scene.js
// Phaser-powered visual for Game > Survival mode: a campfire at night whose
// flame height/intensity tracks SurvivalMode's timeLeft. Purely cosmetic —
// SurvivalMode (game-modes.js) still owns all timing/scoring; this module
// only ever receives a timeLeft number plus discrete correct/wrong/skip/end
// events to react to.
//
// Unlike race-scene.js, every visual asset here is procedural (Graphics-
// generated textures + particle emitters) — there is no external image to
// load, so none of Road Trip's WKWebView/XHR-on-data-URI headaches apply.
// The campfire never needs to react to the user's accent color either
// (firelight reads the same regardless of theme preset), so there's no
// brand-color plumbing like race-scene.js's readBrandColor().
//
// game-controller.js checks `typeof Phaser !== 'undefined'` before calling
// into this module at all, so a failed/offline CDN load just leaves the
// Game tab on its original plain countdown text (see #mode-status /
// .race-bar-wrap in index.html).
//
// Immersive layout: this scene fills the entire game-play card (see the
// .immersive-survival CSS block in index.html) instead of a small header
// banner. LOGICAL_WIDTH:HEIGHT is fixed at 480:640 (3:4) specifically to
// match the CSS aspect-ratio on .game-play-card.immersive-survival, so
// Phaser's Scale.FIT mode never letterboxes.
//
// The definition text itself uses the original plain approach (an HTML box
// folded into the floating control panel — see .game-definition-box inside
// .survival-control-panel in index.html) rather than anything tracked
// inside the Phaser scene; an earlier revision tried a falling "meteor"
// version of this and it was reverted (rendering bug + not what was wanted).

const LOGICAL_WIDTH  = 480;
const LOGICAL_HEIGHT = 640;
// Vertical center of the campfire's own "stage" — kept clear of both the
// open sky above and the floating control panel below. Earlier revisions
// grounded the fire near the very bottom of the canvas, which collided with
// the control panel once the fire was made bigger (the panel covered most
// of it). Stars are confined above this line; the panel covers well below it.
const STAGE_Y = 300;
const BASELINE_SECONDS = 60; // SurvivalMode's starting timeLeft — fireLevel 1.0 maps to this

class CampfireScene extends Phaser.Scene {
  constructor() {
    super('CampfireScene');
    this.timeLeft = BASELINE_SECONDS;
    this.fireLevel = 1;
    this.ended = false;
  }

  create() {
    this.timeLeft = BASELINE_SECONDS;
    this.fireLevel = 1;
    this.ended = false;

    this.buildTextures();

    // Night sky — fills the whole canvas now (no separate ground strip; the
    // bottom of the canvas sits behind the floating control panel anyway).
    const sky = this.add.graphics();
    sky.fillGradientStyle(0x0f172a, 0x0f172a, 0x1e293b, 0x1e293b, 1);
    sky.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

    // Stars — confined to the open sky above the campfire's stage, gentle
    // independent twinkle via alpha tweens.
    for (let i = 0; i < 18; i++) {
      const star = this.add.image(
        Phaser.Math.Between(20, LOGICAL_WIDTH - 20),
        Phaser.Math.Between(16, STAGE_Y - 60),
        'star',
      ).setAlpha(Phaser.Math.FloatBetween(0.3, 0.9));
      this.tweens.add({
        targets: star,
        alpha: Phaser.Math.FloatBetween(0.12, 0.35),
        duration: Phaser.Math.Between(1200, 2600),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    this.fireX = LOGICAL_WIDTH / 2;
    this.fireY = STAGE_Y;

    // Small dirt clearing the campfire sits in — replaces the old full-width
    // ground strip (which would now be entirely hidden behind the control
    // panel) with a patch localized to the stage area instead.
    this.add.ellipse(this.fireX, this.fireY + 26, 200, 46, 0x1c1917, 0.9);
    this.add.ellipse(this.fireX, this.fireY + 22, 156, 30, 0x28211c, 0.9);

    // Log pile base (static) + a matching ash-tinted twin, hidden until playEnd()
    this.logPile   = this.add.image(this.fireX, this.fireY + 6, 'logPile');
    this.ashOverlay = this.add.image(this.fireX, this.fireY + 6, 'logPile').setTint(0x374151).setAlpha(0);

    // Flame silhouette — origin at its base so scaling grows/shrinks upward
    this.flame = this.add.image(this.fireX, this.fireY, 'flameShape').setOrigin(0.5, 1);

    // Flicker particles — the "body" of the fire, additive-blended for glow
    this.flameEmitter = this.add.particles(this.fireX, this.fireY - 6, 'flameParticle', {
      x: { min: -14, max: 14 },
      angle: { min: 255, max: 285 },
      speed: { min: 30, max: 70 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: [0xfde047, 0xf97316, 0xef4444],
      lifespan: { min: 280, max: 460 },
      frequency: 35,
      quantity: 1,
      blendMode: 'ADD',
    });

    // Embers — sparse, rise higher and further than the flame body
    this.emberEmitter = this.add.particles(this.fireX, this.fireY - 16, 'emberParticle', {
      x: { min: -16, max: 16 },
      angle: { min: 250, max: 290 },
      speed: { min: 55, max: 120 },
      scale: { start: 1.4, end: 0.2 },
      alpha: { start: 1, end: 0 },
      tint: [0xfacc15, 0xfb923c],
      lifespan: { min: 550, max: 950 },
      frequency: 200,
      quantity: 1,
      blendMode: 'ADD',
      gravityY: -22, // slight upward drift instead of falling
    });

    // Smoke — idle by default; only used for one-shot bursts (wind gust / death)
    this.smokeEmitter = this.add.particles(this.fireX, this.fireY - 30, 'smokeParticle', {
      x: { min: -6, max: 6 },
      angle: { min: 240, max: 300 },
      speed: { min: 15, max: 35 },
      scale: { start: 0.6, end: 1.5 },
      alpha: { start: 0.55, end: 0 },
      lifespan: 700,
      frequency: 260,
      quantity: 1,
    });
    this.smokeEmitter.stop();

    this.applyFireLevel();

    if (_pendingTime !== null) {
      this.setTime(_pendingTime, true);
      _pendingTime = null;
    }
  }

  // Procedural textures — no image assets at all for this scene.
  buildTextures() {
    const star = this.add.graphics();
    star.fillStyle(0xffffff, 1);
    star.fillCircle(2, 2, 2);
    star.generateTexture('star', 4, 4);
    star.destroy();

    // Log pile / single log / flame silhouette — sized ~1.8x their original
    // dimensions so the campfire reads as a hero visual in the bigger
    // immersive canvas instead of a small accent (see applyFireLevel()'s
    // scale formula too, which was bumped alongside these).
    const logs = this.add.graphics();
    logs.fillStyle(0x78350f, 1);
    logs.fillRoundedRect(0, 14, 72, 18, 7);
    logs.fillStyle(0x92400e, 1);
    logs.fillRoundedRect(11, 0, 58, 18, 7);
    logs.generateTexture('logPile', 76, 36);
    logs.destroy();

    const log = this.add.graphics();
    log.fillStyle(0x92400e, 1);
    log.fillRoundedRect(0, 0, 29, 13, 5);
    log.fillStyle(0x78350f, 0.7);
    log.fillRoundedRect(4, 2, 7, 9, 4);
    log.generateTexture('logSingle', 29, 13);
    log.destroy();

    // Layered flame silhouette: red-orange outer, orange mid, yellow inner —
    // stacked jagged polygons approximating a flickering flame outline.
    const flame = this.add.graphics();
    flame.fillStyle(0xea580c, 1);
    flame.beginPath();
    flame.moveTo(36, 108); flame.lineTo(7, 61);  flame.lineTo(18, 36); flame.lineTo(7, 11);
    flame.lineTo(36, 0);   flame.lineTo(65, 11); flame.lineTo(54, 36); flame.lineTo(65, 61);
    flame.closePath(); flame.fillPath();
    flame.fillStyle(0xf97316, 1);
    flame.beginPath();
    flame.moveTo(36, 104); flame.lineTo(16, 65); flame.lineTo(25, 40); flame.lineTo(16, 18);
    flame.lineTo(36, 7);   flame.lineTo(56, 18); flame.lineTo(47, 40); flame.lineTo(56, 65);
    flame.closePath(); flame.fillPath();
    flame.fillStyle(0xfde047, 1);
    flame.beginPath();
    flame.moveTo(36, 97); flame.lineTo(23, 65); flame.lineTo(31, 43); flame.lineTo(23, 25);
    flame.lineTo(36, 18); flame.lineTo(49, 25); flame.lineTo(41, 43); flame.lineTo(49, 65);
    flame.closePath(); flame.fillPath();
    flame.generateTexture('flameShape', 72, 108);
    flame.destroy();

    const flameP = this.add.graphics();
    flameP.fillStyle(0xffffff, 1);
    flameP.fillCircle(6, 6, 6);
    flameP.generateTexture('flameParticle', 12, 12);
    flameP.destroy();

    const emberP = this.add.graphics();
    emberP.fillStyle(0xffffff, 1);
    emberP.fillCircle(3, 3, 3);
    emberP.generateTexture('emberParticle', 6, 6);
    emberP.destroy();

    const smokeP = this.add.graphics();
    smokeP.fillStyle(0xffffff, 0.5);
    smokeP.fillCircle(8, 8, 8);
    smokeP.generateTexture('smokeParticle', 16, 16);
    smokeP.destroy();
  }

  // Applies the current this.fireLevel to the flame shape + emitter intensity.
  // fireLevel is a plain number tweened by setTime() — Phaser's tweens.addCounter
  // handles the smoothing, this just re-reads the value each step.
  applyFireLevel() {
    const lvl = Phaser.Math.Clamp(this.fireLevel, 0.08, 1.6);
    this.flame.setScale(0.9 + 0.7 * lvl);
    this.flameEmitter.setScale({ start: 0.7 + 0.8 * lvl, end: 0 });
    this.flameEmitter.setQuantity(lvl > 0.15 ? Math.max(1, Math.round(lvl * 2)) : 1);
    this.emberEmitter.setQuantity(lvl > 0.5 ? 1 : 0);
  }

  // timeLeft is SurvivalMode's raw seconds (0-120, starts at 60). fireLevel
  // 1.0 = the 60s baseline; banking bonus time (correct answers push past
  // 60s) grows the fire beyond its starting size as a reward, up to 1.6x.
  setTime(timeLeft, immediate = false) {
    this.timeLeft = timeLeft;
    const target = Phaser.Math.Clamp(timeLeft / BASELINE_SECONDS, 0, 1.6);
    if (immediate || !this.flame) {
      this.fireLevel = target;
      this.applyFireLevel?.();
      return;
    }
    if (this.levelTween) this.levelTween.stop();
    this.levelTween = this.tweens.addCounter({
      from: this.fireLevel,
      to: target,
      duration: 400,
      ease: 'Sine.easeOut',
      onUpdate: (tw) => { this.fireLevel = tw.getValue(); this.applyFireLevel(); },
    });
  }

  reset() {
    this.timeLeft = BASELINE_SECONDS;
    this.ended = false;
    if (this.levelTween) this.levelTween.stop();
    this.fireLevel = 1;
    this.applyFireLevel();
    this.flame.setAlpha(1).setAngle(0).setTint(0xffffff);
    this.ashOverlay.setAlpha(0);
    this.flameEmitter.start();
    this.emberEmitter.start();
    this.smokeEmitter.stop();
    if (this.darkOverlay) this.darkOverlay.setAlpha(0);
  }

  // Toss a log — arcs in from a random screen edge, lands in the fire,
  // triggers an ember burst and a brief flame-size pulse.
  //
  // All three event methods below guard on this.ended: SurvivalMode.onWrong()
  // can end the session synchronously (timeLeft hitting 0 from a wrong
  // answer ends immediately rather than waiting for the next tick — see
  // game-modes.js), so game-controller.js's endSession() -> survivalEnd()
  // can run before this scene's own playWrong() call for the same event.
  // Without the guard, the "gust" animation would play after the fire had
  // already died, making it flare back up right after going dark.
  playCorrect() {
    if (this.ended) return;
    const fromLeft = Math.random() < 0.5;
    const startX = fromLeft ? -20 : LOGICAL_WIDTH + 20;
    const log = this.add.image(startX, this.fireY - 50, 'logSingle').setAngle(fromLeft ? -40 : 40);
    this.tweens.add({
      targets: log,
      x: this.fireX + Phaser.Math.Between(-6, 6),
      duration: 260,
      ease: 'Sine.easeIn',
    });
    this.tweens.add({
      targets: log,
      y: this.fireY - 4,
      angle: fromLeft ? 180 : -180,
      duration: 420,
      ease: 'Quad.easeIn',
      onComplete: () => {
        log.destroy();
        this.emberEmitter.explode(10, this.fireX, this.fireY - 8);
        const baseScale = this.flame.scale;
        this.tweens.add({ targets: this.flame, scale: baseScale * 1.3, duration: 90, yoyo: true, ease: 'Quad.easeOut' });
      },
    });
  }

  // Wind gust — flame bends sideways and shrinks briefly, a puff of smoke
  // blows across, camera shakes. The natural timeLeft-driven shrink (from
  // the -10s penalty reaching the tick loop) lands a moment later via setTime().
  playWrong() {
    if (this.ended) return;
    this.cameras.main.shake(160, 0.01);
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.tweens.add({
      targets: this.flame,
      angle: 22 * dir,
      duration: 90,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => { this.flame.setAngle(0); },
    });
    const baseScaleX = this.flame.scaleX, baseScaleY = this.flame.scaleY;
    this.tweens.add({
      targets: this.flame,
      scaleX: baseScaleX * 0.7,
      scaleY: baseScaleY * 0.7,
      duration: 140,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
    this.smokeEmitter.explode(6, this.fireX - dir * 10, this.fireY - 20);
  }

  playSkip() {
    if (this.ended) return;
    this.tweens.add({ targets: this.flame, alpha: 0.45, duration: 100, yoyo: true });
  }

  // Survival mode always ends via timeout (no separate win path) — the fire
  // burns down to embers and goes dark.
  playEnd() {
    if (this.ended) return;
    this.ended = true;
    if (this.levelTween) this.levelTween.stop();
    this.flameEmitter.stop();
    this.emberEmitter.stop();
    this.tweens.add({
      targets: this.flame,
      scale: 0.15,
      alpha: 0.2,
      duration: 900,
      ease: 'Sine.easeIn',
      onComplete: () => { this.flame.setTint(0x7f1d1d); },
    });
    this.smokeEmitter.explode(14, this.fireX, this.fireY - 10);
    this.tweens.add({ targets: this.ashOverlay, alpha: 0.7, duration: 900, ease: 'Sine.easeIn' });
    if (!this.darkOverlay) {
      this.darkOverlay = this.add.rectangle(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2, LOGICAL_WIDTH, LOGICAL_HEIGHT, 0x000000, 0).setDepth(50);
    }
    this.tweens.add({ targets: this.darkOverlay, alpha: 0.28, duration: 1100, ease: 'Sine.easeIn' });
  }
}

let _game = null;
let _scene = null;
let _pendingTime = null;

/** Mount the Phaser game into the given container element (idempotent — only creates once, safe to call every survival start). */
export function mountSurvivalScene(containerId) {
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
    scene: CampfireScene,
  });

  _game.events.once('ready', () => {
    _scene = _game.scene.getScene('CampfireScene');
  });
}

export function isSurvivalSceneAvailable() {
  return typeof Phaser !== 'undefined';
}

export function setSurvivalTime(timeLeft) {
  if (_scene) _scene.setTime(timeLeft);
  else _pendingTime = timeLeft;
}

// game.scale.refresh() forces Phaser to re-measure its parent container and
// rescale the canvas — needed because mountSurvivalScene() may have run
// while the container was still hidden/pre-immersive-layout (Phaser's FIT
// scale mode doesn't automatically pick up a later CSS-driven resize on its
// own). Calling this on every reset (i.e. every time Survival mode starts,
// not just the first mount) keeps the canvas correctly sized even though
// the game itself is only ever constructed once per app session.
export function resetSurvivalScene() {
  _game?.scale?.refresh();
  _scene?.reset?.();
}
export function survivalCorrect()   { _scene?.playCorrect?.(); }
export function survivalWrong()     { _scene?.playWrong?.(); }
export function survivalSkip()      { _scene?.playSkip?.(); }
export function survivalEnd()       { _scene?.playEnd?.(); }

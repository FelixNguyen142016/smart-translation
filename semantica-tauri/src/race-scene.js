// renderer/race-scene.js
// Phaser-powered visual for Game > Race mode: a runner sprinting toward a
// finish line. Purely cosmetic — RaceMode (game-modes.js) still owns all
// scoring; this module only ever receives a 0-100 progress number plus
// discrete correct/wrong/skip/win/lose events to react to. No image assets:
// the track, runner, and flag are all drawn procedurally with Phaser's
// Graphics/Shape API, so there's no asset pipeline to manage and nothing
// that can fail to load beyond the Phaser library itself.
//
// game-controller.js checks `typeof Phaser !== 'undefined'` before calling
// into this module at all, so a failed/offline CDN load just leaves the
// Game tab on its original plain progress bar (see #race-bar in index.html).

const LOGICAL_WIDTH = 800;
const LOGICAL_HEIGHT = 130;
const TRACK_Y = LOGICAL_HEIGHT * 0.68;
const MARGIN = 36;

let _game = null;
let _scene = null;
let _pendingProgress = null;

class RaceScene extends Phaser.Scene {
  constructor() {
    super('RaceScene');
    this.progress = 50;
    this.displayProgress = 50; // eased toward `progress` each frame so motion isn't jerky between 200ms ticks
  }

  create() {
    const brand = readBrandColor();

    // Ground strip
    const ground = this.add.graphics();
    ground.fillStyle(0xffffff, 0.06);
    ground.fillRect(0, TRACK_Y, LOGICAL_WIDTH, LOGICAL_HEIGHT - TRACK_Y);
    ground.lineStyle(2, 0xffffff, 0.14);
    ground.lineBetween(0, TRACK_Y, LOGICAL_WIDTH, TRACK_Y);

    // Start post
    this.add.rectangle(MARGIN - 10, TRACK_Y, 3, 30, 0xffffff, 0.3).setOrigin(0.5, 1);

    // Finish flag
    const flagX = LOGICAL_WIDTH - MARGIN + 10;
    this.add.rectangle(flagX, TRACK_Y, 3, 46, 0xffffff, 0.55).setOrigin(0.5, 1);
    this.flagPennant = this.add.triangle(flagX + 1, TRACK_Y - 44, 0, 0, 15, 5, 0, 10, brand).setOrigin(0, 0.5);
    this.tweens.add({ targets: this.flagPennant, scaleX: 0.82, duration: 480, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // Runner, built from primitives (ellipse body + circle head + two leg bars)
    this.runner = this.add.container(this.xForProgress(this.progress), TRACK_Y);
    this.legL = this.add.rectangle(-3, -2, 4, 15, brand).setOrigin(0.5, 0);
    this.legR = this.add.rectangle(3, -2, 4, 15, brand).setOrigin(0.5, 0);
    this.runnerBody = this.add.ellipse(0, -18, 16, 22, brand);
    this.runnerHead = this.add.circle(0, -32, 7, 0xffffff);
    this.runner.add([this.legL, this.legR, this.runnerBody, this.runnerHead]);

    this.legTweens = [
      this.tweens.add({ targets: this.legL, angle: 30, duration: 200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }),
      this.tweens.add({ targets: this.legR, angle: -30, duration: 200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' }),
    ];
    this.bobTween = this.tweens.add({ targets: [this.runnerBody, this.runnerHead], y: '+=3', duration: 200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    if (_pendingProgress !== null) {
      this.progress = _pendingProgress;
      this.displayProgress = _pendingProgress;
      _pendingProgress = null;
    }
    this.runner.x = this.xForProgress(this.displayProgress);
  }

  xForProgress(p) {
    const clamped = Phaser.Math.Clamp(p, 0, 100);
    return MARGIN + (LOGICAL_WIDTH - MARGIN * 2) * (clamped / 100);
  }

  update(time, delta) {
    this.displayProgress = Phaser.Math.Linear(this.displayProgress, this.progress, Math.min(1, delta / 220));
    if (this.runner) this.runner.x = this.xForProgress(this.displayProgress);
  }

  setProgress(p) { this.progress = p; }

  reset() {
    this.progress = 50;
    this.displayProgress = 50;
    if (this.runner) {
      this.runner.x = this.xForProgress(50);
      this.runner.angle = 0;
      this.runner.alpha = 1;
    }
    [this.runnerBody, this.runnerHead].forEach(o => o?.setFillStyle && o.setFillStyle(o === this.runnerHead ? 0xffffff : readBrandColor()));
    this.legTweens?.forEach(t => t.play());
    this.bobTween?.play();
  }

  burst(color, count) {
    if (!this.runner) return;
    const x = this.runner.x, y = TRACK_Y - 14;
    for (let i = 0; i < count; i++) {
      const dot = this.add.circle(x, y, Phaser.Math.Between(2, 4), color);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const dist = Phaser.Math.Between(14, 34);
      this.tweens.add({
        targets: dot,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist - 6,
        alpha: 0,
        duration: 420,
        ease: 'Cubic.easeOut',
        onComplete: () => dot.destroy(),
      });
    }
  }

  playCorrect() {
    this.burst(0x22c55e, 10);
    this.tweens.add({ targets: this.runner, scaleX: 1.15, scaleY: 0.88, duration: 90, yoyo: true, ease: 'Quad.easeOut' });
  }

  playWrong() {
    this.burst(0xef4444, 6);
    this.cameras.main.shake(160, 0.006);
    this.tweens.add({
      targets: this.runner, angle: -10, duration: 80, yoyo: true, ease: 'Quad.easeOut',
      onComplete: () => { this.runner.angle = 0; },
    });
    const brand = readBrandColor();
    [this.runnerBody, this.runnerHead].forEach(o => {
      const restore = o === this.runnerHead ? 0xffffff : brand;
      o.setFillStyle(0xef4444);
      this.time.delayedCall(160, () => o.setFillStyle(restore));
    });
  }

  playSkip() {
    this.tweens.add({ targets: this.runner, alpha: 0.4, duration: 110, yoyo: true });
  }

  playWin() {
    this.legTweens?.forEach(t => t.pause());
    this.bobTween?.pause();
    this.burst(0xfbbf24, 24);
    this.tweens.add({ targets: this.flagPennant, angle: 360, duration: 500, ease: 'Cubic.easeOut' });
  }

  playLose() {
    this.legTweens?.forEach(t => t.pause());
    this.bobTween?.pause();
    this.tweens.add({ targets: this.runner, angle: 80, alpha: 0.5, duration: 300, ease: 'Quad.easeIn' });
    this.cameras.main.shake(220, 0.01);
  }
}

// ── CSS accent color → Phaser hex, so the runner/flag match the active
// hue-slider color (and, once presets touch --brand too, whatever preset
// is active) instead of a hardcoded brand color baked into this file.
function readBrandColor() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    return cssColorToHex(raw) ?? 0x06b6d4;
  } catch {
    return 0x06b6d4;
  }
}

function cssColorToHex(raw) {
  if (!raw) return null;
  const hsl = raw.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (hsl) {
    return Phaser.Display.Color.HSLToColor(
      (+hsl[1] % 360) / 360, +hsl[2] / 100, +hsl[3] / 100,
    ).color;
  }
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) return parseInt(hex[1], 16);
  return null;
}

/** Mount the Phaser game into the given container element (idempotent — only creates once, safe to call every race start). */
export function mountRaceScene(containerId) {
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
    scene: RaceScene,
  });

  _game.events.once('ready', () => {
    _scene = _game.scene.getScene('RaceScene');
  });
}

export function isRaceSceneAvailable() {
  return typeof Phaser !== 'undefined';
}

export function setRaceProgress(p) {
  if (_scene) _scene.setProgress(p);
  else _pendingProgress = p;
}

export function resetRaceScene() { _scene?.reset?.(); }
export function raceCorrect()    { _scene?.playCorrect?.(); }
export function raceWrong()      { _scene?.playWrong?.(); }
export function raceSkip()       { _scene?.playSkip?.(); }
export function raceWin()        { _scene?.playWin?.(); }
export function raceLose()       { _scene?.playLose?.(); }

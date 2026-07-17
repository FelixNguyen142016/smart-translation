// renderer/scene-color-utils.js
// Shared CSS accent color → Phaser hex conversion, used by the Phaser scenes
// that tint an element to match the active hue-slider color (and, once
// presets touch --brand too, whatever preset is active) instead of a
// hardcoded color baked into the scene file. Extracted out of race-scene.js
// and mission-scene.js, where this was previously duplicated byte-for-byte.

export function readBrandColor() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    return cssColorToHex(raw) ?? 0x06b6d4;
  } catch {
    return 0x06b6d4;
  }
}

export function readBrandColorHex() {
  return '#' + readBrandColor().toString(16).padStart(6, '0');
}

export function cssColorToHex(raw) {
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

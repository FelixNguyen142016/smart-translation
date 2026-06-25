// utils/theme.js
// Theme presets and application logic for all extension pages

export const THEMES = {
  cyan:   { brand: '#06b6d4', brand2: '#38bdf8', rgb: '6,182,212',   deep: '#0891b2' },
  indigo: { brand: '#6366f1', brand2: '#818cf8', rgb: '99,102,241',  deep: '#4f46e5' },
  purple: { brand: '#a855f7', brand2: '#c084fc', rgb: '168,85,247',  deep: '#9333ea' },
  green:  { brand: '#22c55e', brand2: '#4ade80', rgb: '34,197,94',   deep: '#16a34a' },
};

/**
 * Apply a continuous HSL hue-based theme instead of a fixed palette preset.
 * Sets all --brand-* CSS variables and the --accent-* aliases used by popup.
 * Also toggles the `dark` class on <html>.
 * @param {number} hue     - HSL hue value 0–360
 * @param {boolean} darkMode
 */
export function applyHueTheme(hue, darkMode = false) {
  const root = document.documentElement;
  const brand      = `hsl(${hue}, 85%, 55%)`;
  const brand2     = `hsl(${hue}, 85%, 65%)`;
  const brandDeep  = `hsl(${hue}, 85%, 40%)`;
  const brandSoft  = `hsla(${hue}, 85%, 55%, 0.08)`;
  const brandBorder = `hsla(${hue}, 85%, 55%, 0.2)`;

  // Core brand vars — used throughout dashboard & popup
  root.style.setProperty('--brand',        brand);
  root.style.setProperty('--brand-2',      brand2);
  root.style.setProperty('--brand-deep',   brandDeep);
  root.style.setProperty('--brand-soft',   brandSoft);
  root.style.setProperty('--brand-border', brandBorder);

  // Accent aliases for popup CSS variable references
  root.style.setProperty('--accent-color',            brand);
  root.style.setProperty('--accent-gradient-start',   brand);
  root.style.setProperty('--accent-gradient-end',     brand2);

  root.classList.toggle('dark', !!darkMode);
}

/**
 * Apply theme CSS variables + dark mode class to document root.
 * If settings.accentHue is defined, delegates to applyHueTheme for
 * continuous hue control; otherwise falls back to palette presets.
 * Safe to call on both popup and dashboard pages.
 * @param {{ theme?: string, accentHue?: number, darkMode?: boolean }} settings
 */
export function applyTheme(settings) {
  // Prefer continuous hue system when accentHue is stored
  if (settings.accentHue !== undefined) {
    applyHueTheme(settings.accentHue, settings.darkMode);
    return;
  }

  // Legacy palette-based fallback — keeps backward compatibility
  const t = THEMES[settings.theme] || THEMES.cyan;
  const root = document.documentElement;
  root.style.setProperty('--brand',        t.brand);
  root.style.setProperty('--brand-2',      t.brand2);
  root.style.setProperty('--brand-deep',   t.deep);
  root.style.setProperty('--brand-soft',   `rgba(${t.rgb},0.07)`);
  root.style.setProperty('--brand-border', `rgba(${t.rgb},0.18)`);
  root.style.setProperty('--brand-rgb',    t.rgb);

  // Accent aliases — also set for palette mode so popup vars work
  root.style.setProperty('--accent-color',          t.brand);
  root.style.setProperty('--accent-gradient-start', t.brand);
  root.style.setProperty('--accent-gradient-end',   t.brand2);

  root.classList.toggle('dark', !!settings.darkMode);
}

/**
 * Return raw theme color strings for use in dynamically-built CSS (e.g. shadow DOM).
 * @param {{ theme?: string }} settings
 * @returns {{ brand: string, brand2: string, deep: string, rgb: string }}
 */
export function getThemeColors(settings) {
  return THEMES[settings.theme] || THEMES.cyan;
}

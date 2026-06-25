// renderer/theme.js
// Theme presets and application logic
// Copied from utils/theme.js — no changes needed

export const THEMES = {
  cyan:   { brand: '#06b6d4', brand2: '#38bdf8', rgb: '6,182,212',   deep: '#0891b2' },
  indigo: { brand: '#6366f1', brand2: '#818cf8', rgb: '99,102,241',  deep: '#4f46e5' },
  purple: { brand: '#a855f7', brand2: '#c084fc', rgb: '168,85,247',  deep: '#9333ea' },
  green:  { brand: '#22c55e', brand2: '#4ade80', rgb: '34,197,94',   deep: '#16a34a' },
};

/**
 * Apply a continuous HSL hue-based theme.
 * @param {number} hue     - HSL hue value 0–360
 * @param {boolean} darkMode
 */
export function applyHueTheme(hue, darkMode = false) {
  const root = document.documentElement;
  const brand       = `hsl(${hue}, 85%, 55%)`;
  const brand2      = `hsl(${hue}, 85%, 65%)`;
  const brandDeep   = `hsl(${hue}, 85%, 40%)`;
  const brandSoft   = `hsla(${hue}, 85%, 55%, 0.08)`;
  const brandBorder = `hsla(${hue}, 85%, 55%, 0.2)`;

  root.style.setProperty('--brand',        brand);
  root.style.setProperty('--brand-2',      brand2);
  root.style.setProperty('--brand-deep',   brandDeep);
  root.style.setProperty('--brand-soft',   brandSoft);
  root.style.setProperty('--brand-border', brandBorder);

  root.style.setProperty('--accent-color',            brand);
  root.style.setProperty('--accent-gradient-start',   brand);
  root.style.setProperty('--accent-gradient-end',     brand2);

  // Solid surface for modals — opaque even in dark mode
  root.style.setProperty('--card-bg', darkMode ? '#1e293b' : '#ffffff');
  root.classList.toggle('dark', !!darkMode);
}

/**
 * Apply theme CSS variables + dark mode class to document root.
 * @param {{ theme?: string, accentHue?: number, darkMode?: boolean }} settings
 */
export function applyTheme(settings) {
  if (settings.accentHue !== undefined) {
    applyHueTheme(settings.accentHue, settings.darkMode);
    return;
  }

  const t = THEMES[settings.theme] || THEMES.cyan;
  const root = document.documentElement;
  root.style.setProperty('--brand',        t.brand);
  root.style.setProperty('--brand-2',      t.brand2);
  root.style.setProperty('--brand-deep',   t.deep);
  root.style.setProperty('--brand-soft',   `rgba(${t.rgb},0.07)`);
  root.style.setProperty('--brand-border', `rgba(${t.rgb},0.18)`);
  root.style.setProperty('--brand-rgb',    t.rgb);

  root.style.setProperty('--accent-color',          t.brand);
  root.style.setProperty('--accent-gradient-start', t.brand);
  root.style.setProperty('--accent-gradient-end',   t.brand2);

  root.classList.toggle('dark', !!settings.darkMode);
}

/**
 * Return raw theme color strings.
 */
export function getThemeColors(settings) {
  return THEMES[settings.theme] || THEMES.cyan;
}

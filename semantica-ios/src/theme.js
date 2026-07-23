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

  // --card-bg is intentionally NOT set here — it's a static :root/html.dark
  // token in index.html's CSS, so a visual theme preset's inline override
  // (see applyVisualPreset below) survives hue/dark-mode changes instead of
  // being silently overwritten by every slider drag.
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

// ── Visual theme presets ─────────────────────────────────────────────────────
// Full-surface "moodboard" presets (page background, card background, text /
// border colors) — a separate, independent layer from the accent-hue system
// above. Selecting a preset does NOT touch --brand/--brand-2/--brand-soft/
// --brand-border (still fully controlled by the hue slider) or force the Dark
// Mode toggle — each preset carries its own complete, self-contained
// light/dark-appropriate text and surface palette so it stays legible no
// matter what the hue slider or Dark Mode toggle are set to. `previewAccent`/
// `previewSecondary` are used only to render the picker swatch — they are a
// visual reference for the theme's "intended" accent, not something applied
// live to the app (that stays the hue slider's job, by design).
export const VISUAL_PRESET_GROUPS = [
  {
    label: 'Nature & Zen', emoji: '🌿',
    presets: [
      {
        id: 'nordic', name: 'Nordic Aurora', dark: true,
        pageBg: 'linear-gradient(135deg, #0B132B 0%, #1a1060 50%, #0d2b1a 100%)',
        cardBg: 'rgba(255,255,255,0.07)',
        textMain: '#EAF2FF', textMuted: '#9FB3D9', textSoft: '#6B84B3',
        border: 'rgba(255,255,255,0.12)', mutedBg: 'rgba(255,255,255,0.05)',
        previewAccent: '#39FF9A', previewSecondary: '#9B72CF',
        tagline: 'Aurora glass over a deep night sky',
        tags: ['Glassmorphism', 'Neon Green', 'Soft Purple'],
      },
      {
        id: 'alpine', name: 'Alpine Wildlife', dark: true,
        pageBg: 'linear-gradient(135deg, #2F3E46 0%, #3d5240 55%, #4a3728 100%)',
        cardBg: 'rgba(255,255,255,0.08)',
        textMain: '#EDF1EE', textMuted: '#B8C4BC', textSoft: '#8A988F',
        border: 'rgba(255,255,255,0.10)', mutedBg: 'rgba(255,255,255,0.05)',
        previewAccent: '#F4A261', previewSecondary: '#52796F',
        tagline: 'Pine ridges, misty mornings, earthy calm',
        tags: ['Earthy', 'Pine Green', 'Morning Orange'],
      },
      {
        id: 'bio', name: 'Bioluminescent Bay', dark: true,
        pageBg: 'linear-gradient(135deg, #011627 0%, #002b3d 50%, #001a33 100%)',
        cardBg: 'rgba(0,180,220,0.08)',
        textMain: '#E4F7FF', textMuted: '#8FCADB', textSoft: '#5D93A6',
        border: 'rgba(0,229,255,0.15)', mutedBg: 'rgba(0,180,220,0.06)',
        previewAccent: '#00E5FF', previewSecondary: '#0057FF',
        tagline: 'Deep water glow and rising light dust',
        tags: ['Glowing Cyan', 'Midnight Ocean', 'Bio Blue'],
      },
    ],
  },
  {
    label: 'Cozy & Academic', emoji: '☕',
    presets: [
      {
        // Corrected: the brief calls for "rich navy TEXT" and "olive green
        // ACCENTS" — navy now drives textMain (was mislabeled as a UI
        // "secondary" swatch), olive stays the preview accent.
        id: 'autumn', name: 'Autumn Campus', dark: false,
        pageBg: 'linear-gradient(135deg, #F4F1DE 0%, #e8e4c8 50%, #f0ead2 100%)',
        cardBg: '#FFFFFF',
        textMain: '#1B2A4A', textMuted: '#5B6B8C', textSoft: '#8B98B3',
        border: 'rgba(27,42,74,0.10)', mutedBg: '#EFEBD6',
        previewAccent: '#6B7F4A', previewSecondary: '#1B2A4A',
        tagline: 'Comfortable cardigan energy — warm and productive',
        tags: ['Warm Beige', 'Olive Green', 'Rich Navy'],
      },
      {
        id: 'ivory', name: 'Ivory Keys', dark: false,
        pageBg: 'linear-gradient(135deg, #F8F9FA 0%, #eceef0 50%, #f5f6f7 100%)',
        cardBg: '#FFFFFF',
        textMain: '#1A1A1A', textMuted: '#6B6B6B', textSoft: '#9A9A9A',
        border: 'rgba(0,0,0,0.08)', mutedBg: '#F1F2F3',
        previewAccent: '#1A1A1A', previewSecondary: '#888888',
        tagline: 'Piano keys and sheet music — clean, rhythmic, premium',
        tags: ['Ivory White', 'Onyx Black', 'Minimalist'],
      },
      {
        // Corrected: the brief calls for "warm lamp-light yellow ACCENTS" —
        // yellow now drives the preview accent (was mislabeled as
        // "secondary" with mahogany brown incorrectly taking the accent slot).
        id: 'library', name: 'Library Desk', dark: false,
        pageBg: 'linear-gradient(135deg, #FDF8E1 0%, #f5edd0 50%, #fdf3c8 100%)',
        cardBg: '#FFFEF5',
        textMain: '#4A2E1E', textMuted: '#7A5C48', textSoft: '#A6907E',
        border: 'rgba(74,46,30,0.12)', mutedBg: '#F7EFD6',
        previewAccent: '#F5C842', previewSecondary: '#C87941',
        tagline: 'Antique desk, warm lamp, parchment textures',
        tags: ['Parchment', 'Mahogany', 'Lamp Yellow'],
      },
    ],
  },
  {
    label: 'Gamified & Pixel', emoji: '🕹️',
    presets: [
      {
        id: 'voxel', name: 'Voxel Valley', dark: false,
        pageBg: 'linear-gradient(135deg, #8ECAE6 0%, #74b8d8 50%, #a5d4eb 100%)',
        cardBg: 'rgba(255,255,255,0.65)',
        textMain: '#1F3D2B', textMuted: '#3F5F4D', textSoft: '#6B8A78',
        border: 'rgba(31,61,43,0.14)', mutedBg: 'rgba(255,255,255,0.35)',
        previewAccent: '#4A7C59', previewSecondary: '#8B5E3C',
        tagline: 'Blocky 8-bit world with high-end lighting shaders',
        tags: ['Sky Blue', 'Earthy Green', 'Soil Brown'],
      },
      {
        id: 'mythic', name: 'Mythic Empire', dark: true,
        pageBg: 'linear-gradient(135deg, #2B2D42 0%, #1a1b2e 50%, #2d2040 100%)',
        cardBg: 'rgba(15,10,30,0.7)',
        textMain: '#F3EFFF', textMuted: '#B6A9D9', textSoft: '#8577A8',
        border: 'rgba(255,215,0,0.15)', mutedBg: 'rgba(255,255,255,0.05)',
        previewAccent: '#FFD700', previewSecondary: '#8B5CF6',
        tagline: 'Epic fantasy RPG — hero levels and obsidian cards',
        tags: ['Dark Stone', 'Shimmering Gold', 'Amethyst'],
      },
      {
        id: 'arcade', name: 'Arcade Neon', dark: true,
        pageBg: 'linear-gradient(135deg, #000000 0%, #0a0a0a 50%, #000000 100%)',
        cardBg: 'rgba(255,255,255,0.05)',
        textMain: '#F5FFF0', textMuted: '#9DFFB0', textSoft: '#5FA36B',
        border: 'rgba(57,255,20,0.18)', mutedBg: 'rgba(255,255,255,0.04)',
        previewAccent: '#39FF14', previewSecondary: '#FF2D78',
        tagline: 'Retro arcade cabinet — CRT scanlines, pure adrenaline',
        tags: ['Pitch Black', 'Electric Lime', 'Neon Pink'],
      },
    ],
  },
  {
    label: 'Deep Work', emoji: '💻',
    presets: [
      {
        // Corrected: the brief calls for a "PURE black background" — the
        // page gradient now actually anchors on true #000000 (was #0D1117,
        // GitHub's near-black, which also contradicted this preset's own
        // "Pure Black" tag).
        id: 'terminal', name: 'Terminal Syntax', dark: true,
        pageBg: 'linear-gradient(135deg, #000000 0%, #0a0e14 50%, #000000 100%)',
        cardBg: 'rgba(255,255,255,0.04)',
        textMain: '#E6EDF3', textMuted: '#8B98A5', textSoft: '#5D6773',
        border: 'rgba(255,255,255,0.08)', mutedBg: 'rgba(255,255,255,0.03)',
        previewAccent: '#58A6FF', previewSecondary: '#FF6AC1',
        tagline: 'Dark-mode code editor — data-dense, technically clean',
        tags: ['True Black', 'Function Blue', 'Electric Pink'],
      },
      {
        // Corrected: the brief calls for "MAGENTA" gradients — shifted from
        // a light lavender (#C084FC) to a true magenta.
        id: 'lofi', name: 'Lofi Midnight', dark: true,
        pageBg: 'linear-gradient(135deg, #1A1A24 0%, #221430 55%, #1e1820 100%)',
        cardBg: 'rgba(120,80,160,0.12)',
        textMain: '#F1E9FF', textMuted: '#B79FCF', textSoft: '#8670A0',
        border: 'rgba(224,64,251,0.15)', mutedBg: 'rgba(120,80,160,0.08)',
        previewAccent: '#E040FB', previewSecondary: '#F4A261',
        tagline: '2 AM study session — plum cards and streetlamp gradients',
        tags: ['Purple-Black', 'Muted Plum', 'Magenta Glow'],
      },
    ],
  },
  {
    label: 'Soft & Aesthetic', emoji: '🎀',
    presets: [
      {
        id: 'strawberry', name: 'Strawberry Milk', dark: false,
        pageBg: 'linear-gradient(135deg, #FFF9F7 0%, #FDEEF0 50%, #FCE4EC 100%)',
        cardBg: '#FDEDF1',
        textMain: '#5C2E3D', textMuted: '#8C5D6B', textSoft: '#B98999',
        border: 'rgba(92,46,61,0.10)', mutedBg: '#FBE0E6',
        previewAccent: '#F7A8B8', previewSecondary: '#E8A0B4',
        tagline: 'Creamy blossoms and plush rose accents',
        tags: ['Blossom Pink', 'Creamy White', 'Soft Rose'],
      },
      {
        id: 'matcha', name: 'Vanilla Matcha', dark: false,
        pageBg: 'linear-gradient(135deg, #FAF6EF 0%, #F3EEE1 50%, #F7F2E7 100%)',
        cardBg: '#EFF2E7',
        textMain: '#4A4438', textMuted: '#8A8371', textSoft: '#B5AE9C',
        border: 'rgba(74,68,56,0.08)', mutedBg: '#EAEDDD',
        previewAccent: '#8FA07A', previewSecondary: '#B8AD94',
        tagline: 'Oat milk calm with sage & taupe whitespace',
        tags: ['Oat Beige', 'Sage Green', 'Muted Taupe'],
      },
      {
        id: 'lavender', name: 'Lavender Cloud', dark: false,
        pageBg: 'linear-gradient(135deg, #C3B8F5 0%, #E5B8E0 45%, #F5C9D9 100%)',
        cardBg: 'rgba(255,255,255,0.55)',
        textMain: '#3D2C6B', textMuted: '#6B5A96', textSoft: '#9A8DBD',
        border: 'rgba(255,255,255,0.5)', mutedBg: 'rgba(255,255,255,0.35)',
        previewAccent: '#B39DDB', previewSecondary: '#F3B6D3',
        tagline: 'Frosted glass over dreamy sunset clouds',
        tags: ['Lilac Glass', 'Periwinkle', 'Cloud Pink'],
      },
      {
        id: 'sunsetpeach', name: 'Sunset Peach', dark: false,
        pageBg: 'linear-gradient(135deg, #FFE8D6 0%, #FFD3B0 50%, #FFC299 100%)',
        cardBg: '#FFEDE3',
        textMain: '#6B3A2A', textMuted: '#9C6B54', textSoft: '#C79980',
        border: 'rgba(107,58,42,0.10)', mutedBg: '#FFDFC9',
        previewAccent: '#FF9852', previewSecondary: '#FFB88C',
        tagline: 'Golden-hour warmth and cozy apricot glow',
        tags: ['Apricot', 'Blush', 'Golden Orange'],
      },
      {
        id: 'y2k', name: 'Y2K Holographic', dark: false,
        pageBg: 'linear-gradient(135deg, #D6F0FF 0%, #C9E4FF 50%, #E0D6FF 100%)',
        cardBg: '#FFFFFF',
        textMain: '#1A1A2E', textMuted: '#5C5C7A', textSoft: '#9494B8',
        border: 'rgba(147,112,219,0.15)', mutedBg: '#EAF6FF',
        previewAccent: '#FF6EC7', previewSecondary: '#7EC8FF',
        tagline: 'Glossy holographic shine, Y2K bubblegum energy',
        tags: ['Icy Blue', 'Bubblegum Pink', 'Glossy White'],
      },
    ],
  },
];

/** Flat lookup: preset id → preset object (or undefined). */
export function getVisualPreset(id) {
  for (const group of VISUAL_PRESET_GROUPS) {
    const found = group.presets.find(p => p.id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Apply (or clear) a visual theme preset. Sets page background, card
 * background, and text/border surface colors directly on the root element —
 * these take priority over the plain :root/html.dark CSS rules (inline style
 * beats a class selector) without needing !important or a page reload.
 * Deliberately does not touch --brand/--brand-2/--brand-soft/--brand-border
 * (hue slider) or the .dark class (Dark Mode toggle) — both stay independent.
 * @param {object|null} preset - a VISUAL_PRESET_GROUPS[].presets[] entry, or
 *   null/undefined to clear back to the plain hue-driven look.
 */
export function applyVisualPreset(preset) {
  const root = document.documentElement;
  // --card-bg: the modal's always-opaque surface (also a static :root/
  // html.dark token, so it has a theme-aware default even without a preset).
  // --card-bg-translucent: .card's own softly-translucent surface, which has
  // no static token — it falls back to its literal default in index.html's
  // CSS unless a preset overrides it. Both point at the same preset color so
  // modals and cards look cohesive once a preset is active.
  const props = ['--page-bg', '--card-bg', '--card-bg-translucent', '--text-main', '--text-muted', '--text-soft', '--border', '--muted-bg'];

  if (!preset) {
    props.forEach(p => root.style.removeProperty(p));
    return;
  }

  root.style.setProperty('--page-bg', preset.pageBg);
  root.style.setProperty('--card-bg', preset.cardBg);
  root.style.setProperty('--card-bg-translucent', preset.cardBg);
  root.style.setProperty('--text-main', preset.textMain);
  root.style.setProperty('--text-muted', preset.textMuted);
  root.style.setProperty('--text-soft', preset.textSoft);
  root.style.setProperty('--border', preset.border);
  root.style.setProperty('--muted-bg', preset.mutedBg);
}

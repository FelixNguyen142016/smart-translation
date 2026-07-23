// renderer/app.js
// Main renderer logic for VocabAI Desktop
// Adapted from dashboard/dashboard.js — chrome.* APIs replaced with localStorage + fetch

import { getWords, deleteWord, updateWord, saveWord, getSettings, saveSettings } from './storage-shim.js';
import { initGame, pauseGameSession, resumeGameSession } from './game-controller.js';
import { FSRS_FILTERS, getFsrsFilter, renderFsrsFilterPills, hasFsrsCard } from './fsrs-filters.js';
import { applyAccentHex, hexToHslParts, VISUAL_PRESET_GROUPS, getVisualPreset, applyVisualPreset } from './theme.js';
import { nextLearningState } from './game-engine.js';
import { fsrs, Rating, State as FsrsState, createEmptyCard } from './fsrs-vendor.js';
import { escapeHtml } from './dom-utils.js';
import { speakText, createSpeakerButton } from './audio-utils.js';
import {
  loadVocab,
  apiAnalyzeText,
  apiImportWords,
  apiRequestCode,
  apiVerifyCode,
  apiCreateCheckout,
  apiGetOrder,
  apiGetBillingStatus,
  setAuthSession,
  clearAuthSession,
  isLoggedIn,
  getToken,
  getEmail,
} from './api.js';

// ─── IELTS Wordlist ──────────────────────────────────────────────────────────
let _ieltsWordlist = null;

async function loadIeltsWordlist() {
  try {
    const res = await fetch('./ielts-wordlist.json');
    _ieltsWordlist = await res.json();
  } catch (_) {
    _ieltsWordlist = {};
  }
}

/** Look up a word in the IELTS wordlist. Returns { band, sublist, headword, collocations } or null. */
function lookupIelts(wordText) {
  if (!_ieltsWordlist) return null;
  return _ieltsWordlist[wordText.toLowerCase()] || null;
}

// ─── macOS titlebar spacer ────────────────────────────────────────────────────
if (window.electronAPI?.platform === 'darwin') {
  const spacer = document.getElementById('titlebar-spacer');
  if (spacer) spacer.style.display = 'block';
}

// ─── App visibility helpers ───────────────────────────────────────────────────
// Tracks the pending animationend handler so we can cancel it if needed
let _lpExitHandler = null;

function showMainApp() {
  const lp  = document.getElementById('login-page');
  const app = document.getElementById('main-app');

  // Cancel any stale animationend listener from a previous showMainApp call
  if (_lpExitHandler) {
    lp.removeEventListener('animationend', _lpExitHandler);
    _lpExitHandler = null;
  }

  // Slide in the dashboard
  app.style.display = 'flex';
  app.classList.remove('app-enter');
  void app.offsetWidth;
  app.classList.add('app-enter');

  // Fade + scale out the login page on top
  lp.classList.remove('lp-enter');
  lp.classList.add('lp-exit');
  _lpExitHandler = () => {
    lp.style.display = 'none';
    lp.classList.remove('lp-exit');
    _lpExitHandler = null;
  };
  lp.addEventListener('animationend', _lpExitHandler, { once: true });
}

function showLoginPage() {
  const lp  = document.getElementById('login-page');
  const app = document.getElementById('main-app');

  // Cancel any stale lp-exit animationend listener before touching the element
  if (_lpExitHandler) {
    lp.removeEventListener('animationend', _lpExitHandler);
    _lpExitHandler = null;
  }

  // Strip all animation classes and inline opacity so login page shows cleanly
  lp.classList.remove('lp-exit', 'lp-enter');
  lp.style.display = 'flex';
  app.style.display = 'none';
}

// speakText() / createSpeakerButton() moved to audio-utils.js (imported
// above) so game-controller.js can reuse the same TTS-with-fallback logic
// for Quick Ear mode without a circular import (app.js imports initGame
// from game-controller.js). Behavior is unchanged.

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Initialise Lucide SVG icons ─────────────────────────────────────────────
  if (window.lucide) window.lucide.createIcons();

  // ─── Startup: show login page or main app ─────────────────────────────────────
  if (isLoggedIn()) {
    showMainApp();
  } else {
    showLoginPage();
  }
  // Tauri starts the window hidden (background app) — bring it up now that
  // the page has rendered. Must run for BOTH branches above: it was
  // previously only called from the logged-out branch, so any already
  // logged-in launch (i.e. every launch after the first) left the native
  // window permanently hidden with nothing left to reveal it — the window
  // itself is a separate concern from showMainApp()/showLoginPage(), which
  // only toggle which <div> is visible *inside* an already-visible window.
  // No-op on Electron, where the window is always shown.
  window.electronAPI?.showDashboard?.();

  // ─── "How to use" card: platform-aware shortcut labels ───────────────────────
  {
    const isTauri = !!window.__TAURI__;
    const mod = window.electronAPI?.platform === 'darwin' ? '⌘' : 'Ctrl';
    const lookupEl = document.getElementById('howto-lookup');
    if (lookupEl) {
      // Tauri build: show both Mac and Windows/Linux shortcuts together
      // (⌘+Shift+D / Ctrl+Shift+D) rather than only the detected platform's —
      // mirrors the Vietnamese translation below it, which always shows both.
      lookupEl.innerHTML = isTauri
        ? `Press <strong>⌘+Shift+D</strong> / <strong>Ctrl+Shift+D</strong> (or click the Semantica tray icon) to search, or copy a word anywhere and press <strong>⌘+Shift+E</strong> / <strong>Ctrl+Shift+E</strong> to translate it instantly`
        : `Press <strong>${mod}+Shift+F</strong> — or copy a word and press <strong>${mod}+Shift+T</strong>`;
    }
    const bgEl = document.getElementById('howto-background');
    if (bgEl && isTauri) bgEl.style.display = 'block';
  }


  // ─── Login Page handlers ─────────────────────────────────────────────────────
  let _lpEmail = '';

  document.getElementById('lp-send-btn').addEventListener('click', async () => {
    const emailInput = document.getElementById('lp-email');
    const errEl      = document.getElementById('lp-send-error');
    const btn        = document.getElementById('lp-send-btn');
    _lpEmail = emailInput.value.trim();

    if (!_lpEmail) { errEl.textContent = 'Please enter your email.'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await apiRequestCode(_lpEmail);
      document.getElementById('lp-code-hint').textContent = `Enter the code we sent to ${_lpEmail}`;
      document.getElementById('lp-step-email').style.display = 'none';
      document.getElementById('lp-step-code').style.display  = 'block';
      document.getElementById('lp-code').focus();
    } catch (err) {
      errEl.textContent = err.message || 'Could not send code. Check your connection.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Code →';
    }
  });

  document.getElementById('lp-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('lp-send-btn').click();
  });

  document.getElementById('lp-verify-btn').addEventListener('click', async () => {
    const code   = document.getElementById('lp-code').value.trim();
    const errEl  = document.getElementById('lp-verify-error');
    const btn    = document.getElementById('lp-verify-btn');

    if (!code) { errEl.textContent = 'Please enter the code.'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const data = await apiVerifyCode(_lpEmail, code);
      setAuthSession(data.token, _lpEmail);
      if (window.electronAPI?.setToken) window.electronAPI.setToken(data.token);

      const settings = getSettings();
      await saveSettings({ ...settings, provider: 'cloud' });
      aiProviderSelect.value = 'cloud';
      toggleProviderNote('cloud');

      showMainApp();
      await showLoggedInState(data.token);
    } catch (err) {
      errEl.textContent = err.message || 'Incorrect or expired code.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In →';
    }
  });

  document.getElementById('lp-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('lp-verify-btn').click();
  });

  document.getElementById('lp-back-btn').addEventListener('click', () => {
    document.getElementById('lp-step-code').style.display  = 'none';
    document.getElementById('lp-step-email').style.display = 'block';
    document.getElementById('lp-verify-error').style.display = 'none';
    document.getElementById('lp-code').value = '';
  });

  // ─── Navigation ─────────────────────────────────────────────────────────────
  const tabs = document.querySelectorAll('.nav-tab');
  const sections = document.querySelectorAll('.view-section');
  const tabIndicator = document.getElementById('tab-indicator');

  function moveIndicator(tab) {
    if (!tabIndicator) return;
    const navTabs = tab.closest('.nav-tabs');
    const navRect = navTabs.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const padding = 14; // matches .nav-tab padding-left/right
    // Add scrollLeft: the indicator lives in the container's content coordinates,
    // which shift when .nav-tabs (overflow-x: auto) is horizontally scrolled
    tabIndicator.style.left  = (tabRect.left - navRect.left + navTabs.scrollLeft + padding) + 'px';
    tabIndicator.style.width = (tabRect.width - padding * 2) + 'px';
  }

  // Position indicator on the initially active tab without animation
  const initialTab = document.querySelector('.nav-tab.active');
  if (initialTab && tabIndicator) {
    tabIndicator.style.transition = 'none';
    moveIndicator(initialTab);
    requestAnimationFrame(() => { tabIndicator.style.transition = ''; });
  }

  // These tabs own internal sub-screens that conflict with CSS animations
  const NO_DISSOLVE = new Set(['review-view', 'practice-view', 'game-view']);

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.classList.contains('active')) return; // already active, skip

      const outgoing = document.querySelector('.view-section.active');

      // Freeze any active game session before leaving the Game tab — without
      // this, Quick Ear's round timer (and Race/Survival's tick interval)
      // keeps running unattended in the background, since nothing else in
      // this handler reacts to the *outgoing* tab.
      if (outgoing && outgoing.id === 'game-view') pauseGameSession();

      const useAnimation = !NO_DISSOLVE.has(tab.dataset.target) &&
                           outgoing && !NO_DISSOLVE.has(outgoing.id);

      if (useAnimation) {
        // Fade out the outgoing section
        outgoing.classList.add('tab-exit');
        outgoing.classList.remove('active');
        outgoing.addEventListener('animationend', () => {
          outgoing.classList.remove('tab-exit');
          outgoing.style.display = '';
        }, { once: true });
      } else if (outgoing) {
        // Instant swap — no animation
        outgoing.classList.remove('active');
      }

      // Update active tab + slide indicator
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      moveIndicator(tab);

      // Fade in (or instantly show) the incoming section
      const incoming = document.getElementById(tab.dataset.target);
      incoming.classList.add('active');

      // Trigger view-specific logic
      if (tab.dataset.target === 'list-view')      loadVocab().then(() => {
        const searchInput = document.getElementById('vocab-search-input');
        applySearchFilter(searchInput ? searchInput.value.trim() : '');
      });
      if (tab.dataset.target === 'review-view')    startReviewSession();
      if (tab.dataset.target === 'game-view')      { initGame(); resumeGameSession(); }
      if (tab.dataset.target === 'sentences-view') renderSentences();
      if (tab.dataset.target === 'videos-view')    renderVideos();
      if (tab.dataset.target === 'practice-view')  showPracticeModeSelect();
      if (tab.dataset.target === 'account-settings-view') {
        const token = getToken();
        if (token) {
          updateSyncStatus('Syncing…');
          loadVocab()
            .then(() => { renderWords(); updateSyncStatus('Last synced: just now'); })
            .catch(() => updateSyncStatus('Offline — using local data'));
        }
      }
    });
  });

  // ─── Settings ────────────────────────────────────────────────────────────────
  const aiProviderSelect  = document.getElementById('ai-provider');
  const saveSettingsBtn   = document.getElementById('save-settings');
  const saveMsg           = document.getElementById('save-msg');

  const currentSettings = getSettings();

  // ── Accent Color Picker (saturation/brightness board + hue rail) ─────────
  // Vanilla port of the AccentColorPicker React component: HSV board, hue
  // rail, hex input with validation, RGB readout, and 12 preset swatches.
  // Replaces the old hue-only slider — the stored `accentColor` hex is the
  // source of truth; `accentHue` is still saved (derived) for back-compat
  // with settings written before this picker existed.
  const ACCENT_PRESETS = [
    // Row 1 — cool/brand
    '#06b6d4', '#38bdf8', '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
    // Row 2 — warm/nature
    '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#64748b',
  ];

  function hexToHsv(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = Math.round(h * 60);
    }
    const s = max ? Math.round((d / max) * 100) : 0;
    const v = Math.round(max * 100);
    return [h, s, v];
  }

  function hsvToHex(h, s, v) {
    s /= 100; v /= 100;
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
  }

  // Migration: prefer the stored hex; fall back to converting the legacy
  // accentHue (which always rendered as hsl(hue, 85%, 55%)) to its hex.
  function legacyHueToHex(hue) {
    // hsl(h, 85%, 55%) → hsv-ish conversion via a tiny canvas-free path:
    // compute HSL→RGB directly.
    const h = ((hue % 360) + 360) % 360, s = 0.85, l = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
      h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  let _accentHex = /^#[0-9a-fA-F]{6}$/.test(currentSettings.accentColor || '')
    ? currentSettings.accentColor.toLowerCase()
    : legacyHueToHex(currentSettings.accentHue ?? 190);
  let _accentHsv = hexToHsv(_accentHex);

  applyAccentHex(_accentHex, currentSettings.darkMode);

  const loggedIn = isLoggedIn();
  const defaultProvider = loggedIn ? 'cloud' : 'freedict';
  aiProviderSelect.value = currentSettings.provider || defaultProvider;

  const accentBoard      = document.getElementById('accent-board');
  const accentBoardThumb = document.getElementById('accent-board-thumb');
  const accentHueRail    = document.getElementById('accent-hue-rail');
  const accentHueThumb   = document.getElementById('accent-hue-thumb');
  const accentHexInput   = document.getElementById('accent-hex-input');
  const accentRgbReadout = document.getElementById('accent-rgb-readout');
  const accentSwatch     = document.getElementById('accent-current-swatch');
  const accentPresetGrid = document.getElementById('accent-preset-grid');

  /** Redraw every picker element from _accentHex/_accentHsv and re-apply the theme. */
  function syncAccentPicker({ skipHexInput = false } = {}) {
    const [h, s, v] = _accentHsv;
    if (accentBoard)      accentBoard.style.background = `hsl(${h}, 100%, 50%)`;
    if (accentBoardThumb) {
      accentBoardThumb.style.left = `${s}%`;
      accentBoardThumb.style.top  = `${100 - v}%`;
      accentBoardThumb.style.background = _accentHex;
    }
    if (accentHueThumb) {
      accentHueThumb.style.left = `${(h / 360) * 100}%`;
      accentHueThumb.style.background = `hsl(${h}, 100%, 50%)`;
    }
    if (accentSwatch) accentSwatch.style.background = _accentHex;
    if (accentHexInput && !skipHexInput) {
      accentHexInput.value = _accentHex;
      accentHexInput.classList.remove('hex-error');
    }
    if (accentRgbReadout) {
      accentRgbReadout.textContent =
        `${parseInt(_accentHex.slice(1, 3), 16)} ${parseInt(_accentHex.slice(3, 5), 16)} ${parseInt(_accentHex.slice(5, 7), 16)}`;
    }
    renderAccentPresetSwatches();
    applyAccentHex(_accentHex, darkToggle.checked);
  }

  function setAccentHex(hex, opts) {
    _accentHex = hex.toLowerCase();
    _accentHsv = hexToHsv(_accentHex);
    syncAccentPicker(opts);
  }

  function renderAccentPresetSwatches() {
    if (!accentPresetGrid) return;
    accentPresetGrid.innerHTML = '';
    ACCENT_PRESETS.forEach(color => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'accent-preset-swatch';
      btn.style.background = color;
      btn.title = color;
      if (_accentHex === color.toLowerCase()) {
        btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5L4 7L8 3" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      btn.addEventListener('click', () => setAccentHex(color));
      accentPresetGrid.appendChild(btn);
    });
  }

  // Board drag: x = saturation, y = brightness (inverted); hue rail drag: x = hue.
  let _accentDragging = null; // 'board' | 'hue' | null
  function pickFromBoard(e) {
    if (!accentBoard) return;
    const r = accentBoard.getBoundingClientRect();
    const s = Math.round(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * 100);
    const v = Math.round((1 - Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)) * 100);
    _accentHsv = [_accentHsv[0], s, v];
    _accentHex = hsvToHex(..._accentHsv);
    syncAccentPicker();
  }
  function pickFromHueRail(e) {
    if (!accentHueRail) return;
    const r = accentHueRail.getBoundingClientRect();
    const h = Math.round(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * 360);
    _accentHsv = [h, _accentHsv[1], _accentHsv[2]];
    _accentHex = hsvToHex(..._accentHsv);
    syncAccentPicker();
  }
  accentBoard?.addEventListener('mousedown', (e) => { _accentDragging = 'board'; pickFromBoard(e); });
  accentHueRail?.addEventListener('mousedown', (e) => { _accentDragging = 'hue'; pickFromHueRail(e); });
  document.addEventListener('mousemove', (e) => {
    if (_accentDragging === 'board') pickFromBoard(e);
    else if (_accentDragging === 'hue') pickFromHueRail(e);
  });
  document.addEventListener('mouseup', () => { _accentDragging = null; });

  // Hex input: apply on every valid 6-digit value; flag invalid ones without
  // fighting the user mid-typing.
  accentHexInput?.addEventListener('input', () => {
    const raw = accentHexInput.value.trim();
    const withHash = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
      setAccentHex(withHash, { skipHexInput: true });
      accentHexInput.classList.remove('hex-error');
    } else {
      accentHexInput.classList.toggle('hex-error', raw.length > 0);
    }
  });
  accentHexInput?.addEventListener('blur', () => syncAccentPicker()); // normalize display

  // Dark mode toggle (settings page)
  const darkToggle = document.getElementById('dark-mode-toggle');
  darkToggle.checked = !!currentSettings.darkMode;
  darkToggle.addEventListener('change', () => {
    applyAccentHex(_accentHex, darkToggle.checked);
    navDarkBtn.textContent = darkToggle.checked ? '☀️' : '🌙';
  });

  // Nav dark mode quick-toggle
  const navDarkBtn = document.getElementById('nav-dark-toggle');
  navDarkBtn.textContent = currentSettings.darkMode ? '☀️' : '🌙';
  navDarkBtn.addEventListener('click', () => {
    darkToggle.checked = !darkToggle.checked;
    applyAccentHex(_accentHex, darkToggle.checked);
    navDarkBtn.textContent = darkToggle.checked ? '☀️' : '🌙';
  });

  syncAccentPicker();

  // ── Visual Theme presets ──────────────────────────────────────────────────
  // Independent from the hue slider and Dark Mode toggle above: a preset only
  // sets page background, card background, and text/border colors (see
  // theme.js applyVisualPreset). Accent color stays fully hue-slider-driven,
  // and Dark Mode keeps controlling the plain (no-preset) look — each preset
  // carries its own self-contained legible palette regardless of either.
  let _activeVisualPresetId = currentSettings.visualPreset || null;
  if (_activeVisualPresetId) {
    applyVisualPreset(getVisualPreset(_activeVisualPresetId));
  }

  const presetGroupsEl        = document.getElementById('visual-preset-groups');
  const customControlsEl      = document.getElementById('custom-theme-controls');

  function renderVisualPresetPicker() {
    // Always visible (user decision, 20-07): the accent picker stays usable
    // while a preset is active, since presets only set surfaces/text and the
    // accent remains independent — hiding it made changing the accent under
    // a preset needlessly hard.
    customControlsEl.style.display = 'block';
    presetGroupsEl.innerHTML = '';

    // ── "Custom" — first tile, always present. Selecting it clears the
    // active preset and reveals the hue slider + Dark Mode toggle below,
    // i.e. the original manual color system, now with an explicit seat in
    // the picker instead of being an implicit "nothing selected" fallback.
    const customGrid = document.createElement('div');
    customGrid.className = 'preset-grid';
    const customBtn = document.createElement('button');
    customBtn.type = 'button';
    const isCustomActive = !_activeVisualPresetId;
    customBtn.className = 'preset-swatch' + (isCustomActive ? ' active' : '');
    customBtn.title = 'Custom';
    customBtn.innerHTML = `
      <div class="preset-swatch-preview" style="background:linear-gradient(135deg, #f8fafc 0%, #f8fafc 49%, #0f172a 51%, #0f172a 100%);display:flex;align-items:center;justify-content:center;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>
        ${isCustomActive ? `<div class="preset-swatch-check"><svg width="8" height="8" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` : ''}
      </div>
      <div class="preset-swatch-info">
        <div class="preset-swatch-name">Custom</div>
        <div class="preset-swatch-tagline">Pick your own accent &amp; light/dark mode</div>
      </div>`;
    customBtn.addEventListener('click', () => {
      _activeVisualPresetId = null;
      applyVisualPreset(null);
      renderVisualPresetPicker();
    });
    customGrid.appendChild(customBtn);
    presetGroupsEl.appendChild(customGrid);

    VISUAL_PRESET_GROUPS.forEach(group => {
      const groupEl = document.createElement('div');
      groupEl.className = 'preset-group';

      const head = document.createElement('div');
      head.className = 'preset-group-head';
      head.innerHTML = `<span class="emoji">${group.emoji}</span><span class="label">${escapeHtml(group.label)}</span><span class="preset-group-line"></span>`;
      groupEl.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'preset-grid';

      group.presets.forEach(preset => {
        const isActive = _activeVisualPresetId === preset.id;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset-swatch' + (isActive ? ' active' : '');
        btn.title = preset.name;
        btn.innerHTML = `
          <div class="preset-swatch-preview" style="background:${preset.pageBg}">
            <div class="preset-swatch-dots">
              <span class="preset-swatch-dot" style="background:${preset.previewAccent}"></span>
              <span class="preset-swatch-dot" style="background:${preset.previewSecondary}"></span>
            </div>
            ${isActive ? `<div class="preset-swatch-check"><svg width="8" height="8" viewBox="0 0 9 9" fill="none"><path d="M1.5 4.5L3.5 6.5L7.5 2" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` : ''}
          </div>
          <div class="preset-swatch-info">
            <div class="preset-swatch-name">${escapeHtml(preset.name)}</div>
            <div class="preset-swatch-tagline">${escapeHtml(preset.tagline)}</div>
          </div>`;
        btn.addEventListener('click', () => {
          _activeVisualPresetId = preset.id;
          applyVisualPreset(preset);
          renderVisualPresetPicker();
        });
        grid.appendChild(btn);
      });

      groupEl.appendChild(grid);
      presetGroupsEl.appendChild(groupEl);
    });
  }

  renderVisualPresetPicker();

  toggleProviderNote(aiProviderSelect.value);
  aiProviderSelect.addEventListener('change', () => toggleProviderNote(aiProviderSelect.value));

  function toggleProviderNote(provider) {
    // Notes are optional — the cloud note was removed from the settings UI
    const cloudNote = document.getElementById('provider-note-cloud');
    const freeNote  = document.getElementById('provider-note-free');
    if (cloudNote) cloudNote.style.display = provider === 'cloud' ? 'block' : 'none';
    if (freeNote)  freeNote.style.display  = provider === 'freedict' ? 'block' : 'none';
  }

  saveSettingsBtn.addEventListener('click', async () => {
    const newSettings = {
      provider: aiProviderSelect.value,
      targetLanguage: 'Vietnamese', // fixed: Semantica is English → Vietnamese
      accentColor: _accentHex,
      // Derived hue kept for backward compatibility with pre-picker settings
      // readers (anything still branching on accentHue keeps working).
      accentHue: hexToHslParts(_accentHex).h,
      darkMode: darkToggle.checked,
      visualPreset: _activeVisualPresetId,
    };
    await saveSettings(newSettings);
    applyAccentHex(_accentHex, newSettings.darkMode);
    saveMsg.style.opacity = 1;
    setTimeout(() => { saveMsg.style.opacity = 0; }, 2000);
  });

  // ─── Load IELTS wordlist (non-blocking) ──────────────────────────────────
  loadIeltsWordlist();

  // ─── Load vocab from cloud on startup (only if logged in) ────────────────────
  // pushWordCache keeps the main-process word list in sync for the search bar
  function pushWordCache() {
    if (window.electronAPI?.sendWordCache) window.electronAPI.sendWordCache(getWords());
  }

  if (isLoggedIn()) {
    await loadVocab();
    pushWordCache();
  }

  // ─── Word of the Day — one popup per day, on the first launch (boot) ─────────
  (function maybeShowWordOfTheDay() {
    // Dedicated WOTD layout at the tray corner (Tauri); harmless no-op elsewhere
    const showFn = window.electronAPI?.showWordOfDay || window.electronAPI?.searchWord;
    if (!showFn) return;
    if (!isLoggedIn()) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('wotd_last_shown') === today) return;

    const words = getWords();
    if (!words.length) return;
    // Prefer words the user is still learning; fall back to any saved word
    const pool = words.filter(w => ['new', 'learning', 'relearn'].includes(w.learningState || 'new'));
    const from = pool.length ? pool : words;
    const pick = from[Math.floor(Math.random() * from.length)];

    localStorage.setItem('wotd_last_shown', today);
    // Small delay so the word-cache push has landed in the backend state —
    // the popup then renders instantly from savedData, no API call
    setTimeout(() => showFn(pick.text), 1500);
  })();

  // ─── Vocabulary List ─────────────────────────────────────────────────────────
  const tableBody    = document.getElementById('word-table-body');
  const emptyState   = document.getElementById('empty-state');
  const tagCloud     = document.getElementById('tag-cloud');
  const tagTabsEl    = document.getElementById('tag-cloud-tabs');
  const tagChipsEl   = document.getElementById('tag-cloud-chips');
  const filterBar    = document.getElementById('tag-filter-bar');
  const filterLabel  = document.getElementById('tag-filter-label');
  const reviewBtn    = document.getElementById('tag-review-btn');
  const clearBtn     = document.getElementById('tag-clear-btn');

  // ─── Tag / Band / Topic filter state ─────────────────────────────────────────
  const selectedTags   = new Set();
  const selectedBands  = new Set(); // Set<number>
  const selectedTopics = new Set(); // Set<string>

  // ─── Alphabetical sort state ─────────────────────────────────────────────────
  // null = default order (cache order — newest saved word first); 'asc'/'desc' =
  // A→Z / Z→A by word text. Cycled by the sort button in initVocabSearch().
  let _vocabSortOrder = null;

  // Which filter group's chips are currently on screen. Module-level so the
  // choice survives re-renders (adding a word, toggling a chip, etc.).
  let _activeFilterGroup = null; // 'band' | 'topic' | 'tag'

  function renderTagCloud(allWords) {
    if (!allWords) allWords = getWords().slice();

    const bandColors  = { 2:'#64748b',3:'#64748b',5:'#0d9488',6:'#0891b2',7:'#7c3aed',8:'#b45309',9:'#b91c1c' };
    const bandCounts  = new Map(); // band number → word count
    const topicCounts = new Map(); // topic string → word count
    const tagCounts   = new Map(); // tag string → word count

    allWords.forEach(w => {
      const ielts = lookupIelts(w.text);
      if (ielts) bandCounts.set(ielts.band, (bandCounts.get(ielts.band) || 0) + 1);

      (w.aiAnalysis?.ieltsTopics || []).forEach(t =>
        topicCounts.set(t, (topicCounts.get(t) || 0) + 1));

      [...new Set([...(w.aiAnalysis?.tags || []), ...(w.userTags || [])])].forEach(t =>
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
    });

    // Each group renders as its own tab so only one set of chips shows at a
    // time — three stacked rows made the strip feel cramped, a single roomy
    // panel per group does not.
    const groups = [
      { key: 'band',  label: 'By IELTS band', icon: '🎯', counts: bandCounts,  selected: selectedBands  },
      { key: 'topic', label: 'By IELTS topic', icon: '📚', counts: topicCounts, selected: selectedTopics },
      { key: 'tag',   label: 'By AI topic',    icon: '✨', counts: tagCounts,   selected: selectedTags   },
    ].filter(g => g.counts.size > 0);

    if (!groups.length) { tagCloud.style.display = 'none'; return; }

    tagCloud.style.display = 'block';

    // Keep the active tab if it's still available; otherwise land on a group
    // that already has a selection, falling back to the first available tab.
    if (!groups.some(g => g.key === _activeFilterGroup)) {
      _activeFilterGroup = (groups.find(g => g.selected.size > 0) || groups[0]).key;
    }

    // ── Tab strip ────────────────────────────────────────────────────────────
    tagTabsEl.innerHTML = '';
    groups.forEach(g => {
      const tab = document.createElement('button');
      tab.className = 'filter-tab' + (g.key === _activeFilterGroup ? ' active' : '') + (g.selected.size > 0 ? ' has-selection' : '');
      tab.innerHTML = `<span class="filter-tab-icon">${g.icon}</span>${g.label}<span class="filter-tab-count">${g.counts.size}</span><span class="filter-tab-dot"></span>`;
      tab.addEventListener('click', () => { _activeFilterGroup = g.key; renderTagCloud(allWords); });
      tagTabsEl.appendChild(tab);
    });

    // ── Active group's chip panel ─────────────────────────────────────────────
    tagChipsEl.innerHTML = '';
    const panel = document.createElement('div');
    panel.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;max-height:80px;overflow:hidden;';

    const active = groups.find(g => g.key === _activeFilterGroup);

    if (active.key === 'band') {
      [...bandCounts.entries()].sort((a, b) => a[0] - b[0]).forEach(([band, count]) => {
        const bc  = bandColors[band] || '#64748b';
        const btn = document.createElement('button');
        btn.className = 'tag-chip tag-chip-lg' + (selectedBands.has(band) ? ' active' : '');
        btn.style.cssText = `background:linear-gradient(${bc}22,${bc}22), var(--muted-bg);color:${bc};border-color:${bc}40;font-weight:700;letter-spacing:0.03em;`;
        btn.innerHTML = `Band ${band} <span class="tag-count" style="background:linear-gradient(${bc}35,${bc}35), var(--muted-bg);color:${bc};">${count}</span>`;
        btn.addEventListener('click', () => {
          if (selectedBands.has(band)) selectedBands.delete(band); else selectedBands.add(band);
          renderWords();
        });
        panel.appendChild(btn);
      });
    } else if (active.key === 'topic') {
      [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([topic, count]) => {
        const btn = document.createElement('button');
        btn.className = 'tag-chip tag-chip-lg tag-chip-topic' + (selectedTopics.has(topic) ? ' active' : '');
        btn.innerHTML = `${escapeHtml(topic)} <span class="tag-count">${count}</span>`;
        btn.addEventListener('click', () => {
          if (selectedTopics.has(topic)) selectedTopics.delete(topic); else selectedTopics.add(topic);
          renderWords();
        });
        panel.appendChild(btn);
      });
    } else {
      [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([tag, count]) => {
        const btn = document.createElement('button');
        btn.className = 'tag-chip tag-chip-lg' + (selectedTags.has(tag) ? ' active' : '');
        btn.innerHTML = `${escapeHtml(tag)} <span class="tag-count">${count}</span>`;
        btn.addEventListener('click', () => {
          if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
          renderWords();
        });
        panel.appendChild(btn);
      });
    }

    tagChipsEl.appendChild(panel);

    // "See more" only appears once the active panel actually overflows 2 lines
    const seeMoreBtn = document.createElement('button');
    seeMoreBtn.className = 'filter-see-more';
    seeMoreBtn.textContent = 'See more ↓';
    let expanded = false;
    seeMoreBtn.onclick = () => {
      expanded = !expanded;
      panel.style.maxHeight = expanded ? 'none' : '80px';
      seeMoreBtn.textContent = expanded ? 'See less ↑' : 'See more ↓';
    };
    tagChipsEl.appendChild(seeMoreBtn);
    requestAnimationFrame(() => {
      if (panel.scrollHeight > 84) seeMoreBtn.style.display = 'block';
    });
  }

  function updateFilterBar(filteredCount) {
    const hasAnyFilter = selectedTags.size > 0 || selectedBands.size > 0 || selectedTopics.size > 0;
    if (!hasAnyFilter) { filterBar.style.display = 'none'; return; }

    filterBar.style.display = 'flex';
    const parts = [];
    if (selectedBands.size > 0)  parts.push([...selectedBands].sort().map(b => `Band ${b}`).join(', '));
    if (selectedTopics.size > 0) parts.push([...selectedTopics].map(t => `"${t}"`).join(', '));
    if (selectedTags.size > 0)   parts.push([...selectedTags].map(t => `"${t}"`).join(', '));
    filterLabel.textContent = `${filteredCount} word${filteredCount !== 1 ? 's' : ''} · ${parts.join(' · ')}`;
  }

  clearBtn.addEventListener('click', () => {
    selectedTags.clear();
    selectedBands.clear();
    selectedTopics.clear();
    renderWords();
  });

  reviewBtn.addEventListener('click', () => {
    // Switch to review tab and start a session with only filtered words
    const allWords = getWords().slice();
    const hasAnyFilter = selectedTags.size > 0 || selectedBands.size > 0 || selectedTopics.size > 0;
    const filtered = !hasAnyFilter ? allWords : allWords.filter(w => {
      if (selectedBands.size > 0) {
        const ielts = lookupIelts(w.text);
        if (!ielts || !selectedBands.has(ielts.band)) return false;
      }
      if (selectedTopics.size > 0) {
        const topics = w.aiAnalysis?.ieltsTopics || [];
        if (!topics.some(t => selectedTopics.has(t))) return false;
      }
      if (selectedTags.size > 0) {
        const tags = [...(w.aiAnalysis?.tags || []), ...(w.userTags || [])];
        if (!tags.some(t => selectedTags.has(t))) return false;
      }
      return true;
    });

    // Navigate to review view and start session with filtered set
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    const reviewTab = document.querySelector('[data-target="review-view"]');
    if (reviewTab) reviewTab.classList.add('active');
    document.getElementById('review-view').classList.add('active');
    startReviewSession(filtered);
  });

  if (isLoggedIn()) await renderWords();

  // searchWords: optional pre-filtered/sorted list from the search bar
  async function renderWords(searchWords) {
    // Cache is newest-first (apiSaveWord prepends), so no .reverse() needed
    const allWords = (await getWords()).slice();

    // Rebuild tag cloud always from full word list (not the search subset)
    renderTagCloud(allWords);

    // If search is providing a sorted subset, use it directly (skip tag filter)
    let words;
    if (searchWords) {
      words = searchWords;
    } else {
      // Apply band + topic + tag filters (all active filters must match — AND across groups)
      words = allWords.filter(w => {
        if (selectedBands.size > 0) {
          const ielts = lookupIelts(w.text);
          if (!ielts || !selectedBands.has(ielts.band)) return false;
        }
        if (selectedTopics.size > 0) {
          const topics = w.aiAnalysis?.ieltsTopics || [];
          if (!topics.some(t => selectedTopics.has(t))) return false;
        }
        if (selectedTags.size > 0) {
          const tags = [...(w.aiAnalysis?.tags || []), ...(w.userTags || [])];
          if (!tags.some(t => selectedTags.has(t))) return false;
        }
        return true;
      });
    }

    // Alphabetical sort overrides whatever ordering the block above produced
    // (cache order or search relevance order) — applies on top of any active
    // filters/search rather than replacing them.
    if (_vocabSortOrder) {
      words = words.slice().sort((a, b) =>
        _vocabSortOrder === 'asc'
          ? a.text.localeCompare(b.text)
          : b.text.localeCompare(a.text)
      );
    }

    updateFilterBar(words.length);
    tableBody.innerHTML = '';

    const goToTopRow = document.getElementById('go-to-top-row');
    if (words.length === 0) {
      emptyState.style.display = 'block';
      document.querySelector('table').style.display = 'none';
      if (goToTopRow) goToTopRow.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    document.querySelector('table').style.display = 'table';
    if (goToTopRow) {
      goToTopRow.style.display = 'block';
      const goBtn = document.getElementById('go-to-top-btn');
      if (goBtn) goBtn.onclick = () => {
        const mainEl = document.getElementById('main-scroll');
        if (mainEl) mainEl.scrollTo({ top: 0, behavior: 'smooth' });
      };
    }

    words.forEach(word => {
      const tr = document.createElement('tr');

      // Word Column
      const tdWord = document.createElement('td');
      tdWord.className = 'word-col';
      tdWord.style.verticalAlign = 'top';

      const wordRow = document.createElement('div');
      wordRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:4px;';

      const wordGrad = document.createElement('div');
      wordGrad.style.cssText = 'font-size:20px;font-weight:700;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-0.3px;line-height:1.2;';
      wordGrad.textContent = word.text;

      // Words are captured lowercase (see popup.js handleSave / the lookup
      // modal's save handler) so casing never creates duplicate-looking
      // entries. This pencil lets the user manually restore the original
      // form — proper nouns, acronyms, etc. — since that casing is discarded
      // at capture time and can't be recovered automatically.
      const editWordBtn = document.createElement('button');
      editWordBtn.innerHTML = '<i data-lucide="edit-2" style="width:11px;height:11px;stroke-width:2.5;"></i>';
      editWordBtn.className = 'edit-hover-btn';
      editWordBtn.title = 'Edit word (e.g. restore original capitalization)';
      editWordBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--text-muted);opacity:0;transition:opacity 0.15s,color 0.15s;padding:2px;flex-shrink:0;';
      editWordBtn.onmouseenter = () => { editWordBtn.style.color = 'var(--brand)'; };
      editWordBtn.onmouseleave = () => { editWordBtn.style.color = 'var(--text-muted)'; };

      editWordBtn.onclick = () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = word.text;
        input.maxLength = 60;
        input.style.cssText = 'font-size:18px;font-weight:700;color:var(--text-main);border:1px solid var(--brand);border-radius:6px;padding:2px 6px;width:150px;font-family:inherit;background:var(--card-bg-translucent, rgba(255,255,255,0.7));';

        const warnEl = document.createElement('span');
        warnEl.style.cssText = 'font-size:10px;color:#ef4444;white-space:nowrap;';

        wordRow.innerHTML = '';
        wordRow.appendChild(input);
        input.focus();
        input.select();

        let settled = false;

        const restoreView = () => {
          wordRow.innerHTML = '';
          wordRow.appendChild(wordGrad);
          wordRow.appendChild(editWordBtn);
        };

        const commit = async () => {
          if (settled) return;
          const newText = input.value.trim();

          if (!newText || newText.toLowerCase() === word.text.toLowerCase()) {
            settled = true;
            restoreView();
            return;
          }

          const dupe = getWords().some(w =>
            w.text.toLowerCase() !== word.text.toLowerCase() &&
            w.text.toLowerCase() === newText.toLowerCase()
          );
          if (dupe) {
            settled = true;
            warnEl.textContent = 'Already in your vocabulary';
            wordRow.appendChild(warnEl);
            setTimeout(restoreView, 1400);
            return;
          }

          settled = true;
          await updateWord(word.text, { text: newText });
          pushWordCache(); // keep main-process search cache in sync with the rename
          await renderWords();
        };

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { ev.preventDefault(); settled = true; restoreView(); }
        });
        input.addEventListener('blur', () => setTimeout(commit, 120));
      };

      wordRow.appendChild(wordGrad);
      wordRow.appendChild(editWordBtn);
      if (window.lucide) window.lucide.createIcons({ nodes: [editWordBtn] });

      const phonetic = document.createElement('div');
      phonetic.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:monospace;margin-bottom:8px;';
      phonetic.textContent = (word.aiAnalysis?.pronunciation) || '';

      const playBtn = createSpeakerButton(word.text, word.aiAnalysis?.audioBase64, 'Play');

      tdWord.appendChild(wordRow);
      tdWord.appendChild(phonetic);
      tdWord.appendChild(playBtn);

      // Band badge — displayed as its own line under the play button
      const ieltsForBadge = lookupIelts(word.text);
      if (ieltsForBadge) {
        const bandColors = { 2:'#64748b',3:'#64748b',5:'#0d9488',6:'#0891b2',7:'#7c3aed',8:'#b45309',9:'#b91c1c' };
        const bc = bandColors[ieltsForBadge.band] || '#64748b';
        const bandBadge = document.createElement('div');
        bandBadge.style.cssText = `margin-top:7px;`;
        const bandPill = document.createElement('span');
        bandPill.style.cssText = `padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;background:linear-gradient(${bc}28,${bc}28), var(--muted-bg);color:${bc};border:1px solid ${bc}40;`;
        bandPill.textContent = `Band ${ieltsForBadge.band}`;
        bandBadge.appendChild(bandPill);
        tdWord.appendChild(bandBadge);
      }

      // Context/Meaning Column
      const tdContext = document.createElement('td');
      tdContext.className = 'context-col';

      // word.context only exists for words captured from a real sentence
      // (video subtitle, imported text, etc.) — words saved by looking up an
      // individual word (search bar, popup, "Define this word") have no
      // context at all, so quoting an empty string used to render a bare ""
      // with nothing inside it. Only show the quoted line when there's an
      // actual sentence to quote.
      if (word.context && word.context.trim()) {
        const contextDiv = document.createElement('div');
        contextDiv.style.fontStyle   = 'italic';
        contextDiv.style.marginBottom = '4px';
        contextDiv.style.color        = 'var(--text-muted)';
        contextDiv.textContent        = `"${word.context}"`;
        tdContext.appendChild(contextDiv);
      }

      // YouTube jump-to-moment link
      if (word.videoId) {
        const sourceLink = document.createElement('a');
        sourceLink.href   = `https://www.youtube.com/watch?v=${encodeURIComponent(word.videoId)}&t=${word.videoTime || 0}`;
        sourceLink.target = '_blank';
        sourceLink.rel    = 'noopener noreferrer';
        const ytTitle = word.title ? escapeHtml(word.title) : 'Watch in context';
        const ytTime  = word.videoTime ? ` · ${Math.floor(word.videoTime / 60)}:${String(word.videoTime % 60).padStart(2,'0')}` : '';
        sourceLink.innerHTML = `<i data-lucide="youtube" style="width:11px;height:11px;display:inline-block;vertical-align:middle;margin-right:4px;stroke-width:2;"></i>${ytTitle}${ytTime}`;
        sourceLink.style.cssText = 'display:inline-flex;align-items:center;font-size:11px;color:#f43f5e;text-decoration:none;margin-bottom:8px;font-weight:500;transition:color 0.15s;';
        sourceLink.onmouseenter = () => { sourceLink.style.color = '#e11d48'; };
        sourceLink.onmouseleave = () => { sourceLink.style.color = '#f43f5e'; };
        tdContext.appendChild(sourceLink);
        if (window.lucide) window.lucide.createIcons({ nodes: [sourceLink] });
      }

      const aiResultDiv = document.createElement('div');
      aiResultDiv.className = 'ai-result visible';
      aiResultDiv.id        = `ai-result-${encodeURIComponent(word.text)}`;
      aiResultDiv.className += ' ai-card-bg';
      aiResultDiv.style.marginTop = '6px';

      const analysis = word.aiAnalysis || {};
      renderDefinitionBlock(aiResultDiv, word, analysis);
      tdContext.appendChild(aiResultDiv);

      // Tags Column — AI tags + user-created tags + add-tag editor
      const tdTags = document.createElement('td');
      tdTags.className = 'tags-col';

      /** Re-render the tag list + add button inside tdTags */
      function renderTagsInCell(w) {
        tdTags.innerHTML = '';
        const aiTags   = w.aiAnalysis?.tags   || [];
        const userTags = w.userTags            || [];
        const allTags  = [...new Set([...aiTags, ...userTags])];

        allTags.forEach(tag => {
          const sp = document.createElement('span');
          sp.className   = 'tag';
          sp.textContent = tag;
          // User tags get an ✕ remove button
          if (userTags.includes(tag)) {
            sp.style.paddingRight = '4px';
            const rm = document.createElement('button');
            rm.textContent = '×';
            rm.title       = 'Remove tag';
            rm.style.cssText = 'background:none;border:none;margin-left:3px;cursor:pointer;color:inherit;font-size:12px;line-height:1;padding:0;opacity:0.6;';
            rm.addEventListener('click', async (e) => {
              e.stopPropagation();
              const newUserTags = (w.userTags || []).filter(t => t !== tag);
              w.userTags = newUserTags;
              await updateWord(w.text, { userTags: newUserTags });
              renderTagsInCell(w);
              renderTagCloud();
            });
            sp.appendChild(rm);
          }
          tdTags.appendChild(sp);
        });

        // "+" add-tag button
        const addBtn = document.createElement('button');
        addBtn.className   = 'tag-add-btn';
        addBtn.textContent = '+ tag';
        addBtn.title       = 'Add a tag';
        addBtn.style.cssText = 'background:none;border:1px dashed var(--border);border-radius:6px;padding:3px 8px;font-size:10px;font-weight:600;color:var(--text-muted);cursor:pointer;margin-top:3px;transition:all 0.15s;font-family:inherit;';
        addBtn.addEventListener('mouseenter', () => { addBtn.style.borderColor = 'var(--brand)'; addBtn.style.color = 'var(--brand)'; });
        addBtn.addEventListener('mouseleave', () => { addBtn.style.borderColor = 'var(--border)'; addBtn.style.color = 'var(--text-muted)'; });

        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          addBtn.style.display = 'none';

          const input = document.createElement('input');
          input.type        = 'text';
          input.placeholder = 'tag name…';
          input.maxLength   = 30;
          input.style.cssText = 'border:1px solid var(--brand);border-radius:6px;padding:3px 8px;font-size:10px;font-family:inherit;outline:none;width:80px;background:var(--card-bg-translucent, rgba(255,255,255,0.7));color:var(--text-main);';
          tdTags.appendChild(input);
          input.focus();

          const commit = async () => {
            const newTag = input.value.trim().toLowerCase();
            if (newTag && newTag.length > 0) {
              const newUserTags = [...new Set([...(w.userTags || []), newTag])];
              w.userTags = newUserTags;
              await updateWord(w.text, { userTags: newUserTags });
              renderTagCloud(); // refresh global tag cloud
            }
            renderTagsInCell(w);
          };

          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { renderTagsInCell(w); }
          });
          input.addEventListener('blur', () => setTimeout(commit, 120));
        });

        tdTags.appendChild(addBtn);
      }

      renderTagsInCell(word);

      // Actions Column
      const tdActions = document.createElement('td');
      tdActions.className = 'actions-col';

      const btnDelete = document.createElement('button');
      btnDelete.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;font-size:11px;font-weight:500;border:1px solid transparent;color:var(--text-muted);background:none;cursor:pointer;font-family:inherit;transition:all 0.15s;';
      btnDelete.innerHTML = '<i data-lucide="trash-2" style="width:11px;height:11px;stroke-width:2.5;"></i> Delete';
      btnDelete.onmouseenter = () => { btnDelete.style.borderColor='rgba(239,68,68,0.3)'; btnDelete.style.color='#ef4444'; btnDelete.style.background='rgba(239,68,68,0.05)'; };
      btnDelete.onmouseleave = () => { btnDelete.style.borderColor='transparent'; btnDelete.style.color='var(--text-muted)'; btnDelete.style.background='none'; };
      btnDelete.onclick = () => handleDelete(word.text, btnDelete);

      tdActions.appendChild(btnDelete);
      if (window.lucide) window.lucide.createIcons({ nodes: [tdActions] });

      tr.appendChild(tdWord);
      tr.appendChild(tdContext);
      tr.appendChild(tdTags);
      tr.appendChild(tdActions);

      // Hover shows edit button
      tr.addEventListener('mouseenter', () => { tr.querySelectorAll('.edit-hover-btn').forEach(b => b.style.opacity = '1'); });
      tr.addEventListener('mouseleave', () => { tr.querySelectorAll('.edit-hover-btn').forEach(b => b.style.opacity = '0'); });

      tableBody.appendChild(tr);
      if (window.lucide) window.lucide.createIcons({ nodes: [tr] });
    });
  }

  // ─── Definition block renderer ────────────────────────────────────────────────
  function renderDefinitionBlock(container, word, analysis) {
    container.innerHTML = '';

    // Meta: POS + IELTS topic chips
    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-bottom:6px;';

    if (analysis.partOfSpeech) {
      const pos = document.createElement('em');
      pos.style.cssText = 'font-size:0.85em;color:var(--text-muted)';
      pos.textContent = analysis.partOfSpeech;
      metaRow.appendChild(pos);
    }

    if (analysis.ieltsTopics && analysis.ieltsTopics.length > 0) {
      analysis.ieltsTopics.forEach(topic => {
        const chip = document.createElement('span');
        chip.style.cssText = 'padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:linear-gradient(rgba(99,102,241,0.14),rgba(99,102,241,0.14)), var(--muted-bg);color:#818cf8;border:1px solid rgba(99,102,241,0.25);';
        chip.textContent = topic;
        metaRow.appendChild(chip);
      });
    }

    if (metaRow.children.length > 0) container.appendChild(metaRow);
    const meta = metaRow; // keep reference for edit cancel handler

    // Translation (primary, prominent)
    if (analysis.translation) {
      const transRow = document.createElement('div');
      transRow.style.cssText = 'color:var(--brand);font-weight:700;font-size:16px;margin-bottom:6px;display:flex;align-items:center;gap:5px';
      transRow.innerHTML = `<span style="opacity:0.75;font-size:13px">🌐</span>${escapeHtml(analysis.translation)}`;
      container.appendChild(transRow);
    }

    // Native-language definition (main explanation)
    if (analysis.definitionTranslated) {
      const nativeDef = document.createElement('div');
      nativeDef.style.cssText = 'font-size:0.95em;line-height:1.6;color:var(--text-main);white-space:pre-line;margin-bottom:8px';
      nativeDef.textContent = analysis.definitionTranslated;
      container.appendChild(nativeDef);
    }

    // English definition — EN label inline, Figma style
    if (analysis.definition) {
      const defRow = document.createElement('div');
      defRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);margin-top:4px;margin-bottom:6px;';

      const enLabel = document.createElement('span');
      enLabel.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-soft);margin-top:2px;flex-shrink:0;';
      enLabel.textContent = 'EN';
      defRow.appendChild(enLabel);

      const defText = document.createElement('div');
      defText.style.cssText = 'font-size:12px;color:var(--text-muted);line-height:1.55;white-space:pre-line;flex:1;'
      defText.textContent = analysis.definition;

      const editBtn = document.createElement('button');
      editBtn.innerHTML = '<i data-lucide="edit-2" style="width:11px;height:11px;stroke-width:2.5;"></i>';
      editBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:var(--text-muted);opacity:0;transition:opacity 0.15s,color 0.15s;padding:2px;flex-shrink:0;';
      editBtn.className = 'edit-hover-btn';
      editBtn.title = 'Edit English definition';
      editBtn.onmouseenter = () => { editBtn.style.color = 'var(--brand)'; };
      editBtn.onmouseleave = () => { editBtn.style.color = 'var(--text-muted)'; };

      editBtn.onclick = () => {
        const textarea = document.createElement('textarea');
        textarea.className   = 'edit-def-area';
        textarea.value       = analysis.definition || '';
        textarea.style.cssText = 'width:100%;font-family:inherit;padding:5px;border:1px solid var(--brand);border-radius:4px';
        textarea.rows = 3;

        const saveBtn = document.createElement('button');
        saveBtn.textContent    = 'Save';
        saveBtn.className      = 'btn-primary';
        saveBtn.style.cssText  = 'margin-top:5px;font-size:12px;padding:4px 8px';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent   = 'Cancel';
        cancelBtn.className     = 'btn-ghost';
        cancelBtn.style.cssText = 'font-size:12px;padding:4px 8px';

        const actionRow = document.createElement('div');
        actionRow.appendChild(saveBtn);
        actionRow.appendChild(cancelBtn);

        container.innerHTML = '';
        container.appendChild(meta);
        container.appendChild(textarea);
        container.appendChild(actionRow);
        textarea.focus();

        saveBtn.onclick = async () => {
          const newAnalysis = { ...analysis, definition: textarea.value };
          await updateWord(word.text, { aiAnalysis: newAnalysis });
          renderDefinitionBlock(container, word, newAnalysis);
        };
        cancelBtn.onclick = () => renderDefinitionBlock(container, word, analysis);
      };

      defRow.appendChild(defText);
      defRow.appendChild(editBtn);
      container.appendChild(defRow);
      if (window.lucide) window.lucide.createIcons({ nodes: [editBtn] });
    }

    // Example sentences
    if (analysis.exampleSentence) {
      const exBlock = document.createElement('div');
      exBlock.style.cssText = 'padding-top:8px;border-top:1px solid var(--border)';

      const ex = document.createElement('div');
      ex.style.cssText = 'font-size:0.88em;color:var(--text-muted);font-style:italic;line-height:1.5;margin-bottom:3px';
      ex.textContent = `"${analysis.exampleSentence}"`;
      exBlock.appendChild(ex);

      if (analysis.exampleSentenceTranslated) {
        const exTrans = document.createElement('div');
        exTrans.style.cssText = 'font-size:0.85em;color:var(--text-muted);opacity:0.7;line-height:1.5';
        exTrans.textContent = `"${analysis.exampleSentenceTranslated}"`;
        exBlock.appendChild(exTrans);
      }

      container.appendChild(exBlock);
    }

    // IELTS collocations
    const ielts = lookupIelts(word.text);
    if (ielts && ielts.collocations.length > 0) {
      const collBlock = document.createElement('div');
      collBlock.style.cssText = 'padding-top:8px;margin-top:4px;border-top:1px solid var(--border);';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-soft);margin-bottom:6px;';
      label.textContent = 'Common Collocations';
      collBlock.appendChild(label);

      const pills = document.createElement('div');
      pills.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;';

      // Show first 6 collocations
      ielts.collocations.slice(0, 6).forEach(phrase => {
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;background:linear-gradient(rgba(6,182,212,0.10),rgba(6,182,212,0.10)), var(--muted-bg);border:1px solid rgba(6,182,212,0.18);color:var(--text-muted);';
        pill.textContent = phrase;
        pills.appendChild(pill);
      });

      if (ielts.collocations.length > 6) {
        const more = document.createElement('span');
        more.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;color:var(--text-subtle);cursor:pointer;';
        more.textContent = `+${ielts.collocations.length - 6} more`;
        more.onclick = () => {
          more.remove();
          ielts.collocations.slice(6).forEach(phrase => {
            const pill = document.createElement('span');
            pill.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;background:linear-gradient(rgba(6,182,212,0.10),rgba(6,182,212,0.10)), var(--muted-bg);border:1px solid rgba(6,182,212,0.18);color:var(--text-muted);';
            pill.textContent = phrase;
            pills.appendChild(pill);
          });
        };
        pills.appendChild(more);
      }

      collBlock.appendChild(pills);
      container.appendChild(collBlock);
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────
  async function handleDelete(text, btnEl) {
    const original      = btnEl.innerHTML;
    const originalTitle = btnEl.title;
    btnEl.innerHTML = '✓';
    btnEl.title     = 'Confirm delete';
    btnEl.style.color = '#e74c3c';

    const cancelBtn = document.createElement('button');
    cancelBtn.className   = 'btn-icon';
    cancelBtn.innerHTML   = '✕';
    cancelBtn.title       = 'Cancel';
    cancelBtn.style.marginLeft = '4px';

    btnEl.parentNode.insertBefore(cancelBtn, btnEl.nextSibling);

    btnEl.onclick = async () => {
      cancelBtn.remove();
      await deleteWord(text);
      pushWordCache(); // keep main-process cache in sync so search bar drops the deleted word
      await renderWords();
    };
    cancelBtn.onclick = () => {
      cancelBtn.remove();
      btnEl.innerHTML = original;
      btnEl.title     = originalTitle;
      btnEl.style.color = '#e74c3c';
      btnEl.onclick = () => handleDelete(text, btnEl);
    };
  }

  // ─── Sentences View ───────────────────────────────────────────────────────────
  async function renderSentences() {
    const el = document.getElementById('sentences-list');
    const words = await getWords();

    // Use original context if available, fall back to AI-generated example sentence
    const getSentence = w => w.context || w.aiAnalysis?.exampleSentence || '';
    const withContext = words.filter(w => getSentence(w));

    if (!withContext.length) {
      el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:32px">No sentences yet. Save words to see their example sentences here.</p>';
      return;
    }

    el.innerHTML = '';
    withContext.forEach(word => {
      const sentenceText = getSentence(word);
      const isAiExample = !word.context && !!word.aiAnalysis?.exampleSentence;

      const row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px solid var(--border);padding:16px 0;display:flex;gap:16px;align-items:flex-start;';

      const badge = document.createElement('div');
      badge.style.cssText = 'min-width:80px;font-weight:700;font-size:14px;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;padding-top:2px;';
      badge.textContent = word.text;

      const detail = document.createElement('div');
      const sentence = document.createElement('div');
      sentence.style.cssText = 'font-style:italic;color:var(--text-main);margin-bottom:6px;line-height:1.5;';
      sentence.textContent = `"${sentenceText}"`;

      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-muted);display:flex;gap:12px;align-items:center;flex-wrap:wrap;';

      if (word.title) {
        const titleSpan = document.createElement('span');
        titleSpan.textContent = word.title;
        meta.appendChild(titleSpan);
      }

      if (word.videoId) {
        const link = document.createElement('a');
        link.href   = `https://www.youtube.com/watch?v=${encodeURIComponent(word.videoId)}&t=${word.videoTime || 0}`;
        link.target = '_blank';
        link.rel    = 'noopener noreferrer';
        link.textContent = '▶ Watch moment';
        link.style.cssText = 'color:var(--brand);text-decoration:none;font-weight:500;';
        link.onmouseenter = () => { link.style.textDecoration = 'underline'; };
        link.onmouseleave = () => { link.style.textDecoration = 'none'; };
        meta.appendChild(link);
      }

      if (isAiExample) {
        const aiLabel = document.createElement('span');
        aiLabel.textContent = '✦ AI example';
        aiLabel.style.cssText = 'font-size:10px;font-weight:600;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:999px;padding:2px 8px;display:inline-block;margin-bottom:6px;';
        detail.appendChild(aiLabel);
      }

      detail.appendChild(sentence);
      detail.appendChild(meta);
      row.appendChild(badge);
      row.appendChild(detail);
      el.appendChild(row);
    });
  }

  // ─── Videos View ─────────────────────────────────────────────────────────────
  async function renderVideos() {
    const el = document.getElementById('videos-list');
    const words = await getWords();

    const videoMap   = new Map();
    const otherWords = [];

    words.forEach(word => {
      if (word.videoId) {
        if (!videoMap.has(word.videoId)) {
          videoMap.set(word.videoId, { title: word.title || word.videoId, url: word.url, videoId: word.videoId, words: [] });
        }
        videoMap.get(word.videoId).words.push(word);
      } else if (word.url || word.context) {
        otherWords.push(word);
      }
    });

    if (!videoMap.size && !otherWords.length) {
      el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:32px">No video words saved yet. Hover over subtitle words on YouTube and save them.</p>';
      return;
    }

    el.innerHTML = '';

    videoMap.forEach(({ title, url, videoId, words: vWords }) => {
      const block = document.createElement('div');
      block.style.cssText = 'margin-bottom:28px;';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-weight:700;font-size:15px;color:var(--text-main);';
      titleEl.textContent = title;

      const linkEl = document.createElement('a');
      linkEl.href   = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      linkEl.target = '_blank';
      linkEl.rel    = 'noopener noreferrer';
      linkEl.textContent = `▶ Open video · ${vWords.length} word${vWords.length !== 1 ? 's' : ''}`;
      linkEl.style.cssText = 'font-size:12px;color:var(--brand);text-decoration:none;white-space:nowrap;';
      linkEl.onmouseenter = () => { linkEl.style.textDecoration = 'underline'; };
      linkEl.onmouseleave = () => { linkEl.style.textDecoration = 'none'; };

      header.appendChild(titleEl);
      header.appendChild(linkEl);

      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      vWords.forEach(w => {
        const chip = document.createElement('a');
        chip.href   = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${w.videoTime || 0}`;
        chip.target = '_blank';
        chip.rel    = 'noopener noreferrer';
        chip.title  = w.context || '';
        chip.textContent = w.text;
        chip.style.cssText = `
          display:inline-block;padding:4px 10px;border-radius:20px;font-size:13px;font-weight:600;
          background:var(--brand-soft);color:var(--brand);text-decoration:none;
          border:1px solid var(--brand-border,rgba(0,0,0,0.08));
          transition:opacity 0.15s;
        `;
        chip.onmouseenter = () => { chip.style.opacity = '0.75'; };
        chip.onmouseleave = () => { chip.style.opacity = '1'; };
        chips.appendChild(chip);
      });

      block.appendChild(header);
      block.appendChild(chips);
      el.appendChild(block);
    });

    if (otherWords.length) {
      const block = document.createElement('div');
      block.style.cssText = 'margin-bottom:28px;border-top:1px solid var(--border);padding-top:24px;';
      const header = document.createElement('div');
      header.style.cssText = 'font-weight:700;font-size:15px;color:var(--text-muted);margin-bottom:12px;';
      header.textContent = `Other Sources · ${otherWords.length} word${otherWords.length !== 1 ? 's' : ''}`;
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
      otherWords.forEach(w => {
        const chip = document.createElement('span');
        chip.title        = w.context || '';
        chip.textContent  = w.text;
        chip.style.cssText = 'display:inline-block;padding:4px 10px;border-radius:20px;font-size:13px;font-weight:600;background:var(--brand-soft);color:var(--text-muted);border:1px solid var(--border);';
        chips.appendChild(chip);
      });
      block.appendChild(header);
      block.appendChild(chips);
      el.appendChild(block);
    }
  }

  // ─── Vocab Search ─────────────────────────────────────────────────────────────
  initVocabSearch();

  /**
   * Re-render words filtered + sorted by search term; show "define" prompt if
   * no exact match. Hoisted to top-level (not nested inside initVocabSearch)
   * so the tab-switch handler above can re-apply whatever's currently in the
   * search box when the user navigates back to My Vocabulary — otherwise the
   * search input keeps its text but the list silently reverts to unfiltered.
   * An empty term is a no-op equivalent to the old bare renderWords() call.
   */
  function applySearchFilter(term) {
    const definePrompt = document.getElementById('search-define-prompt');
    const defineLabel  = document.getElementById('search-define-label');
    const searchInput  = document.getElementById('vocab-search-input');

    if (!term) {
      if (definePrompt) definePrompt.style.display = 'none';
      renderWords();
      return;
    }

    const allWords = getWords();
    const tLower   = term.toLowerCase();

    // Sort: exact match first, then starts-with, then contains
    const matched = allWords
      .filter(w => w.text.toLowerCase().includes(tLower))
      .sort((a, b) => {
        const aL = a.text.toLowerCase(), bL = b.text.toLowerCase();
        if (aL === tLower && bL !== tLower) return -1;
        if (bL === tLower && aL !== tLower) return  1;
        if (aL.startsWith(tLower) && !bL.startsWith(tLower)) return -1;
        if (bL.startsWith(tLower) && !aL.startsWith(tLower)) return  1;
        return 0;
      });

    renderWords(matched); // renderWords accepts an optional pre-filtered list

    // Show "Define" prompt if the term isn't an exact match in saved words
    const exactSaved = allWords.some(w => w.text.toLowerCase() === tLower);
    if (!exactSaved) {
      const displayTerm = searchInput ? searchInput.value.trim() : term;
      if (defineLabel) defineLabel.textContent = `"${displayTerm}" is not in your vocabulary yet.`;
      if (definePrompt) definePrompt.style.display = 'flex';
    } else if (definePrompt) {
      definePrompt.style.display = 'none';
    }
  }

  function initVocabSearch() {
    const searchInput   = document.getElementById('vocab-search-input');
    const searchClear   = document.getElementById('vocab-search-clear');
    const definePrompt  = document.getElementById('search-define-prompt');
    const defineBtn     = document.getElementById('search-define-btn');
    const sortBtn       = document.getElementById('vocab-sort-btn');

    let _searchTerm = '';

    // Cycles: default (newest first) → A–Z → Z–A → default. Rebuilds the
    // button's innerHTML with a fresh data-lucide tag each click (rather
    // than mutating the already-rendered <svg> in place) — same pattern
    // used everywhere else in this file (e.g. playBtn, editWordBtn) since
    // lucide's createIcons() only converts unconverted [data-lucide] tags.
    sortBtn.addEventListener('click', () => {
      _vocabSortOrder = _vocabSortOrder === null ? 'asc' : _vocabSortOrder === 'asc' ? 'desc' : null;

      const isActive = _vocabSortOrder !== null;
      sortBtn.style.background  = isActive ? 'var(--brand-soft)' : 'none';
      sortBtn.style.borderColor = isActive ? 'var(--brand-border)' : 'var(--border)';
      sortBtn.style.color       = isActive ? 'var(--brand)' : 'var(--text-muted)';

      const icon  = _vocabSortOrder === 'desc' ? 'arrow-down-a-z' : _vocabSortOrder === 'asc' ? 'arrow-up-a-z' : 'arrow-up-down';
      const label = _vocabSortOrder === 'desc' ? 'Z–A' : 'A–Z';
      sortBtn.innerHTML = `<i data-lucide="${icon}" style="width:13px;height:13px;display:block;stroke-width:2;"></i>` +
        (isActive ? `<span>${label}</span>` : '');
      if (window.lucide) window.lucide.createIcons({ nodes: [sortBtn] });

      // Re-run the current search/filter state (falls back to the plain
      // filtered list when the search box is empty) — renderWords() picks up
      // the new _vocabSortOrder either way.
      applySearchFilter(_searchTerm);
    });

    searchInput.addEventListener('input', () => {
      _searchTerm = searchInput.value.trim().toLowerCase();
      searchClear.style.display = _searchTerm ? 'block' : 'none';
      applySearchFilter(_searchTerm);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') clearSearch();
    });

    searchClear.addEventListener('click', clearSearch);

    function clearSearch() {
      searchInput.value = '';
      _searchTerm = '';
      searchClear.style.display = 'none';
      definePrompt.style.display = 'none';
      renderWords(); // restore full list
    }

    // "Define this word" button → open lookup modal
    defineBtn.addEventListener('click', () => openLookupModal(searchInput.value.trim()));

    // Also allow pressing Enter in the search box to trigger define if term not in vocab
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const term = searchInput.value.trim();
      if (!term) return;
      const allWords   = getWords();
      const exactSaved = allWords.some(w => w.text.toLowerCase() === term.toLowerCase());
      if (!exactSaved) openLookupModal(term);
    });
  }

  // ─── Word Lookup Modal ────────────────────────────────────────────────────────
  (function initLookupModal() {
    const modal      = document.getElementById('word-lookup-modal');
    const closeBtn   = document.getElementById('word-lookup-close');
    const cancelBtn  = document.getElementById('word-lookup-cancel');
    const saveBtn    = document.getElementById('word-lookup-save');
    const loading    = document.getElementById('word-lookup-loading');
    const resultEl   = document.getElementById('word-lookup-result');
    const errorEl    = document.getElementById('word-lookup-error');
    const footer     = document.getElementById('word-lookup-footer');
    const titleEl    = document.getElementById('lookup-modal-title');

    let _pendingWord   = null; // word text being looked up
    let _pendingAnalysis = null; // analysis result

    function closeModal() {
      modal.classList.remove('open');
      modal.style.display = 'none';
      _pendingWord     = null;
      _pendingAnalysis = null;
    }

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Save to vocab
    saveBtn.addEventListener('click', async () => {
      if (!_pendingWord || !_pendingAnalysis) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        // Stored lowercase — see the matching note in popup.js handleSave().
        await saveWord({ text: _pendingWord.toLowerCase(), context: '', aiAnalysis: _pendingAnalysis });
        await loadVocab(); pushWordCache();
        closeModal();

        // Clear search so the new word shows at the very top of the list
        const searchInput = document.getElementById('vocab-search-input');
        const searchClear = document.getElementById('vocab-search-clear');
        const definePrompt = document.getElementById('search-define-prompt');
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.style.display = 'none';
        if (definePrompt) definePrompt.style.display = 'none';

        await renderWords(); // renders full list, newest word at top

        // Scroll the main content area back to top so the new word is visible
        const mainContent = document.querySelector('main') || document.querySelector('.card');
        if (mainContent) mainContent.scrollTop = 0;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5;"></i> Save to My Vocabulary';
        if (window.lucide) window.lucide.createIcons({ nodes: [saveBtn] });
      }
    });

    // Public: open and run analysis
    window._openLookupModal = async function(wordText) {
      _pendingWord     = wordText;
      _pendingAnalysis = null;

      // Reset state
      titleEl.textContent      = `Define: "${wordText}"`;
      loading.style.display    = 'block';
      resultEl.style.display   = 'none';
      errorEl.style.display    = 'none';
      footer.style.display     = 'none';
      saveBtn.style.display    = 'flex'; // restore after being hidden on error
      saveBtn.disabled         = false;
      saveBtn.innerHTML        = '<i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5;"></i> Save to My Vocabulary';
      modal.style.display      = 'flex';
      modal.classList.add('open');

      if (window.lucide) window.lucide.createIcons({ nodes: [modal] });

      try {
        const targetLanguage  = 'Vietnamese'; // fixed: English → Vietnamese
        const analysis        = await apiAnalyzeText(wordText, '', targetLanguage);
        _pendingAnalysis      = analysis;

        // Build result HTML (same structure as popup's definition block)
        resultEl.innerHTML = '';
        const wrap = document.createElement('div');

        // Word header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:4px;';
        const wordTitle = document.createElement('div');
        wordTitle.style.cssText = 'font-size:26px;font-weight:800;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;';
        wordTitle.textContent = wordText;
        const phonetic = document.createElement('div');
        phonetic.style.cssText = 'font-size:12px;color:var(--text-muted);font-family:monospace;';
        phonetic.textContent = analysis.pronunciation || '';
        hdr.appendChild(wordTitle);
        hdr.appendChild(phonetic);
        wrap.appendChild(hdr);

        // AI result card
        const card = document.createElement('div');
        card.className = 'ai-card-bg';
        card.style.cssText = 'padding:14px;margin-top:10px;';

        if (analysis.translation) {
          const tr = document.createElement('div');
          tr.style.cssText = 'font-size:20px;font-weight:700;color:var(--text-main);margin-bottom:6px;';
          tr.textContent = analysis.translation;
          card.appendChild(tr);
        }
        if (analysis.definitionTranslated) {
          const dt = document.createElement('div');
          dt.style.cssText = 'font-size:13px;color:var(--text-muted);line-height:1.5;margin-bottom:8px;';
          dt.textContent = analysis.definitionTranslated;
          card.appendChild(dt);
        }
        if (analysis.definition) {
          const defRow = document.createElement('div');
          defRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding-top:8px;border-top:1px solid var(--border);';
          const enLabel = document.createElement('span');
          enLabel.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-soft);margin-top:3px;flex-shrink:0;';
          enLabel.textContent = 'EN';
          const defText = document.createElement('div');
          defText.style.cssText = 'font-size:12px;color:var(--text-main);line-height:1.5;';
          defText.textContent = analysis.definition;
          defRow.appendChild(enLabel);
          defRow.appendChild(defText);
          card.appendChild(defRow);
        }
        if (analysis.exampleSentence) {
          const ex = document.createElement('div');
          ex.style.cssText = 'margin-top:10px;padding:8px 10px;border-radius:8px;background:linear-gradient(rgba(6,182,212,0.10),rgba(6,182,212,0.10)), var(--muted-bg);font-size:12px;color:var(--text-muted);font-style:italic;line-height:1.5;';
          ex.textContent = `"${analysis.exampleSentence}"`;
          card.appendChild(ex);
        }

        wrap.appendChild(card);

        // Tags
        if (analysis.tags?.length) {
          const tagWrap = document.createElement('div');
          tagWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-top:10px;';
          analysis.tags.forEach(tag => {
            const sp = document.createElement('span');
            sp.className   = 'tag';
            sp.textContent = tag;
            tagWrap.appendChild(sp);
          });
          wrap.appendChild(tagWrap);
        }

        resultEl.appendChild(wrap);
        loading.style.display    = 'none';
        resultEl.style.display   = 'block';
        footer.style.display     = 'flex';
        // Scroll modal card to top so result is immediately visible
        document.getElementById('word-lookup-card')?.scrollTo({ top: 0, behavior: 'smooth' });

        // Re-label save button
        saveBtn.style.display = 'flex';
        const alreadySaved = getWords().some(w => w.text.toLowerCase() === wordText.toLowerCase());
        if (alreadySaved) {
          saveBtn.innerHTML   = '✓ Already in your vocabulary';
          saveBtn.disabled    = true;
        } else {
          saveBtn.innerHTML   = '<i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5;"></i> Save to My Vocabulary';
          saveBtn.disabled    = false;
          if (window.lucide) window.lucide.createIcons({ nodes: [saveBtn] });
        }

      } catch (err) {
        loading.style.display = 'none';
        errorEl.innerHTML     = '';
        errorEl.style.display = 'block';
        footer.style.display  = 'flex';
        saveBtn.style.display = 'none';

        // Show base error message
        const errMsg = document.createElement('div');
        errMsg.style.cssText = 'font-size:13px;color:var(--danger);margin-bottom:10px;';
        errMsg.textContent   = `"${wordText}" couldn't be analysed — it may be misspelled or incomplete.`;
        errorEl.appendChild(errMsg);

        // Fetch spelling suggestions from Datamuse (free, no key)
        // md=f requests word frequency so we can filter out rare/non-English words.
        // Datamuse tags frequency as "f:X.XX" (log10 per million); common English words
        // score roughly f > 1. We require score ≥ 1 and skip the original input itself.
        try {
          const res = await fetch(
            `https://api.datamuse.com/words?sp=${encodeURIComponent(wordText)}&max=15&md=f`
          );
          const raw = await res.json(); // [{ word, score, tags: ["f:3.45"] }, ...]

          // Parse frequency tag and keep only common English words
          const MIN_FREQ = 1.0; // log10 per million — filters rare/Latin/foreign words
          const suggestions = raw.filter(({ word, tags }) => {
            if (word.toLowerCase() === wordText.toLowerCase()) return false; // skip self
            const freqTag = (tags || []).find(t => t.startsWith('f:'));
            const freq = freqTag ? parseFloat(freqTag.slice(2)) : 0;
            return freq >= MIN_FREQ;
          }).slice(0, 5);

          if (suggestions.length > 0) {
            const hint = document.createElement('div');
            hint.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:6px;';
            hint.textContent   = 'Did you mean:';
            errorEl.appendChild(hint);

            const pills = document.createElement('div');
            pills.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';

            suggestions.forEach(({ word }) => {
              const btn = document.createElement('button');
              btn.textContent  = word;
              btn.style.cssText = 'padding:5px 12px;border-radius:8px;border:1px solid var(--brand);background:var(--brand-soft);color:var(--brand);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.15s;';
              btn.onmouseenter = () => { btn.style.background = 'var(--brand)'; btn.style.color = '#fff'; };
              btn.onmouseleave = () => { btn.style.background = 'var(--brand-soft)'; btn.style.color = 'var(--brand)'; };
              btn.addEventListener('click', () => {
                // Retry lookup with the corrected word
                window._openLookupModal(word);
                // Also update the search input so it reflects the correction
                const si = document.getElementById('vocab-search-input');
                if (si) { si.value = word; si.dispatchEvent(new Event('input')); }
              });
              pills.appendChild(btn);
            });

            errorEl.appendChild(pills);
          } else {
            // No suggestions — just show a generic check-spelling note
            const noHint = document.createElement('div');
            noHint.style.cssText = 'font-size:12px;color:var(--text-muted);';
            noHint.textContent   = 'No spelling suggestions found. Please check the word and try again.';
            errorEl.appendChild(noHint);
          }
        } catch (_) {
          // Datamuse unreachable — fall back to plain message
          const noHint = document.createElement('div');
          noHint.style.cssText = 'font-size:12px;color:var(--text-muted);';
          noHint.textContent   = 'Please check the spelling and try again.';
          errorEl.appendChild(noHint);
        }
      }
    };
  })();

  function openLookupModal(word) {
    if (window._openLookupModal) window._openLookupModal(word);
  }

  // ─── Account Section ──────────────────────────────────────────────────────────
  await initAccountSection();

  // Re-sync vocab from cloud whenever the window regains focus.
  // This catches words saved via the hotkey popup while the dashboard was in the background.
  let _focusSyncTimer = null;
  window.addEventListener('focus', () => {
    clearTimeout(_focusSyncTimer);
    _focusSyncTimer = setTimeout(async () => {
      const token = getToken();
      if (!token) return;
      await loadVocab(); pushWordCache();
      // Re-render whichever tab is currently visible
      const activeView = document.querySelector('.view-section.active');
      if (activeView?.id === 'list-view') await renderWords();
      updateSyncStatus('Last synced: just now');
    }, 300); // small debounce so rapid focus/blur doesn't spam API
  });

  async function initAccountSection() {
    const token = getToken();
    if (token) {
      // Share token with main process on startup so hotkey popup works immediately
      if (window.electronAPI?.setToken) window.electronAPI.setToken(token);
      await showLoggedInState(token);
    } else {
      showLoggedOutState();
    }

    document.getElementById('acct-send-code').addEventListener('click', handleSendCode);
    document.getElementById('acct-email').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendCode();
    });

    document.getElementById('acct-verify-code').addEventListener('click', handleVerifyCode);
    document.getElementById('acct-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleVerifyCode();
    });

    document.getElementById('acct-resend').addEventListener('click', handleSendCode);

    document.getElementById('acct-sync-now').addEventListener('click', async () => {
      updateSyncStatus('Syncing…');
      await loadVocab(); pushWordCache();
      await renderWords();
      updateSyncStatus('Last synced: just now');
    });

    // ── Export / Import vocabulary ─────────────────────────────────────────
    const dataStatus = document.getElementById('acct-data-status');
    let _dataStatusTimer = null;
    function showDataStatus(msg, isError = false) {
      dataStatus.textContent = msg;
      dataStatus.style.color = isError ? 'var(--danger)' : 'var(--success)';
      dataStatus.style.display = 'block';
      clearTimeout(_dataStatusTimer);
      _dataStatusTimer = setTimeout(() => { dataStatus.style.display = 'none'; }, 6000);
    }

    document.getElementById('acct-export-btn').addEventListener('click', () => {
      const words = getWords();
      if (!words.length) { showDataStatus('No vocabulary to export yet.', true); return; }
      const payload = {
        app: 'semantica',
        version: 1,
        exportedAt: new Date().toISOString(),
        wordCount: words.length,
        words,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `semantica-vocab-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showDataStatus(`Exported ${words.length} words.`);
    });

    const importFile = document.getElementById('acct-import-file');
    document.getElementById('acct-import-btn').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0];
      importFile.value = ''; // allow re-selecting the same file later
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        // Accept both the export envelope { app, version, words } and a raw array
        const rawWords = Array.isArray(parsed) ? parsed : parsed?.words;
        if (!Array.isArray(rawWords)) throw new Error('Not a Semantica vocabulary file.');

        // Sanitize each record. AI analysis is kept (no re-analysis needed);
        // learning progress is RESET — a shared list's mastery isn't yours.
        const records = rawWords
          .filter(w => typeof w?.text === 'string' && w.text.trim())
          .map(w => ({
            text: w.text.trim(),
            context: typeof w.context === 'string' ? w.context : '',
            url: '',
            title: '',
            timestamp: Date.now(),
            videoId: '',
            videoTime: 0,
            aiAnalysis: (w.aiAnalysis && typeof w.aiAnalysis === 'object') ? w.aiAnalysis : null,
            learningState: 'new',
            stats: { seen: 0, correct: 0, skipped: 0, consecutiveCorrect: 0 },
          }));
        if (!records.length) throw new Error('No valid words found in the file.');

        const { added, skipped } = await apiImportWords(records);
        pushWordCache();
        await renderWords();
        showDataStatus(`Imported ${added} new word${added === 1 ? '' : 's'}${skipped ? ` — ${skipped} already in your list` : ''}.`);
      } catch (err) {
        showDataStatus(err.message || 'Import failed — invalid file.', true);
      }
    });

    document.getElementById('acct-logout').addEventListener('click', handleLogout);

    document.getElementById('premium-btn-monthly').addEventListener('click', () => startPremiumCheckout('monthly'));
    document.getElementById('premium-btn-annual').addEventListener('click', () => startPremiumCheckout('annual'));
    document.getElementById('premium-checkout-cancel').addEventListener('click', cancelPremiumCheckout);
  }

  async function handleSendCode() {
    const emailInput = document.getElementById('acct-email');
    const errEl      = document.getElementById('acct-send-error');
    const btn        = document.getElementById('acct-send-code');
    const email      = emailInput.value.trim();

    if (!email) { showError(errEl, 'Please enter your email address.'); return; }
    errEl.style.display = 'none';
    btn.disabled        = true;
    btn.textContent     = 'Sending…';

    try {
      await apiRequestCode(email);
      document.getElementById('acct-email-display').textContent = email;
      document.getElementById('acct-logged-out').style.display  = 'none';
      document.getElementById('acct-code-sent').style.display   = 'block';
      document.getElementById('acct-code').focus();
    } catch (err) {
      showError(errEl, err.message || 'Network error — check your connection.');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Send Code';
    }
  }

  async function handleVerifyCode() {
    const email  = document.getElementById('acct-email').value.trim();
    const code   = document.getElementById('acct-code').value.trim();
    const errEl  = document.getElementById('acct-verify-error');
    const btn    = document.getElementById('acct-verify-code');

    if (!code) { showError(errEl, 'Please enter the code from your email.'); return; }
    errEl.style.display = 'none';
    btn.disabled        = true;
    btn.textContent     = 'Verifying…';

    try {
      const data = await apiVerifyCode(email, code);
      setAuthSession(data.token, email);

      // Share token with main process so the hotkey popup can use it
      if (window.electronAPI?.setToken) window.electronAPI.setToken(data.token);

      // Auto-switch provider to cloud
      const settings = getSettings();
      await saveSettings({ ...settings, provider: 'cloud' });
      aiProviderSelect.value = 'cloud';
      toggleProviderNote('cloud');

      await showLoggedInState(data.token);
    } catch (err) {
      showError(errEl, err.message || 'Network error — check your connection.');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Verify & Sign In';
    }
  }

  async function handleLogout() {
    clearAuthSession();
    if (window.electronAPI?.setToken) window.electronAPI.setToken(null);
    // Clear the main-process word cache so the global search bar cannot
    // expose the previous user's vocabulary after logout
    if (window.electronAPI?.sendWordCache) window.electronAPI.sendWordCache([]);
    const settings = getSettings();
    await saveSettings({ ...settings, provider: 'freedict' });
    aiProviderSelect.value = 'freedict';
    toggleProviderNote('freedict');
    showLoggedOutState();
    // Reset login page form
    document.getElementById('lp-step-email').style.display = 'block';
    document.getElementById('lp-step-code').style.display  = 'none';
    document.getElementById('lp-email').value = '';
    document.getElementById('lp-code').value  = '';
    showLoginPage();
  }

  async function showLoggedInState(token) {
    document.getElementById('acct-logged-out').style.display  = 'none';
    document.getElementById('acct-code-sent').style.display   = 'none';
    document.getElementById('acct-logged-in').style.display   = 'block';

    const email = getEmail() ||
                  document.getElementById('acct-email').value ||
                  document.getElementById('acct-email-display').textContent || '';
    if (email) {
      document.getElementById('acct-avatar').textContent     = email[0].toUpperCase();
      document.getElementById('acct-email-logged').textContent = email;
    }

    document.getElementById('acct-status-badge').innerHTML =
      '<span style="color:var(--success);font-weight:600;">✓ Cloud AI active</span>';

    updateSyncStatus('Syncing…');
    try {
      await loadVocab(); pushWordCache();
      await renderWords();
      updateSyncStatus('Last synced: just now');
    } catch {
      updateSyncStatus('Offline — using local data');
    }

    refreshPremiumState();
  }

  function showLoggedOutState() {
    document.getElementById('acct-logged-out').style.display  = 'block';
    document.getElementById('acct-code-sent').style.display   = 'none';
    document.getElementById('acct-logged-in').style.display   = 'none';
    document.getElementById('acct-code').value                = '';
    document.getElementById('acct-send-error').style.display  = 'none';
    document.getElementById('acct-verify-error').style.display = 'none';

    document.getElementById('premium-card').style.display = 'none';
    stopPremiumPolling();
  }

  // ─── Premium (SePay checkout) ─────────────────────────────────────────────
  let _premiumPollTimer = null;

  async function refreshPremiumState() {
    const card = document.getElementById('premium-card');
    if (!card) return;
    try {
      const { isPro, planExpiresAt } = await apiGetBillingStatus();
      document.getElementById('premium-checkout-state').style.display = 'none';
      if (isPro) {
        document.getElementById('premium-free-state').style.display   = 'none';
        document.getElementById('premium-active-state').style.display = 'block';
        const expiry = new Date(planExpiresAt * 1000);
        document.getElementById('premium-expiry').textContent =
          `Active until ${expiry.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
      } else {
        document.getElementById('premium-active-state').style.display = 'none';
        document.getElementById('premium-free-state').style.display   = 'block';
      }
      card.style.display = 'block';
    } catch (err) {
      // Backend not reachable — don't show a half-broken billing card
      console.error('Semantica: failed to load billing status', err);
      card.style.display = 'none';
    }
  }

  async function startPremiumCheckout(plan) {
    const errEl = document.getElementById('premium-checkout-error');
    errEl.style.display = 'none';
    try {
      const order = await apiCreateCheckout(plan);
      document.getElementById('premium-free-state').style.display     = 'none';
      document.getElementById('premium-checkout-state').style.display = 'block';
      document.getElementById('premium-qr-img').src = order.qrUrl;
      document.getElementById('premium-order-id').textContent = order.transferContent;
      document.getElementById('premium-checkout-status-text').textContent = 'Waiting for payment…';
      pollPremiumOrder(order.orderId);
    } catch (err) {
      errEl.textContent   = err.message || 'Could not start checkout.';
      errEl.style.display = 'block';
    }
  }

  function pollPremiumOrder(orderId) {
    stopPremiumPolling();
    const startedAt = Date.now();
    const POLL_INTERVAL_MS = 3000;
    const GIVE_UP_AFTER_MS = 10 * 60 * 1000; // matches the QR's practical usable window

    _premiumPollTimer = setInterval(async () => {
      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        stopPremiumPolling();
        const statusText = document.getElementById('premium-checkout-status-text');
        if (statusText) statusText.textContent = 'No payment detected yet — you can try again.';
        return;
      }
      try {
        const order = await apiGetOrder(orderId);
        if (order.status === 'paid') {
          stopPremiumPolling();
          await refreshPremiumState();
        }
      } catch {
        // transient network hiccup — keep polling, next tick will retry
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPremiumPolling() {
    if (_premiumPollTimer) {
      clearInterval(_premiumPollTimer);
      _premiumPollTimer = null;
    }
  }

  function cancelPremiumCheckout() {
    stopPremiumPolling();
    document.getElementById('premium-checkout-state').style.display = 'none';
    document.getElementById('premium-free-state').style.display     = 'block';
  }

  function updateSyncStatus(text) {
    const el = document.getElementById('acct-sync-status');
    if (el) el.textContent = text;
  }

  function showError(el, message) {
    el.textContent    = message;
    el.style.display  = 'block';
  }

  // ─── SRS (Spaced Repetition) helpers ─────────────────────────────────────────
  // Backed by ts-fsrs (vendored in fsrs-vendor.js — see that file's header for
  // why it's vendored rather than CDN-imported). This replaced a hand-rolled
  // SM-2-lite scheduler (fixed ease-factor multipliers) with the real FSRS
  // algorithm, which models each word's individual memory stability/difficulty
  // instead of one ease factor nudged by +/-0.1-0.2 per review.
  //
  // Deliberately scoped to Review Mode only — Game tab modes (Race/Survival/
  // Mission) keep using game-engine.js's separate learningState bucket
  // heuristic and never touch word.srs. Playing a game is "extra practice";
  // Review Mode remains the sole source of truth for spaced-repetition due
  // dates, exactly as before this change.
  const fsrsScheduler = fsrs();

  // hasFsrsCard now lives in fsrs-filters.js (imported at top) — shared with
  // the Game tab's word-pool filter alongside FSRS_FILTERS itself.

  /** Rebuild an ts-fsrs Card object from a word's persisted (plain-JSON) srs fields. */
  function toFsrsCard(word) {
    if (!hasFsrsCard(word)) return createEmptyCard(new Date());
    const s = word.srs;
    return {
      due: new Date(s.dueDate),
      stability: s.stability,
      difficulty: s.difficulty,
      elapsed_days: s.elapsedDays ?? 0,
      scheduled_days: s.scheduledDays ?? 0,
      reps: s.reviewCount ?? 0,
      lapses: s.lapses ?? 0,
      learning_steps: s.learningSteps ?? 0,
      state: s.fsrsState ?? FsrsState.New,
      last_review: s.lastReviewed ? new Date(s.lastReviewed) : void 0,
    };
  }

  /**
   * Update SRS fields after a review.
   * @param {Object} word
   * @param {number} rating - ts-fsrs Rating enum value (Rating.Again=1, Hard=2, Good=3, Easy=4)
   */
  function srsUpdate(word, rating) {
    const now = new Date();
    const card = toFsrsCard(word);
    const { card: next } = fsrsScheduler.next(card, now, rating);
    return {
      dueDate: next.due.getTime(),
      stability: next.stability,
      difficulty: next.difficulty,
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
      reviewCount: next.reps,
      lapses: next.lapses,
      learningSteps: next.learning_steps,
      fsrsState: next.state,
      lastReviewed: next.last_review ? next.last_review.getTime() : now.getTime(),
      // Persisted so the "Struggling"/"Mastered" FSRS filters can look at what
      // the user actually pressed last, not just derive it from stability/state.
      lastRating: rating,
    };
  }

  /** Returns 'due' | 'soon' | 'future' | 'new' */
  function srsStatus(word) {
    if (!word.srs?.dueDate) return 'new';
    const diff = word.srs.dueDate - Date.now();
    if (diff <= 0) return 'due';
    if (diff < 86400000) return 'soon';   // within 24h
    return 'future';
  }

  /** Human-readable due label + colour for chip */
  function formatDue(srs) {
    if (!srs?.dueDate) return { label: 'New', color: '#94a3b8' };
    const diff = srs.dueDate - Date.now();
    if (diff <= 0) return { label: 'Due now', color: '#ef4444' };
    const days = Math.round(diff / 86400000);
    if (days < 1) return { label: 'Due today', color: '#f59e0b' };
    if (days === 1) return { label: 'Tomorrow', color: '#f59e0b' };
    return { label: `In ${days} days`, color: '#22c55e' };
  }

  // ─── FSRS study filters ─────────────────────────────────────────────────────
  // FSRS_FILTERS / getFsrsFilter / renderFsrsFilterPills now live in
  // fsrs-filters.js (imported at top) — shared by the Review, Practice, AND
  // Game tabs so the filter definitions can never drift apart.

  // ─── Review Mode ─────────────────────────────────────────────────────────────
  let reviewQueue        = [];
  let currentReviewIndex = 0;
  let retryCount         = new Map();
  const reviewContainer  = document.getElementById('review-container');
  const noReviewState    = document.getElementById('no-review');

  let _reviewAllWords = [];
  let _activeReviewFilter = 'due'; // "Due Today" is the spec'd default

  async function startReviewSession(prefiltered = null) {
    _reviewAllWords = prefiltered ?? await getWords();
    _activeReviewFilter = 'due';
    _renderSrsStrip();
    _applyReviewFilter();
  }

  /** Rebuild + start the review queue from _reviewAllWords using the active FSRS filter. */
  function _applyReviewFilter() {
    const order = { due: 0, soon: 1, new: 2, future: 3 };
    const filtered = _reviewAllWords.filter(getFsrsFilter(_activeReviewFilter).predicate);
    // Within whatever the filter selected, still surface the most overdue
    // words first — same ordering the old "sorted"/"due" modes both used.
    reviewQueue = [...filtered].sort((a, b) => (order[srsStatus(a)] ?? 2) - (order[srsStatus(b)] ?? 2));
    currentReviewIndex = 0;
    retryCount         = new Map();
    showNextCard();
  }

  /** Render the SRS summary strip + FSRS filter pills above the review cards */
  function _renderSrsStrip() {
    const strip = document.getElementById('srs-strip');
    if (!strip) return;
    const c = { due: 0, soon: 0, future: 0, new: 0 };
    _reviewAllWords.forEach(w => c[srsStatus(w)]++);
    const isDark = document.documentElement.classList.contains('dark');
    const bg     = isDark ? 'rgba(30,41,59,0.90)' : 'rgba(255,255,255,0.92)';
    strip.innerHTML = `
      <div class="srs-strip-inner" style="background:${bg};">
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;font-weight:600;">
          <span style="color:#ef4444;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block;"></span>Overdue: ${c.due}</span>
          <span style="color:#f59e0b;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>Due today: ${c.soon}</span>
          <span style="color:#22c55e;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;"></span>Upcoming: ${c.future}</span>
          <span style="color:#94a3b8;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#94a3b8;display:inline-block;"></span>New: ${c.new}</span>
        </div>
        <div id="srs-filter-pills" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      </div>`;
    renderFsrsFilterPills('srs-filter-pills', _reviewAllWords, _activeReviewFilter, (id) => {
      _activeReviewFilter = id;
      _renderSrsStrip();
      _applyReviewFilter();
    });
  }

  function showNextCard() {
    reviewContainer.innerHTML = '';

    if (currentReviewIndex >= reviewQueue.length) {
      reviewContainer.appendChild(noReviewState);
      noReviewState.innerHTML = '<h2>Session Complete!</h2><p>Great job reviewing your vocabulary.</p><button class="btn-primary" id="restart-review">Restart</button>';
      document.getElementById('restart-review').onclick = () => startReviewSession();
      return;
    }

    const word     = reviewQueue[currentReviewIndex];
    const analysis = word.aiAnalysis || {};
    const total    = reviewQueue.length;
    const progress = Math.round((currentReviewIndex / total) * 100);

    // Progress bar
    const progressWrap = document.createElement('div');
    progressWrap.style.cssText = 'width:100%;background:rgba(0,0,0,0.07);border-radius:999px;height:4px;margin-bottom:20px;overflow:hidden;';
    const progressBar = document.createElement('div');
    progressBar.style.cssText = `height:4px;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--brand-2));width:${progress}%;transition:width 0.4s ease;`;
    progressWrap.appendChild(progressBar);
    reviewContainer.appendChild(progressWrap);

    // 3D flip card wrapper
    const perspective = document.createElement('div');
    perspective.className = 'perspective-card flashcard';

    const inner = document.createElement('div');
    inner.className = 'flip-card-inner';
    inner.style.cssText = 'width:100%;min-height:220px;';

    // ── Front face ──
    const front = document.createElement('div');
    front.className = 'flip-card-face flashcard-content';
    front.style.minHeight = '280px';
    front.innerHTML = `
      <div style="position:absolute;top:14px;right:16px;font-size:11px;color:var(--text-soft);">tap to reveal</div>
      <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-soft);margin-bottom:12px;">What does this mean?</p>
      <div class="fc-word">${escapeHtml(word.text)}</div>
      <div class="fc-phonetic">${escapeHtml(analysis.pronunciation || '')}</div>
    `;
    front.style.position = 'relative';

    // ── Back face ──
    const back = document.createElement('div');
    back.className = 'flip-card-face flip-card-back flashcard-content';
    back.style.minHeight = '280px';
    back.style.justifyContent = 'flex-start';
    back.style.textAlign = 'center';

    // SRS status chip for card back
    const { label: srsLabel, color: srsColor } = formatDue(word.srs);
    const srsReviews  = word.srs?.reviewCount ?? 0;
    const srsChipHtml = `<div style="padding-top:10px;margin-top:8px;border-top:1px solid var(--border);text-align:center;">
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;background:${srsColor}18;color:${srsColor};border:1px solid ${srsColor}33;">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l-2 4"/></svg>
        ${escapeHtml(srsLabel)}${srsReviews > 0 ? ` · reviewed ${srsReviews}×` : ' · never reviewed'}
      </span></div>`;

    back.innerHTML = `
      <div class="fc-word" style="font-size:28px;margin-bottom:4px;">${escapeHtml(word.text)}</div>
      <div class="fc-phonetic">${escapeHtml(analysis.pronunciation || '')}</div>
      <div id="fc-speaker-slot" style="display:flex;justify-content:center;margin-top:6px;"></div>
      <div style="width:100%;border-top:1px solid var(--border);padding-top:14px;margin-top:10px;space-y:8px;">
        ${analysis.translation ? `<div class="fc-translation">${escapeHtml(analysis.translation)}</div>` : ''}
        ${analysis.definitionTranslated ? `<div class="fc-def-native" style="text-align:left;">${escapeHtml(analysis.definitionTranslated)}</div>` : ''}
        ${analysis.definition ? `<div style="display:flex;align-items:flex-start;gap:6px;margin-top:8px;text-align:left;"><span class="fc-def-en-label" style="margin-top:2px;">EN</span><span class="fc-def-en">${escapeHtml(analysis.definition)}</span></div>` : (!analysis.definitionTranslated ? '<div style="color:var(--text-muted);font-size:13px;">No definition available.</div>' : '')}
        ${analysis.exampleSentence ? `<div class="fc-example-block" style="text-align:left;margin-top:10px;">
          <div class="fc-example">"${escapeHtml(analysis.exampleSentence)}"</div>
          ${analysis.exampleSentenceTranslated ? `<div class="fc-example-trans">"${escapeHtml(analysis.exampleSentenceTranslated)}"</div>` : ''}
        </div>` : ''}
        ${srsChipHtml}
      </div>
    `;

    // Replay speaker — built as a real element (not innerHTML) so it can carry
    // a click handler, same convention as the vocab-list play button. Audio
    // already auto-plays once when the card flips (see the perspective click
    // listener below); this lets the user hear the word again on demand.
    const speakerBtn = createSpeakerButton(word.text, analysis.audioBase64, 'Play again');
    back.querySelector('#fc-speaker-slot').appendChild(speakerBtn);

    inner.appendChild(front);
    inner.appendChild(back);
    perspective.appendChild(inner);
    reviewContainer.appendChild(perspective);

    // Controls (revealed after flip)
    const controls = document.createElement('div');
    controls.className = 'review-controls';
    controls.style.opacity = '0';
    controls.style.pointerEvents = 'none';
    controls.style.transition = 'opacity 0.3s ease 0.25s';
    // Standard FSRS 4-point grading scale (Again/Hard/Good/Easy), mapped
    // directly to the ts-fsrs Rating enum so no scheduling precision is left
    // on the table — a 3-button Hard/Good/Easy scale can't distinguish
    // "forgot completely" from "remembered with real difficulty", which are
    // very different signals for FSRS's stability/difficulty model.
    controls.innerHTML = `
      <button class="review-btn btn-again" style="flex:1;padding:11px 6px;border-radius:14px;border:none;font-weight:700;font-size:12px;cursor:pointer;background:linear-gradient(135deg,#ef4444,#f43f5e);color:#fff;box-shadow:0 4px 12px rgba(239,68,68,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:5px;font-family:inherit;">✕ Again</button>
      <button class="review-btn btn-hard" style="flex:1;padding:11px 6px;border-radius:14px;border:none;font-weight:700;font-size:12px;cursor:pointer;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;box-shadow:0 4px 12px rgba(245,158,11,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:5px;font-family:inherit;">− Hard</button>
      <button class="review-btn btn-good" style="flex:1;padding:11px 6px;border-radius:14px;border:none;font-weight:700;font-size:12px;cursor:pointer;background:linear-gradient(135deg,#10b981,#22c55e);color:#fff;box-shadow:0 4px 12px rgba(16,185,129,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:5px;font-family:inherit;">✓ Good</button>
      <button class="review-btn btn-easy" style="flex:1;padding:11px 6px;border-radius:14px;border:none;font-weight:700;font-size:12px;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 4px 12px rgba(99,102,241,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:5px;font-family:inherit;">✦ Easy</button>
    `;
    reviewContainer.appendChild(controls);

    // Flip on card click
    let flipped = false;
    perspective.addEventListener('click', () => {
      if (flipped) return;
      flipped = true;
      inner.classList.add('flipped');
      controls.style.opacity = '1';
      controls.style.pointerEvents = 'auto';
      speakText(word.text, word.aiAnalysis?.audioBase64);
    });

    const btnAgain = controls.querySelector('.btn-again');
    const btnHard  = controls.querySelector('.btn-hard');
    const btnGood  = controls.querySelector('.btn-good');
    const btnEasy  = controls.querySelector('.btn-easy');

    // Again — forgot completely; full relearn, same as the old 3-button "Hard".
    btnAgain.onclick = async (e) => {
      e.stopPropagation();
      const count = (retryCount.get(word.text) || 0) + 1;
      retryCount.set(word.text, count);
      if (count <= 2) reviewQueue.push(word);
      await updateWord(word.text, { learningState: 'relearn', srs: srsUpdate(word, Rating.Again) });
      currentReviewIndex++;
      showNextCard();
    };

    // Hard — remembered, but with real difficulty. Reuses the existing
    // hintUsed=true branch in nextLearningState (game-engine.js is untouched;
    // this just calls it with different result flags), which lands on
    // 'learning' rather than fully resetting to 'relearn'.
    btnHard.onclick = async (e) => {
      e.stopPropagation();
      const newState = nextLearningState(word, { correct: true, hintUsed: true, skipped: false });
      await updateWord(word.text, { learningState: newState, srs: srsUpdate(word, Rating.Hard) });
      currentReviewIndex++;
      showNextCard();
    };

    btnGood.onclick = async (e) => {
      e.stopPropagation();
      const newState = nextLearningState(word, { correct: true, hintUsed: false, skipped: false });
      await updateWord(word.text, { learningState: newState, srs: srsUpdate(word, Rating.Good) });
      currentReviewIndex++;
      showNextCard();
    };

    // Easy/Mastered — schedules word for distant future review via SRS
    btnEasy.onclick = async (e) => {
      e.stopPropagation();
      retryCount.delete(word.text);
      await updateWord(word.text, { learningState: 'known', srs: srsUpdate(word, Rating.Easy) });
      currentReviewIndex++;
      showNextCard();
    };

    // Visual press feedback for all buttons
    [btnAgain, btnHard, btnGood, btnEasy].forEach(btn => {
      btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.96)'; btn.style.boxShadow = 'none'; });
      btn.addEventListener('mouseup',   () => { btn.style.transform = ''; btn.style.boxShadow = ''; });
      btn.addEventListener('mouseleave',() => { btn.style.transform = ''; btn.style.boxShadow = ''; });
    });
  }

  // ─── Review Mode: keyboard grading (1=Again, 2=Hard, 3=Good, 4=Easy) ────────
  // A single module-level listener rather than binding per-button: the 4
  // grading buttons are recreated from scratch on every showNextCard() call
  // (reviewContainer.innerHTML is cleared each render), so anything bound
  // directly to a button instance would go stale the moment the next card
  // renders. Querying .review-controls fresh on every keypress always finds
  // whichever card is currently showing.
  //
  // Guarded on: the Review tab being the active top-level view (so pressing
  // 1-4 elsewhere in the app — e.g. typing a word containing a digit — is
  // never intercepted), no text input/textarea currently focused (defensive,
  // since Review's card itself has no text inputs), and the card actually
  // being flipped (.review-controls only becomes interactive — pointer-
  // events:auto — after the flip; before that, 1-4 should do nothing, same
  // as clicking the invisible buttons would do nothing).
  document.addEventListener('keydown', (e) => {
    if (!['1', '2', '3', '4'].includes(e.key)) return;
    if (!document.getElementById('review-view')?.classList.contains('active')) return;
    const activeTag = document.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

    const controls = reviewContainer.querySelector('.review-controls');
    if (!controls || controls.style.pointerEvents !== 'auto') return;

    const selector = { '1': '.btn-again', '2': '.btn-hard', '3': '.btn-good', '4': '.btn-easy' }[e.key];
    controls.querySelector(selector)?.click();
  });

  // ─── Practice: mode selection ────────────────────────────────────────────────
  // Two independent modes share the #practice-container render target, switched
  // between via a mode-picker screen (mirrors the Game tab's Choose-a-Mode
  // pattern) — see practice-screen-modes/practice-screen-session in index.html.

  const practiceModesScreen  = document.getElementById('practice-screen-modes');
  const practiceSessionScreen = document.getElementById('practice-screen-session');

  function showPracticeModeSelect() {
    practiceSessionScreen.classList.remove('active');
    practiceModesScreen.classList.add('active');
  }

  function showPracticeSession() {
    practiceModesScreen.classList.remove('active');
    practiceSessionScreen.classList.add('active');
  }

  document.querySelectorAll('#practice-screen-modes .mode-card').forEach(card => {
    card.addEventListener('click', () => {
      showPracticeSession();
      if (card.dataset.practiceMode === 'listen-write') renderListenWrite();
      else renderPractice();
    });
  });

  // ─── Practice: shared FSRS filter strip (both Read-and-Write and Listen-and-
  // Write draw from the same filtered word list — see FSRS_FILTERS above,
  // the same 5 filters/predicates the Review tab uses) ─────────────────────
  let _activePracticeMode   = 'read-write'; // 'read-write' | 'listen-write'
  let _activePracticeFilter = 'all';
  let _practiceAllWords     = [];
  // Bumped on every renderPractice()/renderListenWrite() call so a stale
  // getWords() resolution (double-clicked mode card, rapid "Practice Again")
  // can detect it's no longer the latest entry and bail instead of clobbering
  // a newer render.
  let _practiceEntryToken   = 0;

  /** Rebuild + start whichever practice mode is active, from _practiceAllWords filtered by the active FSRS filter. */
  function _applyPracticeFilter() {
    const filtered = _practiceAllWords.filter(getFsrsFilter(_activePracticeFilter).predicate);
    if (_activePracticeMode === 'listen-write') _buildListenQueue(filtered);
    else _buildFitbQueue(filtered);
  }

  function _renderPracticeFilterStrip() {
    const strip = document.getElementById('practice-filter-strip');
    if (!strip) return;
    const isDark = document.documentElement.classList.contains('dark');
    const bg     = isDark ? 'rgba(30,41,59,0.90)' : 'rgba(255,255,255,0.92)';
    strip.innerHTML = `
      <div class="srs-strip-inner" style="background:${bg};justify-content:flex-end;">
        <div id="practice-filter-pills" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      </div>`;
    renderFsrsFilterPills('practice-filter-pills', _practiceAllWords, _activePracticeFilter, (id) => {
      _activePracticeFilter = id;
      _renderPracticeFilterStrip();
      _applyPracticeFilter();
    });
  }

  // ─── Practice: shared render shell for both Read-and-Write and Listen-and-
  // Write ─────────────────────────────────────────────────────────────────
  // Both modes render a near-identical card (progress bar, counter, first-
  // letter hint, answer input, feedback line, reveal block, Check/Skip/
  // Hint/Next buttons, Enter-to-submit, and the same session-complete
  // summary) around a small mode-specific body (FITB's blanked sentence +
  // toggle button vs Listen's speaker button) and a mode-specific notion of
  // "the expected answer" (FITB's sentence-form-aware target word vs
  // Listen's bare word.text). _showNextPracticeCard() below is that shared
  // shell; _fitbState/_listenState hold each mode's own queue/index/score
  // arrays (kept separate so switching modes mid-session never cross-
  // contaminates either mode's score).
  function _shuffle(arr) {
    const result = arr.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  const practiceContainer = document.getElementById('practice-container');

  // ─── Practice: Read and Write (fill-in-the-blank) ────────────────────────────

  const _fitbState = { queue: [], index: 0, correct: [], wrong: [] };

  // Entry point from the mode-select screen / "Practice Again" — refetches
  // the word list and resets to "All Words" (unlike Review, Practice has no
  // scheduling, so defaulting to "Due Today" would leave new/never-reviewed
  // words unpracticeable — the filter pills still let the user narrow down
  // manually from here).
  async function renderPractice() {
    _activePracticeMode = 'read-write';
    const token = ++_practiceEntryToken;
    const words = await getWords();
    if (token !== _practiceEntryToken) return; // superseded by a newer entry
    _practiceAllWords = words;
    _activePracticeFilter = 'all';
    _renderPracticeFilterStrip();
    _applyPracticeFilter();
  }

  /** Build the fill-in-the-blank queue from a (already FSRS-filtered) word list and start it. */
  function _buildFitbQueue(words) {
    // Keep words with at least one usable sentence
    _fitbState.queue = _shuffle(words.filter(w =>
      (w.aiAnalysis?.exampleSentence?.length > 10) || (w.context?.length > 10)
    ));
    _fitbState.index   = 0;
    _fitbState.correct = [];
    _fitbState.wrong   = [];
    _showNextPracticeCard(_fitbState, FITB_CONFIG);
  }

  /** Replace the target word in a sentence with a blank. Returns null if word not found. */
  function _blankSentence(sentence, wordText) {
    const escaped = wordText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\w*\\b`, 'gi');
    const blanked = sentence.replace(pattern, '_______');
    return blanked === sentence ? null : blanked;
  }

  const FITB_CONFIG = {
    emptyIcon: '✍️',
    emptyTitle: 'No sentences yet',
    emptyMessage: 'Look up words to get AI example sentences, then come back to practice.',
    inputPlaceholder: 'Type the missing word…',
    restart: () => renderPractice(),
    // Sentence display + "try another sentence" toggle. Returns
    // getExpectedAnswer(), used by the shared checkAnswer() below to find
    // the actual word form used in the sentence (e.g. a conjugated form),
    // not just word.text verbatim.
    renderBody(card, word, analysis) {
      const sources = [];
      if (analysis.exampleSentence?.length > 10) sources.push({ text: analysis.exampleSentence, label: 'Example' });
      if (word.context?.length > 10 && word.context !== analysis.exampleSentence) sources.push({ text: word.context, label: 'Context' });
      let srcIdx = 0;

      const sentenceDiv = document.createElement('div');
      sentenceDiv.style.cssText = 'font-size:17px;line-height:1.7;color:var(--text-main);font-style:italic;margin-bottom:20px;text-align:center;';

      function renderSentence() {
        const { text, label } = sources[srcIdx] ?? { text: `Fill in: "${word.text}"`, label: '' };
        const blanked = _blankSentence(text, word.text) ?? text;
        const labelHtml = sources.length > 1 ? `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-soft);margin-bottom:8px;">${label} sentence</div>` : '';
        sentenceDiv.innerHTML = `${labelHtml}"${blanked.replace(/_______/g, '<span style="display:inline-block;min-width:80px;border-bottom:3px solid var(--brand);">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>')}"`;
      }
      renderSentence();
      card.appendChild(sentenceDiv);

      if (sources.length > 1) {
        const toggleBtn = document.createElement('button');
        toggleBtn.style.cssText = 'display:block;margin:0 auto 14px;font-size:11px;background:none;border:1px solid var(--border);border-radius:8px;padding:4px 10px;color:var(--text-muted);cursor:pointer;font-family:inherit;';
        toggleBtn.textContent = 'Try another sentence';
        toggleBtn.onclick = () => { srcIdx = (srcIdx + 1) % sources.length; renderSentence(); };
        card.appendChild(toggleBtn);
      }

      return {
        getExpectedAnswer() {
          const { text: sentText } = sources[srcIdx] ?? { text: '' };
          const escaped   = word.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const sentMatch = sentText.match(new RegExp(`\\b(${escaped}\\w*)\\b`, 'i'));
          return sentMatch?.[1] ?? word.text;
        },
      };
    },
  };

  /**
   * Shared render shell for both Practice modes. `state` holds this mode's
   * queue/index/correct/wrong; `config` supplies the mode-specific empty-
   * state copy, restart handler, input placeholder, and renderBody() (which
   * inserts whatever's mode-specific between the hint line and the answer
   * input, and returns { getExpectedAnswer() } used by checkAnswer() below).
   */
  function _showNextPracticeCard(state, config) {
    practiceContainer.innerHTML = '';

    if (state.queue.length === 0) {
      practiceContainer.innerHTML = `
        <div style="text-align:center;color:var(--text-muted);padding:40px 0;">
          <div style="font-size:48px;margin-bottom:12px;">${config.emptyIcon}</div>
          <h2>${config.emptyTitle}</h2>
          <p style="font-size:14px;margin-bottom:16px;">${config.emptyMessage}</p>
          <button class="btn-ghost" id="practice-back-modes-empty" style="padding:10px 20px;">← Back to modes</button>
        </div>`;
      document.getElementById('practice-back-modes-empty').onclick = showPracticeModeSelect;
      return;
    }

    if (state.index >= state.queue.length) {
      const total = state.correct.length + state.wrong.length;
      const score = total > 0 ? Math.round((state.correct.length / total) * 100) : 0;

      const wordList = (words, color, icon) => words.length === 0
        ? `<span style="color:var(--text-soft);font-size:13px;">None</span>`
        : words.map(w => `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${color}15;color:${color};border:1px solid ${color}30;margin:3px 2px;">${icon} ${escapeHtml(w.text)}</span>`).join('');

      practiceContainer.innerHTML = `
        <div style="width:100%;max-width:560px;">
          <div class="fitb-card" style="text-align:center;">
            <div style="font-size:48px;margin-bottom:8px;">🎉</div>
            <h2 style="color:var(--text-main);margin:0 0 4px;">Session Complete!</h2>
            <p style="color:var(--text-muted);margin:0 0 16px;">You practised ${total} word${total !== 1 ? 's' : ''}</p>
            <div style="font-size:36px;font-weight:700;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:20px;">${score}%</div>

            <div style="text-align:left;margin-bottom:16px;">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#16a34a;margin-bottom:8px;">✓ Correct (${state.correct.length})</div>
              <div style="display:flex;flex-wrap:wrap;gap:2px;">${wordList(state.correct, '#16a34a', '✓')}</div>
            </div>

            <div style="text-align:left;margin-bottom:24px;">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#ef4444;margin-bottom:8px;">✗ Needs work (${state.wrong.length})</div>
              <div style="display:flex;flex-wrap:wrap;gap:2px;">${wordList(state.wrong, '#ef4444', '✗')}</div>
            </div>

            <button class="btn-primary" id="restart-practice" style="padding:10px 28px;">Practice Again</button>
            <button class="btn-ghost" id="practice-back-modes" style="padding:10px 20px;">← Back to modes</button>
          </div>
        </div>`;
      document.getElementById('restart-practice').onclick = config.restart;
      document.getElementById('practice-back-modes').onclick = showPracticeModeSelect;
      return;
    }

    const word     = state.queue[state.index];
    const analysis = word.aiAnalysis || {};
    const total    = state.queue.length;
    const progress = Math.round((state.index / total) * 100);
    let answered   = false;

    // Progress bar
    const progressWrap = document.createElement('div');
    progressWrap.style.cssText = 'width:100%;background:rgba(0,0,0,0.07);border-radius:999px;height:4px;margin-bottom:20px;overflow:hidden;';
    progressWrap.innerHTML = `<div style="height:4px;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--brand-2));width:${progress}%;transition:width 0.4s;"></div>`;
    practiceContainer.appendChild(progressWrap);

    const card = document.createElement('div');
    card.className = 'fitb-card';

    // Counter
    const counter = document.createElement('div');
    counter.style.cssText = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-soft);margin-bottom:14px;text-align:center;';
    counter.textContent = `${state.index + 1} / ${total}`;
    card.appendChild(counter);

    // First-letter hint (hidden until used)
    const hintLine = document.createElement('div');
    hintLine.style.cssText = 'font-size:12px;color:var(--text-soft);margin-bottom:10px;text-align:center;visibility:hidden;';
    hintLine.textContent = `Hint: starts with "${word.text[0].toUpperCase()}"`;
    card.appendChild(hintLine);

    // Mode-specific body (FITB's sentence+toggle, Listen's speaker button)
    const bodyApi = config.renderBody(card, word, analysis);

    // Answer input
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = config.inputPlaceholder;
    input.className = 'fitb-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    card.appendChild(input);

    // Feedback line
    const feedback = document.createElement('div');
    feedback.className = 'fitb-feedback';
    card.appendChild(feedback);

    // Reveal area (definition, shown after answering)
    const revealDiv = document.createElement('div');
    revealDiv.className = 'fitb-reveal';
    revealDiv.style.display = 'none';
    card.appendChild(revealDiv);

    // Button row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn-primary';
    checkBtn.style.cssText = 'padding:10px 28px;font-size:14px;';
    checkBtn.textContent = 'Check';

    const nextBtn = document.createElement('button');
    nextBtn.id = 'practice-next-btn'; // Enter-to-advance keyboard shortcut targets this id (see the global keydown listener below) — only one Practice mode is ever rendered into #practice-container at a time, so reusing the same id across both modes' Next buttons is safe.
    nextBtn.className = 'btn-ghost';
    nextBtn.style.cssText = 'padding:10px 20px;font-size:14px;display:none;';
    nextBtn.textContent = 'Next →';
    nextBtn.onclick = () => { state.index++; _showNextPracticeCard(state, config); };

    const skipBtn = document.createElement('button');
    skipBtn.style.cssText = 'padding:10px 16px;font-size:13px;background:none;border:1px solid var(--border);border-radius:10px;color:var(--text-muted);cursor:pointer;font-family:inherit;';
    skipBtn.textContent = 'Skip';

    const hintBtn = document.createElement('button');
    hintBtn.style.cssText = 'padding:8px 14px;font-size:12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-soft);cursor:pointer;font-family:inherit;';
    hintBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>Hint';
    hintBtn.onclick = () => { hintLine.style.visibility = 'visible'; hintBtn.style.display = 'none'; };

    // Shared "reveal" transition — both a checked answer and a skip land
    // here: input locked, Check/Skip/Hint hidden, Next shown. Having Skip go
    // through the same reveal step as Check (rather than silently
    // fast-forwarding, as it did before) is what makes the two-state Enter
    // logic below make sense: State 2 (Results) is "whatever got you here,
    // the definition is now showing and Next is the only way forward."
    function _revealUI() {
      answered = true;
      input.disabled = true;
      checkBtn.style.display = 'none';
      skipBtn.style.display  = 'none';
      hintBtn.style.display  = 'none';
      nextBtn.style.display  = '';
    }

    function checkAnswer() {
      if (answered) return;
      const userAns = input.value.trim();
      if (!userAns) return;

      _revealUI();

      const expected  = bodyApi.getExpectedAnswer();
      const norm      = s => s.toLowerCase().trim();
      const isCorrect = norm(userAns) === norm(word.text) || norm(userAns) === norm(expected);

      if (isCorrect) {
        input.classList.add('correct');
        feedback.innerHTML = `<span style="color:#16a34a;">✓ Correct!</span>`;
        state.correct.push(word);
      } else {
        input.classList.add('wrong');
        feedback.innerHTML = `<span style="color:#ef4444;">✗ The answer was <strong>${escapeHtml(expected)}</strong></span>`;
        state.wrong.push(word);
      }

      revealDiv.style.display = 'block';
      revealDiv.innerHTML = analysis.translation
        ? `<span style="color:var(--brand);font-weight:600;">${escapeHtml(analysis.translation)}</span> — ${escapeHtml(analysis.definitionTranslated || analysis.definition || '')}`
        : escapeHtml(analysis.definition || '');
    }

    // Skip is a soft, neutral action — same as Game modes, it's not counted
    // as wrong (no push to state.wrong) — it just reveals the answer via
    // the same UI transition checkAnswer() uses, instead of the old
    // behavior of silently jumping straight to the next word with no
    // feedback shown at all.
    function skipAnswer() {
      if (answered) return;
      _revealUI();
      feedback.innerHTML = `<span style="color:#f59e0b;">→ Skipped — the answer was <strong>${escapeHtml(word.text)}</strong></span>`;
      revealDiv.style.display = 'block';
      revealDiv.innerHTML = analysis.translation
        ? `<span style="color:var(--brand);font-weight:600;">${escapeHtml(analysis.translation)}</span> — ${escapeHtml(analysis.definitionTranslated || analysis.definition || '')}`
        : escapeHtml(analysis.definition || '');
    }

    checkBtn.onclick = checkAnswer;
    skipBtn.onclick  = skipAnswer;
    // stopPropagation is the key fix: without it, this same Enter keypress
    // bubbles from the input up to the document-level "Enter advances to
    // Next" listener (added further down) — checkAnswer() has *already*
    // made the Next button visible by the time bubbling reaches document,
    // in the same synchronous dispatch, so both handlers used to fire off a
    // single Enter press: submit AND immediately advance, skipping the
    // results screen entirely. Stopping propagation here means submitting
    // and advancing are always two separate keypresses.
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); checkAnswer(); } });

    btnRow.appendChild(checkBtn);
    btnRow.appendChild(nextBtn);
    btnRow.appendChild(skipBtn);
    card.appendChild(btnRow);

    const hintRow = document.createElement('div');
    hintRow.style.cssText = 'text-align:center;margin-top:12px;';
    hintRow.appendChild(hintBtn);
    card.appendChild(hintRow);

    practiceContainer.appendChild(card);
    input.focus();
  }

  // ─── Practice: Listen and Write ──────────────────────────────────────────────
  // Structurally parallel to Read and Write above, but the queue is every saved
  // word (no sentence needed — this mode only needs the word + its audio, and
  // speakText() already falls back to Web Speech API when there's no cached
  // TTS) and there's no sentence-blanking: the word itself is hidden and the
  // user types what they hear. Separate correct/wrong tracking so switching
  // modes mid-session doesn't cross-contaminate either mode's score.

  const _listenState = { queue: [], index: 0, correct: [], wrong: [] };

  // Defaults to "All Words" for the same reason renderPractice() does —
  // Listen and Write's own spec is "all saved words," no FSRS relationship.
  async function renderListenWrite() {
    _activePracticeMode = 'listen-write';
    const token = ++_practiceEntryToken;
    const words = await getWords();
    if (token !== _practiceEntryToken) return; // superseded by a newer entry
    _practiceAllWords = words;
    _activePracticeFilter = 'all';
    _renderPracticeFilterStrip();
    _applyPracticeFilter();
  }

  /** Build the listen-and-write queue from a (already FSRS-filtered) word list and start it. */
  function _buildListenQueue(words) {
    _listenState.queue   = _shuffle(words);
    _listenState.index   = 0;
    _listenState.correct = [];
    _listenState.wrong   = [];
    _showNextPracticeCard(_listenState, LISTEN_CONFIG);
  }

  const LISTEN_CONFIG = {
    emptyIcon: '🎧',
    emptyTitle: 'No words yet',
    emptyMessage: 'Save some words first, then come back to practice listening.',
    inputPlaceholder: 'Type what you hear…',
    restart: () => renderListenWrite(),
    // Speaker — auto-plays once when the card renders, replayable on
    // demand. The word itself is never shown anywhere on this card, so the
    // expected answer is always just the bare word (no sentence-form logic
    // like FITB needs).
    renderBody(card, word, analysis) {
      const speakerWrap = document.createElement('div');
      speakerWrap.style.cssText = 'display:flex;justify-content:center;margin-bottom:20px;';
      speakerWrap.appendChild(createSpeakerButton(word.text, analysis.audioBase64, 'Listen'));
      card.appendChild(speakerWrap);
      speakText(word.text, analysis.audioBase64);

      return { getExpectedAnswer: () => word.text };
    },
  };

  // ─── Practice: Enter-to-advance once the definition/results reveal is showing ──
  // Both Read-and-Write's and Listen-and-Write's answer <input> already
  // handle Enter to *submit* (checkAnswer(), see each mode's own keydown
  // listener above) — but once answered, the input is disabled and a
  // disabled element doesn't reliably keep receiving its own keydown events,
  // so a second Enter press had no effect before this: the only way to move
  // on was clicking "Next →" with the mouse. This is a second, separate,
  // document-level listener that only acts once the Next button is actually
  // visible (i.e. the reveal/definition area is showing), so it never
  // conflicts with the input's own Enter-to-submit behavior — before
  // answering, the Next button is display:none and this is a no-op.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!document.getElementById('practice-view')?.classList.contains('active')) return;
    if (!practiceSessionScreen.classList.contains('active')) return;

    const nextBtn = document.getElementById('practice-next-btn');
    if (!nextBtn || nextBtn.style.display === 'none' || nextBtn.disabled) return;
    // If Next itself is already focused (e.g. the user tabbed to it), the
    // browser's own native "Enter activates the focused button" behavior
    // will fire its own click right after this keydown handler runs —
    // skip our explicit click here so a single Enter press doesn't advance
    // two words at once.
    if (document.activeElement === nextBtn) return;
    nextBtn.click();
  });

});


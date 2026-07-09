// renderer/app.js
// Main renderer logic for VocabAI Desktop
// Adapted from dashboard/dashboard.js — chrome.* APIs replaced with localStorage + fetch

import { getWords, deleteWord, updateWord, saveWord, getSettings, saveSettings } from './storage-shim.js';
import { initGame } from './game-controller.js';
import { applyTheme, applyHueTheme } from './theme.js';
import { nextLearningState } from './game-engine.js';
import { escapeHtml } from './dom-utils.js';
import {
  loadVocab,
  apiAnalyzeText,
  apiImportWords,
  apiRequestCode,
  apiVerifyCode,
  setAuthSession,
  clearAuthSession,
  isLoggedIn,
  getToken,
  getEmail,
} from './api.js';
import { loadLocalDictionary, lookupLocalDef } from './local-dictionary.js';

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

// ─── Speak word — Google TTS audio if cached, Web Speech API as fallback ────────
function speakText(word, audioBase64) {
  if (!word) return;

  if (audioBase64) {
    try {
      const audio = new Audio(`data:audio/mp3;base64,${audioBase64}`);
      audio.play();
      return;
    } catch (_) { /* fall through to Web Speech */ }
  }

  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  window.speechSynthesis.speak(utterance);
}

document.addEventListener('DOMContentLoaded', async () => {

  // ─── Initialise Lucide SVG icons ─────────────────────────────────────────────
  if (window.lucide) window.lucide.createIcons();

  // ─── Startup: show login page or main app ─────────────────────────────────────
  if (isLoggedIn()) {
    showMainApp();
  } else {
    showLoginPage();
    // Tauri starts the window hidden (background app) — bring it up so the
    // user can sign in. No-op on Electron, where the window is always shown.
    window.electronAPI?.showDashboard?.();
  }

  // ─── "How to use" card: platform-aware shortcut labels ───────────────────────
  {
    const isTauri = !!window.__TAURI__;
    const mod = window.electronAPI?.platform === 'darwin' ? '⌘' : 'Ctrl';
    const lookupEl = document.getElementById('howto-lookup');
    if (lookupEl) {
      lookupEl.innerHTML = isTauri
        ? `Press <strong>${mod}+Shift+D</strong> (or click the Semantica tray icon)`
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
      if (tab.dataset.target === 'list-view')      loadVocab().then(renderWords);
      if (tab.dataset.target === 'review-view')    startReviewSession();
      if (tab.dataset.target === 'game-view')      initGame();
      if (tab.dataset.target === 'sentences-view') renderSentences();
      if (tab.dataset.target === 'videos-view')    renderVideos();
      if (tab.dataset.target === 'practice-view')  renderPractice();
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
  if (currentSettings.accentHue !== undefined) {
    applyHueTheme(currentSettings.accentHue, currentSettings.darkMode);
  } else {
    applyTheme(currentSettings);
  }

  const loggedIn = isLoggedIn();
  const defaultProvider = loggedIn ? 'cloud' : 'freedict';
  aiProviderSelect.value = currentSettings.provider || defaultProvider;

  // Accent hue slider
  const hueSlider  = document.getElementById('accent-hue');
  const huePreview = document.getElementById('hue-preview');

  hueSlider.value = currentSettings.accentHue ?? 190;
  updateHuePreview(hueSlider.value);

  hueSlider.addEventListener('input', () => {
    const hue = parseInt(hueSlider.value, 10);
    applyHueTheme(hue, darkToggle.checked);
    updateHuePreview(hue);
  });

  function updateHuePreview(hue) {
    const color = `hsl(${hue}, 85%, 55%)`;
    huePreview.style.background = color;
    hueSlider.style.accentColor = color;
  }

  // Dark mode toggle (settings page)
  const darkToggle = document.getElementById('dark-mode-toggle');
  darkToggle.checked = !!currentSettings.darkMode;
  darkToggle.addEventListener('change', () => {
    applyHueTheme(parseInt(hueSlider.value, 10), darkToggle.checked);
    navDarkBtn.textContent = darkToggle.checked ? '☀️' : '🌙';
  });

  // Nav dark mode quick-toggle
  const navDarkBtn = document.getElementById('nav-dark-toggle');
  navDarkBtn.textContent = currentSettings.darkMode ? '☀️' : '🌙';
  navDarkBtn.addEventListener('click', () => {
    darkToggle.checked = !darkToggle.checked;
    applyHueTheme(parseInt(hueSlider.value, 10), darkToggle.checked);
    navDarkBtn.textContent = darkToggle.checked ? '☀️' : '🌙';
  });

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
      accentHue: parseInt(hueSlider.value, 10),
      darkMode: darkToggle.checked,
    };
    await saveSettings(newSettings);
    applyHueTheme(newSettings.accentHue, newSettings.darkMode);
    saveMsg.style.opacity = 1;
    setTimeout(() => { saveMsg.style.opacity = 0; }, 2000);
  });

  // ─── Load IELTS wordlist + offline dictionary (parallel, non-blocking) ──────
  loadIeltsWordlist();
  loadLocalDictionary();

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
  const tagChipsEl   = document.getElementById('tag-cloud-chips');
  const filterBar    = document.getElementById('tag-filter-bar');
  const filterLabel  = document.getElementById('tag-filter-label');
  const reviewBtn    = document.getElementById('tag-review-btn');
  const clearBtn     = document.getElementById('tag-clear-btn');

  // ─── Tag / Band / Topic filter state ─────────────────────────────────────────
  const selectedTags   = new Set();
  const selectedBands  = new Set(); // Set<number>
  const selectedTopics = new Set(); // Set<string>

  function renderTagCloud(allWords) {
    if (!allWords) allWords = getWords().slice();

    const bandColors   = { 2:'#64748b',3:'#64748b',5:'#0d9488',6:'#0891b2',7:'#7c3aed',8:'#b45309',9:'#b91c1c' };
    const bandCounts   = new Map(); // band number → word count
    const topicCounts  = new Map(); // topic string → word count
    const tagCounts    = new Map(); // tag string → word count

    allWords.forEach(w => {
      const ielts = lookupIelts(w.text);
      if (ielts) bandCounts.set(ielts.band, (bandCounts.get(ielts.band) || 0) + 1);

      (w.aiAnalysis?.ieltsTopics || []).forEach(t =>
        topicCounts.set(t, (topicCounts.get(t) || 0) + 1));

      [...new Set([...(w.aiAnalysis?.tags || []), ...(w.userTags || [])])].forEach(t =>
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
    });

    const hasBands  = bandCounts.size > 0;
    const hasTopics = topicCounts.size > 0;
    const hasTags   = tagCounts.size > 0;

    if (!hasBands && !hasTopics && !hasTags) { tagCloud.style.display = 'none'; return; }

    tagCloud.style.display = 'block';
    tagChipsEl.innerHTML = '';

    // ── Row 1: Band filter pills ──────────────────────────────────────────────
    if (hasBands) {
      const bandRow = document.createElement('div');
      bandRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;';

      [...bandCounts.entries()].sort((a, b) => a[0] - b[0]).forEach(([band, count]) => {
        const bc  = bandColors[band] || '#64748b';
        const btn = document.createElement('button');
        btn.className = 'tag-chip' + (selectedBands.has(band) ? ' active' : '');
        btn.style.cssText = `background:${bc}15;color:${bc};border-color:${bc}40;font-weight:700;letter-spacing:0.03em;`;
        btn.innerHTML = `Band ${band} <span class="tag-count" style="background:${bc}25;color:${bc};">${count}</span>`;
        btn.addEventListener('click', () => {
          if (selectedBands.has(band)) selectedBands.delete(band); else selectedBands.add(band);
          renderWords();
        });
        bandRow.appendChild(btn);
      });
      tagChipsEl.appendChild(bandRow);
    }

    // ── Row 2: IELTS topic filter chips ──────────────────────────────────────
    if (hasTopics) {
      const topicRow = document.createElement('div');
      topicRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;';

      [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([topic, count]) => {
        const btn = document.createElement('button');
        btn.className = 'tag-chip' + (selectedTopics.has(topic) ? ' active' : '');
        btn.style.cssText = 'background:rgba(99,102,241,0.08);color:#818cf8;border-color:rgba(99,102,241,0.3);';
        btn.innerHTML = `${escapeHtml(topic)} <span class="tag-count" style="background:rgba(99,102,241,0.15);color:#818cf8;">${count}</span>`;
        btn.addEventListener('click', () => {
          if (selectedTopics.has(topic)) selectedTopics.delete(topic); else selectedTopics.add(topic);
          renderWords();
        });
        topicRow.appendChild(btn);
      });
      tagChipsEl.appendChild(topicRow);
    }

    // ── Divider ───────────────────────────────────────────────────────────────
    if ((hasBands || hasTopics) && hasTags) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:var(--border);margin-bottom:8px;opacity:0.5;';
      tagChipsEl.appendChild(sep);
    }

    // ── Row 3: Auto-generated tags — max 2 lines, "See more" to expand ───────
    if (hasTags) {
      const tagsOuter = document.createElement('div');

      const tagsRow = document.createElement('div');
      tagsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;max-height:64px;overflow:hidden;';

      [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([tag, count]) => {
        const btn = document.createElement('button');
        btn.className = 'tag-chip' + (selectedTags.has(tag) ? ' active' : '');
        btn.innerHTML = `${escapeHtml(tag)} <span class="tag-count">${count}</span>`;
        btn.addEventListener('click', () => {
          if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
          renderWords();
        });
        tagsRow.appendChild(btn);
      });

      tagsOuter.appendChild(tagsRow);

      const seeMoreBtn = document.createElement('button');
      seeMoreBtn.style.cssText = 'display:none;margin-top:6px;font-size:11px;font-weight:600;color:var(--brand);background:none;border:none;cursor:pointer;padding:0;font-family:inherit;';
      seeMoreBtn.textContent = 'See more ↓';
      let tagsExpanded = false;
      seeMoreBtn.onclick = () => {
        tagsExpanded = !tagsExpanded;
        tagsRow.style.maxHeight = tagsExpanded ? 'none' : '64px';
        seeMoreBtn.textContent  = tagsExpanded ? 'See less ↑' : 'See more ↓';
      };
      tagsOuter.appendChild(seeMoreBtn);
      tagChipsEl.appendChild(tagsOuter);

      // Show "See more" only when content actually overflows 2 lines
      requestAnimationFrame(() => {
        if (tagsRow.scrollHeight > 68) seeMoreBtn.style.display = 'block';
      });
    }
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
      const wordGrad = document.createElement('div');
      wordGrad.style.cssText = 'font-size:20px;font-weight:700;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-0.3px;line-height:1.2;margin-bottom:4px;';
      wordGrad.textContent = word.text;

      const phonetic = document.createElement('div');
      phonetic.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:monospace;margin-bottom:8px;';
      phonetic.textContent = (word.aiAnalysis?.pronunciation) || '';

      const playBtn = document.createElement('button');
      playBtn.style.cssText = 'display:inline-flex;align-items:center;gap:5px;color:var(--text-muted);background:none;border:none;cursor:pointer;font-size:11px;font-family:inherit;padding:0;transition:color 0.15s;';
      playBtn.innerHTML = `<span style="width:22px;height:22px;border-radius:50%;background:rgba(6,182,212,0.10);display:flex;align-items:center;justify-content:center;transition:background 0.15s;"><i data-lucide="volume-2" style="width:11px;height:11px;color:var(--brand);stroke-width:2.5;"></i></span><span>Play</span>`;
      playBtn.onmouseenter = () => { playBtn.style.color = 'var(--brand)'; playBtn.querySelector('span').style.background = 'rgba(6,182,212,0.20)'; };
      playBtn.onmouseleave = () => { playBtn.style.color = 'var(--text-muted)'; playBtn.querySelector('span').style.background = 'rgba(6,182,212,0.10)'; };
      playBtn.onclick = (e) => { e.stopPropagation(); speakText(word.text, word.aiAnalysis?.audioBase64); };

      tdWord.appendChild(wordGrad);
      tdWord.appendChild(phonetic);
      tdWord.appendChild(playBtn);
      if (window.lucide) window.lucide.createIcons({ nodes: [playBtn] });

      // Band badge — displayed as its own line under the play button
      const ieltsForBadge = lookupIelts(word.text);
      if (ieltsForBadge) {
        const bandColors = { 2:'#64748b',3:'#64748b',5:'#0d9488',6:'#0891b2',7:'#7c3aed',8:'#b45309',9:'#b91c1c' };
        const bc = bandColors[ieltsForBadge.band] || '#64748b';
        const bandBadge = document.createElement('div');
        bandBadge.style.cssText = `margin-top:7px;`;
        const bandPill = document.createElement('span');
        bandPill.style.cssText = `padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;background:${bc}18;color:${bc};border:1px solid ${bc}40;`;
        bandPill.textContent = `Band ${ieltsForBadge.band}`;
        bandBadge.appendChild(bandPill);
        tdWord.appendChild(bandBadge);
      }

      // Context/Meaning Column
      const tdContext = document.createElement('td');
      tdContext.className = 'context-col';

      const contextDiv = document.createElement('div');
      contextDiv.style.fontStyle   = 'italic';
      contextDiv.style.marginBottom = '4px';
      contextDiv.style.color        = 'var(--text-muted)';
      contextDiv.textContent        = `"${word.context}"`;
      tdContext.appendChild(contextDiv);

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
          input.style.cssText = 'border:1px solid var(--brand);border-radius:6px;padding:3px 8px;font-size:10px;font-family:inherit;outline:none;width:80px;background:var(--bg);color:var(--text);';
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

      const btnAnalyze = document.createElement('button');
      btnAnalyze.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;font-size:11px;font-weight:500;border:1px solid var(--border);color:var(--text-muted);background:none;cursor:pointer;font-family:inherit;transition:all 0.15s;margin-bottom:6px;';
      btnAnalyze.innerHTML = '<i data-lucide="refresh-cw" style="width:11px;height:11px;stroke-width:2.5;"></i> Reload';
      btnAnalyze.onmouseenter = () => { btnAnalyze.style.borderColor='rgba(6,182,212,0.5)'; btnAnalyze.style.color='var(--brand)'; btnAnalyze.style.background='var(--brand-soft)'; };
      btnAnalyze.onmouseleave = () => { btnAnalyze.style.borderColor='var(--border)'; btnAnalyze.style.color='var(--text-muted)'; btnAnalyze.style.background='none'; };
      btnAnalyze.onclick = () => handleAnalyze(word, aiResultDiv, btnAnalyze);

      const btnDelete = document.createElement('button');
      btnDelete.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;font-size:11px;font-weight:500;border:1px solid transparent;color:var(--text-muted);background:none;cursor:pointer;font-family:inherit;transition:all 0.15s;';
      btnDelete.innerHTML = '<i data-lucide="trash-2" style="width:11px;height:11px;stroke-width:2.5;"></i> Delete';
      btnDelete.onmouseenter = () => { btnDelete.style.borderColor='rgba(239,68,68,0.3)'; btnDelete.style.color='#ef4444'; btnDelete.style.background='rgba(239,68,68,0.05)'; };
      btnDelete.onmouseleave = () => { btnDelete.style.borderColor='transparent'; btnDelete.style.color='var(--text-muted)'; btnDelete.style.background='none'; };
      btnDelete.onclick = () => handleDelete(word.text, btnDelete);

      tdActions.appendChild(btnAnalyze);
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
        chip.style.cssText = 'padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(99,102,241,0.1);color:#818cf8;border:1px solid rgba(99,102,241,0.25);';
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
      defRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;justify-content:space-between;padding-top:8px;border-top:1px solid rgba(6,182,212,0.12);margin-top:4px;margin-bottom:6px;';

      const enLabel = document.createElement('span');
      enLabel.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(6,182,212,0.6);margin-top:2px;flex-shrink:0;';
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
      exBlock.style.cssText = 'padding-top:8px;border-top:1px solid rgba(0,0,0,0.07)';

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
      collBlock.style.cssText = 'padding-top:8px;margin-top:4px;border-top:1px solid rgba(6,182,212,0.12);';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(6,182,212,0.6);margin-bottom:6px;';
      label.textContent = 'Common Collocations';
      collBlock.appendChild(label);

      const pills = document.createElement('div');
      pills.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;';

      // Show first 6 collocations
      ielts.collocations.slice(0, 6).forEach(phrase => {
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(6,182,212,0.07);border:1px solid rgba(6,182,212,0.18);color:var(--text-muted);';
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
            pill.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(6,182,212,0.07);border:1px solid rgba(6,182,212,0.18);color:var(--text-muted);';
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

  // ─── Analyze (↻ Reload) ───────────────────────────────────────────────────────
  async function handleAnalyze(word, resultElement, btnEl) {
    if (btnEl) btnEl.disabled = true;
    resultElement.innerHTML = '<span class="loading">Consulting...</span>';
    try {
      const settings = getSettings();
      const targetLanguage = 'Vietnamese'; // fixed: English → Vietnamese
      const analysis = await apiAnalyzeText(word.text, word.context, targetLanguage);
      await updateWord(word.text, { aiAnalysis: analysis });
      renderDefinitionBlock(resultElement, word, analysis);
    } catch (error) {
      resultElement.innerHTML = `<span style="color:red">Error: ${error.message}</span>`;
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
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

  function initVocabSearch() {
    const searchInput   = document.getElementById('vocab-search-input');
    const searchClear   = document.getElementById('vocab-search-clear');
    const definePrompt  = document.getElementById('search-define-prompt');
    const defineLabel   = document.getElementById('search-define-label');
    const defineBtn     = document.getElementById('search-define-btn');

    let _searchTerm = '';

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

    /** Re-render words filtered + sorted by search term; show "define" prompt if no exact match */
    function applySearchFilter(term) {
      if (!term) { definePrompt.style.display = 'none'; renderWords(); return; }

      const allWords  = getWords();
      const tLower    = term.toLowerCase();

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
        const displayTerm = searchInput.value.trim();
        defineLabel.textContent = `"${displayTerm}" is not in your vocabulary yet.`;
        definePrompt.style.display = 'flex';
      } else {
        definePrompt.style.display = 'none';
      }
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
        await saveWord({ text: _pendingWord, context: '', aiAnalysis: _pendingAnalysis });
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

    // Instant first paint from the offline dictionary — shown while AI loads
    function renderLookupLocal(wordText, senses) {
      resultEl.innerHTML = '';
      const wrap = document.createElement('div');
      const first = senses[0];

      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:4px;';
      const wordTitle = document.createElement('div');
      wordTitle.style.cssText = 'font-size:26px;font-weight:800;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;';
      wordTitle.textContent = wordText;
      const phonetic = document.createElement('div');
      phonetic.style.cssText = 'font-size:12px;color:var(--text-muted);font-family:monospace;';
      phonetic.textContent = first.phon || '';
      hdr.appendChild(wordTitle);
      hdr.appendChild(phonetic);
      wrap.appendChild(hdr);

      senses.slice(0, 2).forEach(sense => {
        const card = document.createElement('div');
        card.className = 'ai-card-bg';
        card.style.cssText = 'padding:14px;margin-top:10px;';
        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:10px;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;';
        meta.textContent = [sense.pos, sense.cefr].filter(Boolean).join(' · ');
        if (meta.textContent) card.appendChild(meta);
        const def = document.createElement('div');
        def.style.cssText = 'font-size:13px;color:var(--text);line-height:1.5;';
        def.textContent = sense.def;
        card.appendChild(def);
        if (sense.ex) {
          const ex = document.createElement('div');
          ex.style.cssText = 'margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(6,182,212,0.06);font-size:12px;color:var(--text-muted);font-style:italic;line-height:1.5;';
          ex.textContent = `"${sense.ex}"`;
          card.appendChild(ex);
        }
        wrap.appendChild(card);
      });

      const pending = document.createElement('div');
      pending.id = 'lookup-ai-pending';
      pending.style.cssText = 'margin-top:10px;font-size:12px;color:var(--text-muted);';
      pending.textContent = '✦ Fetching translation & AI analysis…';
      wrap.appendChild(pending);

      resultEl.appendChild(wrap);
    }

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

      // ── Instant first paint from the offline dictionary ──
      const localSenses = lookupLocalDef(wordText, lookupIelts(wordText));
      if (localSenses?.length) {
        renderLookupLocal(wordText, localSenses);
        loading.style.display  = 'none';
        resultEl.style.display = 'block';
      }

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
          tr.style.cssText = 'font-size:20px;font-weight:700;color:var(--text);margin-bottom:6px;';
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
          defRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding-top:8px;border-top:1px solid rgba(6,182,212,0.12);';
          const enLabel = document.createElement('span');
          enLabel.style.cssText = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:rgba(6,182,212,0.6);margin-top:3px;flex-shrink:0;';
          enLabel.textContent = 'EN';
          const defText = document.createElement('div');
          defText.style.cssText = 'font-size:12px;color:var(--text);line-height:1.5;';
          defText.textContent = analysis.definition;
          defRow.appendChild(enLabel);
          defRow.appendChild(defText);
          card.appendChild(defRow);
        }
        if (analysis.exampleSentence) {
          const ex = document.createElement('div');
          ex.style.cssText = 'margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(6,182,212,0.06);font-size:12px;color:var(--text-muted);font-style:italic;line-height:1.5;';
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
        // If the offline dictionary already rendered, the word is valid —
        // the failure is network/API. Keep the local result and let the user
        // save it with a minimal analysis built from the local sense.
        if (localSenses?.length) {
          document.getElementById('lookup-ai-pending')?.remove();
          const first = localSenses[0];
          _pendingAnalysis = {
            definition: first.def,
            exampleSentence: first.ex || '',
            partOfSpeech: first.pos || '',
            pronunciation: first.phon || '',
            source: 'local-dictionary',
          };
          const note = document.createElement('div');
          note.style.cssText = 'margin-top:10px;font-size:11px;color:var(--text-muted);';
          note.textContent = 'Translation unavailable right now — showing the offline dictionary entry.';
          resultEl.firstChild?.appendChild(note);

          footer.style.display = 'flex';
          const alreadySaved = getWords().some(w => w.text.toLowerCase() === wordText.toLowerCase());
          saveBtn.style.display = 'flex';
          saveBtn.disabled = alreadySaved;
          saveBtn.innerHTML = alreadySaved
            ? '✓ Already in your vocabulary'
            : '<i data-lucide="plus" style="width:13px;height:13px;stroke-width:2.5;"></i> Save to My Vocabulary';
          if (window.lucide) window.lucide.createIcons({ nodes: [saveBtn] });
          return;
        }

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
  }

  function showLoggedOutState() {
    document.getElementById('acct-logged-out').style.display  = 'block';
    document.getElementById('acct-code-sent').style.display   = 'none';
    document.getElementById('acct-logged-in').style.display   = 'none';
    document.getElementById('acct-code').value                = '';
    document.getElementById('acct-send-error').style.display  = 'none';
    document.getElementById('acct-verify-error').style.display = 'none';
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

  /** Update SRS fields after a review. grade: 0=hard, 1=good, 2=easy */
  function srsUpdate(word, grade) {
    const now = Date.now();
    const s   = word.srs || {};
    const ef  = s.easeFactor ?? 2.5;
    const iv  = s.interval   ?? 1;
    let newIv, newEf;
    if      (grade === 0) { newIv = 1; newEf = Math.max(1.3, ef - 0.2); }
    else if (grade === 1) { newIv = Math.max(1, Math.ceil(iv * 1.5)); newEf = ef; }
    else                  { newIv = Math.ceil(iv * ef); newEf = Math.min(3.0, ef + 0.1); }
    return { interval: newIv, easeFactor: newEf, reviewCount: (s.reviewCount ?? 0) + 1, lastReviewed: now, dueDate: now + newIv * 86400000 };
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

  // ─── Review Mode ─────────────────────────────────────────────────────────────
  let reviewQueue        = [];
  let currentReviewIndex = 0;
  let retryCount         = new Map();
  const reviewContainer  = document.getElementById('review-container');
  const noReviewState    = document.getElementById('no-review');

  let _reviewAllWords = [];

  async function startReviewSession(prefiltered = null) {
    _reviewAllWords = prefiltered ?? await getWords();
    _renderSrsStrip(_reviewAllWords);
    _startQueue(_reviewAllWords, 'sorted');
  }

  /** Sort and start the review queue. mode: 'sorted' (due first) | 'due' (due/soon/new only) */
  function _startQueue(words, mode) {
    const order = { due: 0, soon: 1, new: 2, future: 3 };
    if (mode === 'due') {
      reviewQueue = words.filter(w => srsStatus(w) !== 'future');
    } else {
      reviewQueue = [...words].sort((a, b) => (order[srsStatus(a)] ?? 2) - (order[srsStatus(b)] ?? 2));
    }
    currentReviewIndex = 0;
    retryCount         = new Map();
    showNextCard();
  }

  /** Render the SRS summary strip above the review cards */
  function _renderSrsStrip(words) {
    const strip = document.getElementById('srs-strip');
    if (!strip) return;
    const c = { due: 0, soon: 0, future: 0, new: 0 };
    words.forEach(w => c[srsStatus(w)]++);
    const dueTotal = c.due + c.soon;
    const isDark   = document.documentElement.classList.contains('dark');
    const bg       = isDark ? 'rgba(30,41,59,0.90)' : 'rgba(255,255,255,0.92)';
    strip.innerHTML = `
      <div class="srs-strip-inner" style="background:${bg};">
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;font-weight:600;">
          <span style="color:#ef4444;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block;"></span>Overdue: ${c.due}</span>
          <span style="color:#f59e0b;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#f59e0b;display:inline-block;"></span>Due today: ${c.soon}</span>
          <span style="color:#22c55e;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;"></span>Upcoming: ${c.future}</span>
          <span style="color:#94a3b8;display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:50%;background:#94a3b8;display:inline-block;"></span>New: ${c.new}</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="srs-due-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;background:var(--brand-soft);color:var(--brand);border:1px solid var(--brand-border);cursor:pointer;font-weight:600;font-family:inherit;">Due (${dueTotal})</button>
          <button id="srs-all-btn" style="font-size:12px;padding:5px 12px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;border:none;cursor:pointer;font-weight:600;font-family:inherit;">All (${words.length})</button>
        </div>
      </div>`;
    document.getElementById('srs-due-btn').onclick = () => _startQueue(words, 'due');
    document.getElementById('srs-all-btn').onclick  = () => _startQueue(words, 'sorted');
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
    controls.innerHTML = `
      <button class="review-btn btn-hard" style="flex:1;padding:12px;border-radius:14px;border:none;font-weight:700;font-size:13px;cursor:pointer;background:linear-gradient(135deg,#ef4444,#f43f5e);color:#fff;box-shadow:0 4px 12px rgba(239,68,68,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;">✕ Hard / Again</button>
      <button class="review-btn btn-good" style="flex:1;padding:12px;border-radius:14px;border:none;font-weight:700;font-size:13px;cursor:pointer;background:linear-gradient(135deg,#10b981,#22c55e);color:#fff;box-shadow:0 4px 12px rgba(16,185,129,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;">✓ Good / Next</button>
      <button class="review-btn btn-easy" style="flex:1;padding:12px;border-radius:14px;border:none;font-weight:700;font-size:13px;cursor:pointer;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 4px 12px rgba(99,102,241,0.25);transition:transform 0.1s,box-shadow 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;">✦ Easy / Mastered</button>
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

    const btnHard = controls.querySelector('.btn-hard');
    const btnGood = controls.querySelector('.btn-good');
    const btnEasy = controls.querySelector('.btn-easy');

    btnHard.onclick = async (e) => {
      e.stopPropagation();
      const count = (retryCount.get(word.text) || 0) + 1;
      retryCount.set(word.text, count);
      if (count <= 2) reviewQueue.push(word);
      await updateWord(word.text, { learningState: 'relearn', srs: srsUpdate(word, 0) });
      currentReviewIndex++;
      showNextCard();
    };

    btnGood.onclick = async (e) => {
      e.stopPropagation();
      const newState = nextLearningState(word, { correct: true, hintUsed: false, skipped: false });
      await updateWord(word.text, { learningState: newState, srs: srsUpdate(word, 1) });
      currentReviewIndex++;
      showNextCard();
    };

    // Easy/Mastered — schedules word for distant future review via SRS
    btnEasy.onclick = async (e) => {
      e.stopPropagation();
      retryCount.delete(word.text);
      await updateWord(word.text, { learningState: 'known', srs: srsUpdate(word, 2) });
      currentReviewIndex++;
      showNextCard();
    };

    // Visual press feedback for all buttons
    [btnHard, btnGood, btnEasy].forEach(btn => {
      btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.96)'; btn.style.boxShadow = 'none'; });
      btn.addEventListener('mouseup',   () => { btn.style.transform = ''; btn.style.boxShadow = ''; });
      btn.addEventListener('mouseleave',() => { btn.style.transform = ''; btn.style.boxShadow = ''; });
    });
  }

  // ─── Practice Mode (Fill-in-the-Blank) ───────────────────────────────────────

  let _practiceQueue   = [];
  let _practiceIndex   = 0;
  let _practiceCorrect = []; // words answered correctly
  let _practiceWrong   = []; // words answered incorrectly
  const practiceContainer = document.getElementById('practice-container');

  async function renderPractice() {
    const words = await getWords();
    // Keep words with at least one usable sentence
    _practiceQueue = words.filter(w =>
      (w.aiAnalysis?.exampleSentence?.length > 10) || (w.context?.length > 10)
    );
    // Fisher-Yates shuffle
    for (let i = _practiceQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [_practiceQueue[i], _practiceQueue[j]] = [_practiceQueue[j], _practiceQueue[i]];
    }
    _practiceIndex   = 0;
    _practiceCorrect = [];
    _practiceWrong   = [];
    _showNextFitb();
  }

  /** Replace the target word in a sentence with a blank. Returns null if word not found. */
  function _blankSentence(sentence, wordText) {
    const escaped = wordText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\w*\\b`, 'gi');
    const blanked = sentence.replace(pattern, '_______');
    return blanked === sentence ? null : blanked;
  }

  function _showNextFitb() {
    practiceContainer.innerHTML = '';

    if (_practiceQueue.length === 0) {
      practiceContainer.innerHTML = `
        <div style="text-align:center;color:var(--text-muted);padding:40px 0;">
          <div style="font-size:48px;margin-bottom:12px;">✍️</div>
          <h2>No sentences yet</h2>
          <p style="font-size:14px;">Look up words to get AI example sentences, then come back to practice.</p>
        </div>`;
      return;
    }

    if (_practiceIndex >= _practiceQueue.length) {
      const total   = _practiceCorrect.length + _practiceWrong.length;
      const score   = total > 0 ? Math.round((_practiceCorrect.length / total) * 100) : 0;

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
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#16a34a;margin-bottom:8px;">✓ Correct (${_practiceCorrect.length})</div>
              <div style="display:flex;flex-wrap:wrap;gap:2px;">${wordList(_practiceCorrect, '#16a34a', '✓')}</div>
            </div>

            <div style="text-align:left;margin-bottom:24px;">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#ef4444;margin-bottom:8px;">✗ Needs work (${_practiceWrong.length})</div>
              <div style="display:flex;flex-wrap:wrap;gap:2px;">${wordList(_practiceWrong, '#ef4444', '✗')}</div>
            </div>

            <button class="btn-primary" id="restart-practice" style="padding:10px 28px;">Practice Again</button>
          </div>
        </div>`;
      document.getElementById('restart-practice').onclick = renderPractice;
      return;
    }

    const word     = _practiceQueue[_practiceIndex];
    const analysis = word.aiAnalysis || {};
    const total    = _practiceQueue.length;
    const progress = Math.round((_practiceIndex / total) * 100);

    // Build sentence sources (AI example first, then original context)
    const sources = [];
    if (analysis.exampleSentence?.length > 10) sources.push({ text: analysis.exampleSentence, label: 'Example' });
    if (word.context?.length > 10 && word.context !== analysis.exampleSentence) sources.push({ text: word.context, label: 'Context' });
    let srcIdx = 0;
    let answered = false;

    // Progress bar
    const progressWrap = document.createElement('div');
    progressWrap.style.cssText = 'width:100%;background:rgba(0,0,0,0.07);border-radius:999px;height:4px;margin-bottom:20px;overflow:hidden;';
    progressWrap.innerHTML = `<div style="height:4px;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--brand-2));width:${progress}%;transition:width 0.4s;"></div>`;
    practiceContainer.appendChild(progressWrap);

    const fitbCard = document.createElement('div');
    fitbCard.className = 'fitb-card';

    // Counter
    const counter = document.createElement('div');
    counter.style.cssText = 'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-soft);margin-bottom:14px;text-align:center;';
    counter.textContent = `${_practiceIndex + 1} / ${total}`;
    fitbCard.appendChild(counter);

    // First-letter hint (hidden until used)
    const hintLine = document.createElement('div');
    hintLine.style.cssText = 'font-size:12px;color:var(--text-soft);margin-bottom:10px;text-align:center;visibility:hidden;';
    hintLine.textContent = `Hint: starts with "${word.text[0].toUpperCase()}"`;
    fitbCard.appendChild(hintLine);

    // Sentence display
    const sentenceDiv = document.createElement('div');
    sentenceDiv.style.cssText = 'font-size:17px;line-height:1.7;color:var(--text-main);font-style:italic;margin-bottom:20px;text-align:center;';

    function renderSentence() {
      const { text, label } = sources[srcIdx] ?? { text: `Fill in: "${word.text}"`, label: '' };
      const blanked = _blankSentence(text, word.text) ?? text;
      const labelHtml = sources.length > 1 ? `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-soft);margin-bottom:8px;">${label} sentence</div>` : '';
      sentenceDiv.innerHTML = `${labelHtml}"${blanked.replace(/_______/g, '<span style="display:inline-block;min-width:80px;border-bottom:3px solid var(--brand);">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>')}"`;
    }
    renderSentence();
    fitbCard.appendChild(sentenceDiv);

    // Toggle sentence button
    if (sources.length > 1) {
      const toggleBtn = document.createElement('button');
      toggleBtn.style.cssText = 'display:block;margin:0 auto 14px;font-size:11px;background:none;border:1px solid var(--border);border-radius:8px;padding:4px 10px;color:var(--text-muted);cursor:pointer;font-family:inherit;';
      toggleBtn.textContent = 'Try another sentence';
      toggleBtn.onclick = () => { srcIdx = (srcIdx + 1) % sources.length; renderSentence(); };
      fitbCard.appendChild(toggleBtn);
    }

    // Answer input
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type the missing word…';
    input.className = 'fitb-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    fitbCard.appendChild(input);

    // Feedback line
    const feedback = document.createElement('div');
    feedback.className = 'fitb-feedback';
    fitbCard.appendChild(feedback);

    // Reveal area (definition, shown after answering)
    const revealDiv = document.createElement('div');
    revealDiv.className = 'fitb-reveal';
    revealDiv.style.display = 'none';
    fitbCard.appendChild(revealDiv);

    // Button row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';

    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn-primary';
    checkBtn.style.cssText = 'padding:10px 28px;font-size:14px;';
    checkBtn.textContent = 'Check';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn-ghost';
    nextBtn.style.cssText = 'padding:10px 20px;font-size:14px;display:none;';
    nextBtn.textContent = 'Next →';
    nextBtn.onclick = () => { _practiceIndex++; _showNextFitb(); };

    const skipBtn = document.createElement('button');
    skipBtn.style.cssText = 'padding:10px 16px;font-size:13px;background:none;border:1px solid var(--border);border-radius:10px;color:var(--text-muted);cursor:pointer;font-family:inherit;';
    skipBtn.textContent = 'Skip';
    skipBtn.onclick = () => { _practiceIndex++; _showNextFitb(); };

    const hintBtn = document.createElement('button');
    hintBtn.style.cssText = 'padding:8px 14px;font-size:12px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--text-soft);cursor:pointer;font-family:inherit;';
    hintBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px;"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>Hint';
    hintBtn.onclick = () => { hintLine.style.visibility = 'visible'; hintBtn.style.display = 'none'; };

    function checkAnswer() {
      if (answered) return;
      const userAns = input.value.trim();
      if (!userAns) return;

      answered = true;
      input.disabled = true;
      checkBtn.style.display = 'none';
      skipBtn.style.display  = 'none';
      hintBtn.style.display  = 'none';
      nextBtn.style.display  = '';

      // Find the target word form actually used in the sentence
      const { text: sentText } = sources[srcIdx] ?? { text: '' };
      const escaped    = word.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const sentMatch  = sentText.match(new RegExp(`\\b(${escaped}\\w*)\\b`, 'i'));
      const targetForm = sentMatch?.[1] ?? word.text;

      const norm      = s => s.toLowerCase().trim();
      const isCorrect = norm(userAns) === norm(word.text) || norm(userAns) === norm(targetForm);

      if (isCorrect) {
        input.classList.add('correct');
        feedback.innerHTML = `<span style="color:#16a34a;">✓ Correct!</span>`;
        _practiceCorrect.push(word);
      } else {
        input.classList.add('wrong');
        feedback.innerHTML = `<span style="color:#ef4444;">✗ The answer was <strong>${escapeHtml(targetForm)}</strong></span>`;
        _practiceWrong.push(word);
      }

      revealDiv.style.display = 'block';
      revealDiv.innerHTML = analysis.translation
        ? `<span style="color:var(--brand);font-weight:600;">${escapeHtml(analysis.translation)}</span> — ${escapeHtml(analysis.definitionTranslated || analysis.definition || '')}`
        : escapeHtml(analysis.definition || '');
    }

    checkBtn.onclick = checkAnswer;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') checkAnswer(); });

    btnRow.appendChild(checkBtn);
    btnRow.appendChild(nextBtn);
    btnRow.appendChild(skipBtn);
    fitbCard.appendChild(btnRow);

    const hintRow = document.createElement('div');
    hintRow.style.cssText = 'text-align:center;margin-top:12px;';
    hintRow.appendChild(hintBtn);
    fitbCard.appendChild(hintRow);

    practiceContainer.appendChild(fitbCard);
    input.focus();
  }

});


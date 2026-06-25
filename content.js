// content.js
// NOTE: content.js is a classic (non-module) script — Chrome content scripts cannot
// statically import extension files. The two chrome.storage calls below are the only
// intentional exceptions to the StorageAdapter rule and will be replaced in Phase 2
// when the browser-polyfill shim is added (which exposes a global browser.storage).

// ── Theme cache — loaded once, kept in sync via storage.onChanged ─────────────
let _theme = { brand: '#06b6d4', brand2: '#38bdf8', rgb: '6,182,212', deep: '#0891b2', darkMode: false };

(function loadTheme() {
  chrome.storage.local.get('extension_settings', (result) => {
    const s = result.extension_settings || {};
    _applyThemeCache(s);
  });
  chrome.storage.onChanged.addListener((changes, ns) => {
    if (ns === 'local' && changes.extension_settings) {
      _applyThemeCache(changes.extension_settings.newValue || {});
    }
  });
})();

const THEME_PALETTES = {
  cyan:   { brand: '#06b6d4', brand2: '#38bdf8', rgb: '6,182,212',  deep: '#0891b2' },
  indigo: { brand: '#6366f1', brand2: '#818cf8', rgb: '99,102,241', deep: '#4f46e5' },
  purple: { brand: '#a855f7', brand2: '#c084fc', rgb: '168,85,247', deep: '#9333ea' },
  green:  { brand: '#22c55e', brand2: '#4ade80', rgb: '34,197,94',  deep: '#16a34a' },
};

function _hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return `${Math.round(f(0)*255)},${Math.round(f(8)*255)},${Math.round(f(4)*255)}`;
}

function _applyThemeCache(settings) {
  if (settings.accentHue !== undefined) {
    const hue = settings.accentHue;
    _theme = {
      brand: `hsl(${hue}, 85%, 55%)`,
      brand2: `hsl(${hue}, 85%, 65%)`,
      rgb: _hslToRgb(hue, 85, 55),
      deep: `hsl(${hue}, 85%, 40%)`,
      darkMode: !!settings.darkMode
    };
    return;
  }
  const p = THEME_PALETTES[settings.theme] || THEME_PALETTES.cyan;
  _theme = { ...p, darkMode: !!settings.darkMode };
}

// Track the auto-close timer so loading → full transitions can reset it cleanly
let _autoCloseTimer = null;

// ── Text-selection floating popup ─────────────────────────────────────────────
let _selectionPopup = null;

function _hideSelectionPopup() {
  if (_selectionPopup) { _selectionPopup.remove(); _selectionPopup = null; }
}

function _showSelectionPopup(text) {
  _hideSelectionPopup();
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();

  const popup = document.createElement('div');
  popup.id = 'll-selection-popup';
  // Position above selection; drop below if near top of viewport
  const above = rect.top > 52;
  const top = above ? rect.top - 44 : rect.bottom + 8;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - 72, window.innerWidth - 152));
  popup.style.cssText = `
    position:fixed;top:${top}px;left:${left}px;z-index:2147483647;
    background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
    border:1px solid rgba(255,255,255,0.5);border-radius:10px;
    box-shadow:0 4px 20px rgba(0,0,0,0.15);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    animation:ll-slideUp 0.1s ease-out;
  `;

  // Inject keyframe once
  if (!document.getElementById('ll-selection-style')) {
    const s = document.createElement('style');
    s.id = 'll-selection-style';
    s.textContent = `@keyframes ll-slideUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`;
    document.head.appendChild(s);
  }

  const btn = document.createElement('button');
  btn.textContent = '📖 Define & Save';
  btn.style.cssText = `
    display:block;background:linear-gradient(135deg,${_theme.brand},${_theme.brand2});
    color:#fff;border:none;padding:8px 14px;border-radius:8px;
    font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;
    white-space:nowrap;transition:opacity 0.15s;
  `;
  btn.onmouseenter = () => { btn.style.opacity = '0.88'; };
  btn.onmouseleave = () => { btn.style.opacity = '1'; };
  btn.onclick = (e) => {
    e.stopPropagation();
    _hideSelectionPopup();
    handleContextExtraction(text);
  };

  popup.appendChild(btn);
  document.body.appendChild(popup);
  _selectionPopup = popup;
}

// Show floating button when user finishes selecting text
document.addEventListener('mouseup', (e) => {
  // Small delay lets the browser finalize the selection
  setTimeout(() => {
    // Ignore clicks inside our own UI elements
    if (e.target.closest?.('#ll-selection-popup') || e.target.closest?.('#ll-popup-host')) return;
    const text = window.getSelection()?.toString().trim();
    if (text && text.length >= 2 && text.length <= 80) {
      _showSelectionPopup(text);
    } else {
      _hideSelectionPopup();
    }
  }, 10);
});

// Dismiss on click outside or scroll
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest?.('#ll-selection-popup')) _hideSelectionPopup();
});
document.addEventListener('scroll', _hideSelectionPopup, { passive: true });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractContext") {
    handleContextExtraction(request.selectionText);
  } else if (request.action === "showDefinitionPopup") {
    showDefinitionPopup(request.data);
  }
});

function handleContextExtraction(selectionText) {
  // Guard: extension context becomes stale after service worker reload/update.
  // Check before doing any work to avoid a "Looking up..." toast followed by an error toast.
  try {
    if (!chrome.runtime?.id) {
      showToast('Extension reloaded — please refresh the page.');
      return;
    }
  } catch {
    showToast('Extension reloaded — please refresh the page.');
    return;
  }

  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  
  // Get the full text content of the block element
  let fullText = "";
  if (container.nodeType === Node.TEXT_NODE) {
    fullText = container.parentElement.textContent;
  } else {
    fullText = container.textContent;
  }

  // Clean up whitespace
  fullText = fullText.replace(/\s+/g, ' ').trim();

  // Extract the specific sentence containing the selection
  const context = extractSentence(fullText, selectionText);

  const data = {
    text: selectionText,
    context: context,
    url: window.location.href,
    title: document.title,
    timestamp: Date.now()
  };

  showToast(`Looking up "${selectionText}"...`);
  
  try {
    chrome.runtime.sendMessage({
      action: "lookupAndSave",
      data: data
    });
  } catch (err) {
    console.error("Failed to send message:", err);
    showToast("Error: Extension context invalidated. Please reload the page.");
  }
}

function extractSentence(fullText, target) {
  if (!fullText || !target) return fullText;

  // Modern sentence segmentation
  if ('Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    const segments = segmenter.segment(fullText);
    for (const segment of segments) {
      if (segment.segment.includes(target)) {
        return segment.segment.trim();
      }
    }
  }

  const sentences = fullText.match(/[^\.!\?]+[\.!\?]+/g) || [fullText];
  const found = sentences.find(s => s.includes(target));
  return found ? found.trim() : fullText;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.position = 'fixed';
  toast.style.bottom = '20px';
  toast.style.right = '20px';
  toast.style.backgroundColor = '#2c3e50';
  toast.style.color = 'white';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '4px';
  toast.style.zIndex = '10000';
  toast.style.fontFamily = 'Segoe UI, sans-serif';
  toast.style.opacity = '1';
  toast.style.transition = 'opacity 0.3s';
  toast.id = 'll-toast';

  // Remove existing
  const existing = document.getElementById('ll-toast');
  if (existing) existing.remove();

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Intentional duplicate of utils/dom-utils.js:escapeHtml.
// content.js is a classic (non-module) script. The adapter is used by all other files;
// the two chrome.storage calls in the theme IIFE above are the only exception (Phase 2 will fix them).
// Keep in sync with dom-utils.js until a build step is introduced.
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showDefinitionPopup(data) {
    // Remove toast
    const toast = document.getElementById('ll-toast');
    if (toast) toast.remove();

    // Reuse existing host if present (loading → full transition updates in place)
    let host = document.getElementById('ll-popup-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'll-popup-host';
        host.style.position = 'fixed';
        host.style.bottom = '24px';
        host.style.right = '24px';
        host.style.zIndex = '2147483647';
        document.body.appendChild(host);
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });

    // Loading skeleton — shown immediately while API call is in-flight
    if (data.loading) {
        const safeWord = escapeHtml(data.text);
        shadow.innerHTML = `
          <style>
            .popup{color-scheme:light;width:320px;background:rgba(255,255,255,0.75);backdrop-filter:blur(16px);
              -webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.35);border-radius:18px;
              box-shadow:0 12px 30px rgba(0,0,0,0.12);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
              overflow:hidden;animation:slideIn 0.12s ease-out;}
            @keyframes slideIn{from{transform:scale(0.98);opacity:0}to{transform:scale(1);opacity:1}}
            .header{background:linear-gradient(135deg,rgba(${_theme.rgb},0.11),rgba(90,124,255,0.07));
              border-bottom:1px solid rgba(255,255,255,0.5);padding:12px 16px;
              display:flex;justify-content:space-between;align-items:center;}
            .header-label{font-size:11px;font-weight:700;color:${_theme.brand};text-transform:uppercase;letter-spacing:0.08em;}
            .close-btn{background:rgba(${_theme.rgb},0.09);border:none;color:${_theme.brand};font-size:16px;
              cursor:pointer;width:26px;height:26px;display:flex;align-items:center;justify-content:center;
              border-radius:7px;line-height:1;transition:background 0.15s;}
            .content{padding:16px;}
            .word{font-size:22px;font-weight:700;background:linear-gradient(135deg,${_theme.brand},${_theme.brand2});
              -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:10px;}
            .shimmer{height:12px;border-radius:6px;background:linear-gradient(90deg,#e2e8f0 25%,#f1f5f9 50%,#e2e8f0 75%);
              background-size:200% 100%;animation:shimmer 1.4s infinite;margin-bottom:8px;}
            @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
            ${_theme.darkMode ? '.popup{background:rgba(15,23,42,0.88)!important;border-color:rgba(255,255,255,0.1)!important;}' : ''}
          </style>
          <div class="popup">
            <div class="header">
              <span class="header-label">Definition</span>
              <button class="close-btn">&times;</button>
            </div>
            <div class="content">
              <div class="word">${safeWord}</div>
              <div class="shimmer" style="width:60%"></div>
              <div class="shimmer" style="width:90%"></div>
              <div class="shimmer" style="width:75%"></div>
            </div>
          </div>
        `;
        shadow.querySelector('.close-btn').onclick = () => { host.remove(); clearTimeout(_autoCloseTimer); };
        return; // No auto-close for loading state — full data call will set the timer
    }

    const analysis = data.aiAnalysis || {};
    const hasError = !!analysis.error;
    const isErrorPos = analysis.partOfSpeech === 'Error';
    const alreadySaved = !!data.alreadySaved;

    // Escape all values sourced from user selection or AI responses before innerHTML use
    const safeWord = escapeHtml(data.text);
    const safePhonetic = escapeHtml(analysis.pronunciation);
    const safePos = escapeHtml(analysis.partOfSpeech || 'Unknown');
    const safeTranslation = escapeHtml(analysis.translation);
    const safeDefinitionTranslated = escapeHtml(analysis.definitionTranslated);
    const safeDefinition = escapeHtml(analysis.definition);
    const safeExample = escapeHtml(analysis.exampleSentence);
    const safeExampleTranslated = escapeHtml(analysis.exampleSentenceTranslated);
    const safeError = escapeHtml(analysis.error);

    shadow.innerHTML = `
      <style>
        /* Glassmorphism popup — matches dashboard design system */
        .popup {
          color-scheme: light;
          width: 320px;
          background: rgba(255,255,255,0.75);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255,255,255,0.35);
          border-radius: 18px;
          box-shadow: 0 12px 30px rgba(0,0,0,0.12);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          overflow: hidden;
          animation: slideIn 0.12s ease-out;
        }
        @keyframes slideIn {
          from { transform: scale(0.98); opacity: 0; }
          to   { transform: scale(1); opacity: 1; }
        }
        .header {
          background: linear-gradient(135deg, rgba(6,182,212,0.11), rgba(90,124,255,0.07));
          border-bottom: 1px solid rgba(255,255,255,0.5);
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .header-label {
          font-size: 11px;
          font-weight: 700;
          color: #06b6d4;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .close-btn {
          background: rgba(6,182,212,0.09);
          border: none;
          color: #06b6d4;
          font-size: 16px;
          cursor: pointer;
          width: 26px;
          height: 26px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 7px;
          line-height: 1;
          transition: background 0.15s;
        }
        .close-btn:hover { background: rgba(6,182,212,0.18); }
        .content { padding: 16px; }
        .word-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 4px;
        }
        .word {
          font-size: 22px;
          font-weight: 700;
          /* gradient accent only on the focal word title */
          background: linear-gradient(135deg, #06b6d4, #38bdf8);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          letter-spacing: -0.3px;
          line-height: 1.2;
        }
        .phonetic {
          color: #94a3b8;
          font-family: monospace;
          font-size: 13px;
          margin-bottom: 12px;
        }
        .pos {
          display: inline-block;
          background: rgba(6,182,212,0.08);
          border: 1px solid rgba(6,182,212,0.18);
          padding: 2px 9px;
          border-radius: 999px;
          font-size: 11px;
          text-transform: uppercase;
          color: #0891b2;
          font-weight: 700;
          letter-spacing: 0.04em;
          white-space: nowrap;
          flex-shrink: 0;
          margin-top: 4px;
        }
        .divider {
          border: none;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(6,182,212,0.35), transparent);
          margin: 10px 0 12px;
        }
        /* Translation word — compact accent chip */
        .translation {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: #06b6d4;
          font-weight: 700;
          font-size: 15px;
          margin-bottom: 8px;
          line-height: 1.3;
        }
        .translation-icon { font-size: 13px; opacity: 0.75; }
        /* Native-language definition — most important, reads first */
        .definition-native {
          font-size: 14px;
          line-height: 1.6;
          color: #1e293b;
          white-space: pre-line;
          margin-bottom: 10px;
        }
        /* English definition — secondary, dimmer, for learning reference */
        .en-label {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #94a3b8;
          margin-bottom: 4px;
        }
        .definition {
          font-size: 13px;
          line-height: 1.55;
          color: #64748b;
          white-space: pre-line;
          margin-bottom: 10px;
        }
        .example-block {
          padding-top: 8px;
          border-top: 1px solid rgba(226,232,240,0.6);
        }
        .example {
          font-size: 12px;
          color: #6b7280;
          font-style: italic;
          line-height: 1.5;
          margin-bottom: 3px;
        }
        .example-translated {
          font-size: 12px;
          color: #94a3b8;
          line-height: 1.5;
        }
        .error-pos { background: #ffebee !important; color: #c62828 !important; }
        .error-def { color: #c62828; }
        .error-detail { font-size: 11px; color: #aaa; margin-top: 6px; }
        .footer {
          border-top: 1px solid rgba(6,182,212,0.1);
          background: rgba(6,182,212,0.04);
          padding: 10px 16px;
          font-size: 12px;
          font-weight: 500;
          display: flex;
          align-items: center;
        }
        .footer.success  { background: rgba(34,197,94,0.1); color: #16a34a; }
        .footer.error    { background: rgba(239,68,68,0.08); color: #dc2626; }
        .footer.already  { background: rgba(6,182,212,0.08); color: #0891b2; }
        .check { margin-right: 6px; font-size: 14px; }
        /* ── Live theme overrides (injected at render time) ── */
        .word { background: linear-gradient(135deg,${_theme.brand},${_theme.brand2}) !important; -webkit-background-clip: text !important; background-clip: text !important; -webkit-text-fill-color: transparent !important; }
        .pos { background: rgba(${_theme.rgb},0.08) !important; border-color: rgba(${_theme.rgb},0.18) !important; color: ${_theme.deep} !important; }
        .translation { color: ${_theme.brand} !important; }
        .definition-native { color: ${_theme.darkMode ? '#e2e8f0' : '#1e293b'} !important; }
        .header { background: linear-gradient(135deg,rgba(${_theme.rgb},0.11),rgba(${_theme.rgb},0.05)) !important; }
        .header-label,.close-btn { color: ${_theme.brand} !important; }
        .divider { background: linear-gradient(90deg,transparent,rgba(${_theme.rgb},0.35),transparent) !important; }
        ${_theme.darkMode ? `
        .popup { background: rgba(15,23,42,0.88) !important; border-color: rgba(255,255,255,0.1) !important; }
        .definition { color: #94a3b8 !important; }
        .phonetic,.example,.example-translated { color: #475569 !important; }
        .example-block { border-top-color: rgba(255,255,255,0.08) !important; }
        .en-label { color: #475569 !important; }
        ` : ''}
      </style>
      <div class="popup">
        <div class="header">
          <span class="header-label">Definition</span>
          <button class="close-btn">&times;</button>
        </div>
        <div class="content">
          <div class="word-row">
            <div class="word">${safeWord}</div>
            <div class="pos ${isErrorPos ? 'error-pos' : ''}">${safePos}</div>
          </div>
          <div class="phonetic">${safePhonetic}</div>
          <hr class="divider" />
          ${safeTranslation ? `<div class="translation"><span class="translation-icon">🌐</span>${safeTranslation}</div>` : ''}
          ${safeDefinitionTranslated ? `<div class="definition-native ${isErrorPos ? 'error-def' : ''}">${safeDefinitionTranslated}</div>` : ''}
          ${safeDefinition ? `<div class="en-label">English</div><div class="definition ${isErrorPos ? 'error-def' : ''}">${safeDefinition}</div>` : ''}
          ${safeExample ? `
          <div class="example-block">
            <div class="example">"${safeExample}"</div>
            ${safeExampleTranslated ? `<div class="example-translated">"${safeExampleTranslated}"</div>` : ''}
          </div>` : ''}
          ${safeError ? `<div class="error-detail">Details: ${safeError}</div>` : ''}
        </div>
        <div class="footer ${hasError ? 'error' : alreadySaved ? 'already' : 'success'}">
          <span class="check">${hasError ? '✗' : alreadySaved ? '★' : '✓'}</span>
          ${hasError ? 'Could not save word' : alreadySaved ? 'Already in your vocabulary' : 'Saved to Dashboard'}
        </div>
      </div>
    `;

    shadow.querySelector('.close-btn').onclick = () => { host.remove(); clearTimeout(_autoCloseTimer); };

    // Reset auto-close on each update (loading → full clears the old timer)
    clearTimeout(_autoCloseTimer);
    _autoCloseTimer = setTimeout(() => {
        if (document.body.contains(host)) host.remove();
    }, 15000);
}

// Initialize YouTube Handler
(async () => {
  if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be')) {
    // Guard: skip if extension context is already invalidated (e.g. after reload)
    try { if (!chrome.runtime?.id) return; } catch { return; }
    try {
      const src = chrome.runtime.getURL('utils/youtube-handler.js');
      const { YouTubeHandler } = await import(src);
      const handler = new YouTubeHandler();
      handler.init();
    } catch (e) {
      if (!e.message?.includes('Extension context invalidated'))
        console.error("Language Learning: Failed to load YouTube handler", e);
    }
  }
})();

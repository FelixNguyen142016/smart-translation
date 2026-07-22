// popup.js — Floating translate popup renderer (ES module)
// Receives a word from main process, calls /v1/analyze/fast + /translate, renders the result.

import { BACKEND_URL } from './api.js';
import { escapeHtml as escHtml } from './dom-utils.js';
import { speakText } from './audio-utils.js';

let _currentWord = null;
let _currentAnalysis = null;
let _token = null; // received with each analyze-word message from main process

// Bumped on every onAnalyzeWord call. The popup window is reused across
// searches, so an in-flight fetch from a previous word (especially the
// second leg of the two-step analyze/translate flow below) must not be
// allowed to overwrite the DOM or _currentAnalysis once a newer word has
// been requested. Callbacks compare their captured id against this before
// touching anything.
let _requestSeq = 0;

// ── Apply dark/light theme from shared settings ──────────────────────────────
(function applyTheme() {
  try {
    const settings = JSON.parse(localStorage.getItem('extension_settings') || '{}');
    if (settings.darkMode) {
      document.documentElement.classList.add('dark');
    }
  } catch (_) { /* ignore parse errors */ }
})();

// ── DOM refs ────────────────────────────────────────────────────────────────
const content = document.getElementById('content');
const footer  = document.getElementById('footer');

document.getElementById('close-btn').addEventListener('click', () => {
  window.electronAPI.closePopup();
});

// Trim + strip non-printable-ASCII before a token is ever used to build an
// `Authorization` header. A header value containing control characters,
// stray newlines, or non-Latin1 bytes makes WebKit's fetch() throw
// "TypeError: Failed to execute 'fetch' ... The string did not match the
// expected pattern" — this was reaching the user as "Could not fetch
// definition" with no indication it was actually a bad token, not a bad word.
function sanitizeToken(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/[^\x20-\x7E]/g, '');
  return cleaned.length ? cleaned : null;
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(_token ? { 'Authorization': `Bearer ${_token}` } : {}),
  };
}

// Safety net: if the popup window opens but never receives word data at all
// (the popup_ready/analyze-word IPC handoff silently fails — seen on Windows
// when this window is created immediately after another one closes), the
// user would otherwise stare at a permanently blank window with no error and
// no way to recover, especially in a release build with DevTools disabled.
// If nothing has arrived a few seconds after this script starts, show a
// visible error instead. Cleared the moment real data shows up.
let _gotFirstDispatch = false;
setTimeout(() => {
  if (!_gotFirstDispatch) {
    console.error('Popup received no word data within 5s of loading — IPC handoff likely failed.');
    renderError('', 'Semantica couldn’t load this word. Close this popup and try again.');
  }
}, 5000);

// ── Receive word from main process ──────────────────────────────────────────
window.electronAPI.onAnalyzeWord(async (word, token, savedData, wotd) => {
  _gotFirstDispatch = true;
  const requestId = ++_requestSeq;
  _currentWord = word;
  _currentAnalysis = null;
  const lsToken = localStorage.getItem('cloud_auth_token');
  _token = sanitizeToken(token) || sanitizeToken(lsToken);

  // Word of the Day — dedicated hero layout, rendered from saved data
  if (wotd && savedData?.aiAnalysis) {
    _currentAnalysis = savedData.aiAnalysis;
    renderWotd(word, savedData.aiAnalysis);
    return;
  }

  // Word already in vocab dashboard — render instantly, no API call needed
  if (savedData?.aiAnalysis) {
    _currentAnalysis = savedData.aiAnalysis;
    renderResult(word, savedData.aiAnalysis, /* alreadySaved */ true);
    return;
  }

  showLoading(word);

  const targetLanguage = 'Vietnamese'; // fixed: Semantica is English → Vietnamese

  try {
    // Step 1 — fast: English content (definition, POS, phonetic, example)
    // without waiting for translation. If the word+language was already
    // fully cached, `complete` comes back true and there's nothing left to do.
    const fastRes = await fetch(`${BACKEND_URL}/v1/analyze/fast`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: word, context: '', targetLanguage }),
    });
    const fastData = await fastRes.json();
    if (!fastRes.ok) throw new Error(fastData.error || 'Analysis failed');

    if (requestId !== _requestSeq) return; // a newer word came in while this was in flight

    _currentAnalysis = fastData;
    renderResult(word, fastData, false, /* pendingTranslation */ !fastData.complete);

    if (fastData.complete) return; // translation was already included

    // Step 2 — translate: patches Vietnamese translation/definition/example
    // in once DeepL (or its Claude fallback) finishes. English content is
    // already on screen and already saveable, so a failure here degrades to
    // "no translation yet" rather than failing the whole lookup.
    try {
      const transRes = await fetch(`${BACKEND_URL}/v1/analyze/translate`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: word, targetLanguage }),
      });
      const transData = await transRes.json();
      if (!transRes.ok) throw new Error(transData.error || 'Translation failed');

      if (requestId !== _requestSeq) return; // stale — dropped

      _currentAnalysis = { ..._currentAnalysis, ...transData };
      patchTranslation(transData);
    } catch (transErr) {
      console.error('Popup translation patch failed:', transErr);
    }
  } catch (err) {
    if (requestId !== _requestSeq) return; // stale — a newer word already took over the popup

    // TypeError here means fetch() itself never got a response — a network
    // failure, a blocked/malformed request, or (formerly) a bad Authorization
    // header. Anything else is an application-level error already carrying a
    // useful message (e.g. from `throw new Error(data.error || ...)` above).
    const message = err instanceof TypeError
      ? 'Could not reach the Semantica server. Check your connection and try again.'
      : err.message;
    console.error('Popup analyze-word failed:', err);
    renderError(word, message);
  }
});

// ── Render: loading shimmer ─────────────────────────────────────────────────
function showLoading(word) {
  content.innerHTML = `
    <div style="font-size:20px;font-weight:700;background:linear-gradient(135deg,#06b6d4,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px;">${escHtml(word)}</div>
    <div class="shimmer" style="width:30%;height:10px;margin-bottom:14px;"></div>
    <div class="shimmer" style="width:55%;height:14px;margin-bottom:8px;"></div>
    <div class="shimmer" style="width:95%;"></div>
    <div class="shimmer" style="width:80%;"></div>
    <div class="shimmer" style="width:70%;"></div>
  `;
  footer.style.display = 'none';
}

// ── Render: full result ─────────────────────────────────────────────────────
// Fresh results (alreadySaved = false, meaning the first network answer just
// landed) cascade in top to bottom via .reveal-item wrappers: word → phonetic →
// translation/native definition → English definition → example. Already-known
// results (cached / already-saved instant renders) skip the wave entirely —
// there was no wait to smooth over, so animating them would just be a delay.
//
// `pendingTranslation` is true for the two-step flow's first paint (English
// content is in, translation is still on its way via /v1/analyze/translate):
// the translation/native-definition slot gets a small shimmer placeholder
// instead of being empty, and always carries a stable id (#meaning-slot) so
// patchTranslation() can find and fill it in-place when the real data lands —
// without re-rendering (and re-animating) everything else on the card.
function renderResult(word, a, alreadySaved = false, pendingTranslation = false) {
  const safeWord       = escHtml(word);
  const safePos        = escHtml(a.partOfSpeech || '');
  const safePhonetic   = escHtml(a.pronunciation || '');
  const safeTrans      = escHtml(a.translation || '');
  const safeNativeDef  = escHtml(a.definitionTranslated || '');
  const safeDef        = escHtml(a.definition || '');
  const safeEx         = escHtml(a.exampleSentence || '');
  const safeExTrans    = escHtml(a.exampleSentenceTranslated || '');

  // "Already in dashboard" badge shown when opened from search bar
  const savedBadge = alreadySaved
    ? `<div style="display:inline-flex;align-items:center;gap:5px;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);color:#0891b2;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;margin-bottom:8px;">✓ Already in your dashboard</div>`
    : '';

  const wordBlock = `
    <div class="word-row">
      <div class="word">${safeWord}</div>
      <div class="word-actions">
        ${safePos ? `<div class="pos">${safePos}</div>` : ''}
        <button class="speaker-btn" id="speaker-btn" type="button" title="Listen" aria-label="Listen to pronunciation">🔊</button>
      </div>
    </div>`;
  const phoneticBlock = safePhonetic ? `<div class="phonetic">${safePhonetic}</div>` : '';
  const hasMeaning = !!(safeTrans || safeNativeDef);
  const meaningBlock = hasMeaning
    ? (safeTrans ? `<div class="translation"><span class="translation-icon">🌐</span>${safeTrans}</div>` : '') +
      (safeNativeDef ? `<div class="definition-native">${safeNativeDef}</div>` : '')
    : (pendingTranslation
        ? `<div class="shimmer" style="width:55%;height:15px;margin-bottom:7px;"></div><div class="shimmer" style="width:88%;height:13px;margin-bottom:9px;"></div>`
        : '');
  const enDefBlock = safeDef ? `<div class="en-label">English</div><div class="definition">${safeDef}</div>` : '';
  const exampleBlock = safeEx ? `
      <div class="example-block">
        <div class="example">"${safeEx}"</div>
        ${safeExTrans ? `<div class="example-translated">"${safeExTrans}"</div>` : ''}
      </div>` : '';

  const animate = !alreadySaved;
  const wave = (html, stage) => (animate && html)
    ? `<div class="reveal-item" style="animation-delay:${stage * 70}ms">${html}</div>`
    : html;

  content.innerHTML = `
    ${savedBadge}
    ${wave(wordBlock, 0)}
    ${wave(phoneticBlock, 1)}
    <hr class="divider" />
    <div id="meaning-slot">${wave(meaningBlock, 2)}</div>
    ${wave(enDefBlock, 3)}
    ${wave(exampleBlock, 4)}
  `;

  // Google TTS audio (a.audioBase64) plays if present; speakText() falls
  // back to the Web Speech API on its own if it isn't, so the button always
  // works regardless of whether the TTS call succeeded for this word.
  const speakerBtn = content.querySelector('#speaker-btn');
  if (speakerBtn) speakerBtn.addEventListener('click', () => speakText(word, a.audioBase64));

  renderFooter(alreadySaved ? 'already' : 'idle');
}

// ── Patch: translation arrives after the fact (two-step flow, step 2) ──────
function patchTranslation(a) {
  const slot = document.getElementById('meaning-slot');
  if (!slot) return; // popup has since moved on to something else

  const safeTrans     = escHtml(a.translation || '');
  const safeNativeDef = escHtml(a.definitionTranslated || '');
  const html =
    (safeTrans ? `<div class="translation"><span class="translation-icon">🌐</span>${safeTrans}</div>` : '') +
    (safeNativeDef ? `<div class="definition-native">${safeNativeDef}</div>` : '');
  if (!html) return; // translation genuinely came back empty — leave the slot blank

  slot.innerHTML = `<div class="reveal-item" style="animation-delay:0ms">${html}</div>`;
}

// ── Render: error state ─────────────────────────────────────────────────────
function renderError(word, message) {
  content.innerHTML = `
    <div class="word">${escHtml(word)}</div>
    <hr class="divider" />
    <div class="error-text">Could not fetch definition.<br><small style="color:#9ca3af">${escHtml(message)}</small></div>
  `;
  footer.style.display = 'none';
}

// ── Footer / save button ────────────────────────────────────────────────────
function renderFooter(state, message) {
  footer.style.display = 'flex';
  footer.innerHTML = '';

  if (state === 'saved') {
    footer.innerHTML = `<span class="footer-status saved">✓ Saved to vocabulary</span>`;
    return;
  }
  if (state === 'already') {
    footer.innerHTML = `<span class="footer-status already">★ Already in your vocabulary</span>`;
    return;
  }
  if (state === 'error') {
    footer.innerHTML = `<span class="footer-status error">✗ ${escHtml(message || 'Save failed')}</span>`;
    return;
  }

  // idle — show save button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-btn';
  saveBtn.textContent = 'Save to Vocabulary';
  saveBtn.addEventListener('click', handleSave);

  const hint = document.createElement('span');
  hint.style.cssText = 'font-size:11px;color:#94a3b8';
  hint.textContent = 'Click to save';

  footer.appendChild(hint);
  footer.appendChild(saveBtn);
}

async function handleSave() {
  if (!_currentAnalysis || !_currentWord) return;
  try {
    const token = _token;
    if (!token) { renderFooter('error', 'Not logged in'); return; }

    const record = {
      // Stored lowercase so casing typos/inconsistencies never create
      // duplicate-looking vocab entries; the dashboard's pencil-edit lets the
      // user restore original capitalization (proper nouns, acronyms, etc.).
      text: (_currentAnalysis.baseForm || _currentWord).toLowerCase(),
      context: '',
      url: '',
      title: '',
      timestamp: Date.now(),
      videoId: '',
      videoTime: 0,
      aiAnalysis: _currentAnalysis,
      learningState: 'new',
      stats: { seen: 0, correct: 0, skipped: 0, consecutiveCorrect: 0 },
    };

    // Single-record append: the server does the read-modify-write and the
    // duplicate check (against both text and baseForm) in one request, so a
    // save here can't clobber a concurrent full-list write from the dashboard
    // with a stale copy — and the payload is one record, not the whole vocab.
    const postRes = await fetch(`${BACKEND_URL}/v1/vocab/word`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ record }),
    });

    if (!postRes.ok) throw new Error('Save failed');
    const result = await postRes.json();
    renderFooter(result.added ? 'saved' : 'already');
  } catch (err) {
    const message = err instanceof TypeError
      ? 'Could not reach the Semantica server.'
      : err.message;
    console.error('Popup save failed:', err);
    renderFooter('error', message);
  }
}

// ── Word of the Day — hero layout ───────────────────────────────────────────
function renderWotd(word, a) {
  document.body.classList.add('wotd');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  // The definition may be a numbered multi-meaning list — split into rows
  const defs = String(a.definition || '')
    .split('\n')
    .map(d => d.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  const dots = [[18, 14], [72, 28], [88, 60], [12, 72], [55, 85], [92, 18]]
    .map(([x, y]) => `<div class="wotd-dot" style="left:${x}%;top:${y}%"></div>`).join('');

  content.innerHTML = `
    <div class="wotd-hero">
      <div class="wotd-orb1"></div><div class="wotd-orb2"></div>${dots}
      <div class="wotd-topbar">
        <span class="wotd-badge">★ Word of the Day</span>
        <button class="wotd-close" id="wotd-close">×</button>
      </div>
      <div class="wotd-date">${today}</div>
      <div class="wotd-wordrow">
        <div class="wotd-word">${escHtml(word)}</div>
        <div class="wotd-actions-inline">
          ${a.partOfSpeech ? `<span class="wotd-pos">${escHtml(a.partOfSpeech)}</span>` : ''}
          <button class="wotd-speaker" id="wotd-speaker-btn" type="button" title="Listen" aria-label="Listen to pronunciation">🔊</button>
        </div>
      </div>
      ${a.pronunciation ? `<div class="wotd-phon">${escHtml(a.pronunciation)}</div>` : ''}
      ${a.translation ? `<div class="wotd-trans">${escHtml(a.translation)}</div>` : ''}
    </div>
    <div class="wotd-body">
      ${a.definitionTranslated ? `<div class="wotd-nativedef">${escHtml(a.definitionTranslated)}</div>` : ''}
      ${defs.length ? `<div><div class="wotd-en-label">English</div>${
        defs.map((d, i) => `<div class="wotd-def"><span class="wotd-defnum">${i + 1}</span><span>${escHtml(d)}</span></div>`).join('')
      }</div>` : ''}
      <div class="wotd-divider"></div>
      ${a.exampleSentence ? `<div>
        <div class="wotd-ex">"${escHtml(a.exampleSentence)}"</div>
        ${a.exampleSentenceTranslated ? `<div class="wotd-ex-trans">"${escHtml(a.exampleSentenceTranslated)}"</div>` : ''}
      </div>` : ''}
      <div class="wotd-actions">
        <button class="wotd-dismiss" id="wotd-dismiss">Dismiss for today</button>
        <span class="wotd-saved-chip">★ In your vocabulary</span>
      </div>
    </div>`;
  footer.style.display = 'none';
  document.getElementById('wotd-close').addEventListener('click', () => window.electronAPI.closePopup());
  document.getElementById('wotd-dismiss').addEventListener('click', () => window.electronAPI.closePopup());
  document.getElementById('wotd-speaker-btn')?.addEventListener('click', () => speakText(word, a.audioBase64));
}

// popup.js — Floating translate popup renderer
// Receives a word from main process, calls /v1/analyze, renders the result.

const BACKEND_URL = 'https://smart-translation-api.fukumakino613.workers.dev';

let _currentWord = null;
let _currentAnalysis = null;
let _token = null; // received with each analyze-word message from main process

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

// ── Receive word from main process ──────────────────────────────────────────
window.electronAPI.onAnalyzeWord(async (word, token, savedData, wotd) => {
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

  // Offline dictionary hit — instant first paint while the AI call runs
  const localSenses = lookupLocal(word);
  if (localSenses?.length) {
    renderLocalResult(word, localSenses);
  } else {
    showLoading(word);
  }

  try {
    const targetLanguage = 'Vietnamese'; // fixed: Semantica is English → Vietnamese

    const res = await fetch(`${BACKEND_URL}/v1/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(_token ? { 'Authorization': `Bearer ${_token}` } : {}),
      },
      body: JSON.stringify({ text: word, context: '', targetLanguage }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    _currentAnalysis = data;
    renderResult(word, data, false);
  } catch (err) {
    // Local entry rendered + API failed: keep the offline result and let the
    // user save it with a minimal analysis built from the local sense.
    if (localSenses?.length) {
      const first = localSenses[0];
      _currentAnalysis = {
        definition: first.def,
        exampleSentence: first.ex || '',
        partOfSpeech: first.pos || '',
        pronunciation: first.phon || '',
        source: 'local-dictionary',
      };
      renderResult(word, _currentAnalysis, false);
      return;
    }
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

// ── Offline dictionary (instant first paint) ────────────────────────────────
let _localDict = null;
fetch('./local-dictionary.json')
  .then(r => r.json())
  .then(d => { _localDict = d; })
  .catch(() => { _localDict = {}; });

function lookupLocal(word) {
  if (!_localDict || !word) return null;
  const w = word.trim().toLowerCase();
  if (_localDict[w]) return _localDict[w];
  // Cheap inflection guesses: running → run, studies → study, walked → walk …
  const candidates = [];
  if (w.endsWith('ies') && w.length > 4) candidates.push(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) candidates.push(w.slice(0, -2));
  if (w.endsWith('s'))  candidates.push(w.slice(0, -1));
  if (w.endsWith('ing') && w.length > 5) {
    candidates.push(w.slice(0, -3), w.slice(0, -3) + 'e');
    if (w.length > 6 && w[w.length - 4] === w[w.length - 5]) candidates.push(w.slice(0, -4));
  }
  if (w.endsWith('ed') && w.length > 4) {
    candidates.push(w.slice(0, -2), w.slice(0, -1));
    if (w.length > 5 && w[w.length - 3] === w[w.length - 4]) candidates.push(w.slice(0, -3));
  }
  for (const c of candidates) if (_localDict[c]) return _localDict[c];
  return null;
}

// Local senses + shimmer where the translation will appear
function renderLocalResult(word, senses) {
  const first = senses[0];
  const posLine = [first.pos, first.cefr].filter(Boolean).join(' · ');
  content.innerHTML = `
    <div class="word-row">
      <div class="word">${escHtml(word)}</div>
      ${posLine ? `<div class="pos">${escHtml(posLine)}</div>` : ''}
    </div>
    ${first.phon ? `<div class="phonetic">${escHtml(first.phon)}</div>` : ''}
    <hr class="divider" />
    <div class="shimmer" style="width:55%;height:16px;margin-bottom:10px;"></div>
    <div class="en-label">English</div>
    <div class="definition">${escHtml(first.def)}</div>
    ${first.ex ? `
      <div class="example-block">
        <div class="example">"${escHtml(first.ex)}"</div>
      </div>` : ''}
  `;
  footer.style.display = 'none'; // save enabled once the AI analysis lands
}

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
// Fresh results (alreadySaved = false, meaning this just finished loading —
// either the first network answer, or the post-error local-dictionary rescue)
// cascade in top to bottom via .reveal-item wrappers: word → phonetic →
// translation/native definition → English definition → example. Already-known
// results (cached / already-saved instant renders) skip the wave entirely —
// there was no wait to smooth over, so animating them would just be a delay.
function renderResult(word, a, alreadySaved = false) {
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
      ${safePos ? `<div class="pos">${safePos}</div>` : ''}
    </div>`;
  const phoneticBlock = safePhonetic ? `<div class="phonetic">${safePhonetic}</div>` : '';
  const meaningBlock =
    (safeTrans ? `<div class="translation"><span class="translation-icon">🌐</span>${safeTrans}</div>` : '') +
    (safeNativeDef ? `<div class="definition-native">${safeNativeDef}</div>` : '');
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
    ${wave(meaningBlock, 2)}
    ${wave(enDefBlock, 3)}
    ${wave(exampleBlock, 4)}
  `;

  renderFooter(alreadySaved ? 'already' : 'idle');
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

    // Fetch existing vocab, check for duplicates, prepend so newest word is first
    const getRes = await fetch(`${BACKEND_URL}/v1/vocab`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const vocabData = await getRes.json();
    const words = vocabData.data || [];

    // Check duplicates against both the typed word AND the base form we actually
    // save (record.text uses baseForm), so "running" can't duplicate a saved "run"
    const typedLower = _currentWord.toLowerCase();
    const baseLower  = (_currentAnalysis.baseForm || _currentWord).toLowerCase();
    const alreadySaved = words.some(w => {
      const t = w.text?.toLowerCase();
      return t === typedLower || t === baseLower;
    });
    if (alreadySaved) { renderFooter('already'); return; }

    const record = {
      text: _currentAnalysis.baseForm || _currentWord,
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

    words.unshift(record);
    const putRes = await fetch(`${BACKEND_URL}/v1/vocab`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: words }),
    });

    if (!putRes.ok) throw new Error('Save failed');
    renderFooter('saved');
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
        ${a.partOfSpeech ? `<span class="wotd-pos">${escHtml(a.partOfSpeech)}</span>` : ''}
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
}

// ── Util ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

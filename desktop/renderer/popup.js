// popup.js — Floating translate popup renderer
// Receives a word from main process, calls /v1/analyze, renders the result.

const BACKEND_URL = 'https://smart-translation-api.fukumakino613.workers.dev';
const AUTO_CLOSE_MS = 15000;

let _autoCloseTimer = null;
let _currentWord = null;
let _currentAnalysis = null;

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

// ── Receive word from main process ──────────────────────────────────────────
window.electronAPI.onAnalyzeWord(async (word) => {
  _currentWord = word;
  _currentAnalysis = null;
  showLoading(word);
  resetAutoClose();

  try {
    const token = (await window.electronAPI.getToken()) || localStorage.getItem('cloud_auth_token');
    const settings = JSON.parse(localStorage.getItem('extension_settings') || '{}');
    const targetLanguage = settings.targetLanguage || 'Spanish';

    const res = await fetch(`${BACKEND_URL}/v1/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text: word, context: '', targetLanguage }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    _currentAnalysis = data;
    renderResult(word, data);
  } catch (err) {
    renderError(word, err.message);
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
function renderResult(word, a) {
  const safeWord       = escHtml(word);
  const safePos        = escHtml(a.partOfSpeech || '');
  const safePhonetic   = escHtml(a.pronunciation || '');
  const safeTrans      = escHtml(a.translation || '');
  const safeNativeDef  = escHtml(a.definitionTranslated || '');
  const safeDef        = escHtml(a.definition || '');
  const safeEx         = escHtml(a.exampleSentence || '');
  const safeExTrans    = escHtml(a.exampleSentenceTranslated || '');

  content.innerHTML = `
    <div class="word-row">
      <div class="word">${safeWord}</div>
      ${safePos ? `<div class="pos">${safePos}</div>` : ''}
    </div>
    ${safePhonetic ? `<div class="phonetic">${safePhonetic}</div>` : ''}
    <hr class="divider" />
    ${safeTrans ? `<div class="translation"><span class="translation-icon">🌐</span>${safeTrans}</div>` : ''}
    ${safeNativeDef ? `<div class="definition-native">${safeNativeDef}</div>` : ''}
    ${safeDef ? `<div class="en-label">English</div><div class="definition">${safeDef}</div>` : ''}
    ${safeEx ? `
      <div class="example-block">
        <div class="example">"${safeEx}"</div>
        ${safeExTrans ? `<div class="example-translated">"${safeExTrans}"</div>` : ''}
      </div>` : ''}
  `;

  renderFooter('idle');
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
    const token = await window.electronAPI.getToken();
    if (!token) { renderFooter('error', 'Not logged in'); return; }

    // Fetch existing vocab, check for duplicates, prepend so newest word is first
    const getRes = await fetch(`${BACKEND_URL}/v1/vocab`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const vocabData = await getRes.json();
    const words = vocabData.data || [];

    const alreadySaved = words.some(w => w.text?.toLowerCase() === _currentWord.toLowerCase());
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
    renderFooter('error', err.message);
  }
}

// ── Auto-close timer ────────────────────────────────────────────────────────
function resetAutoClose() {
  clearTimeout(_autoCloseTimer);
  _autoCloseTimer = setTimeout(() => {
    window.electronAPI.closePopup();
  }, AUTO_CLOSE_MS);
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

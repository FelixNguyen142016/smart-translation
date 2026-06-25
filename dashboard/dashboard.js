import { getWords, deleteWord, updateWord, getSettings, saveSettings } from '../utils/storage.js';
import { analyzeText, speakText } from '../utils/ai-service.js';
import { initGame } from './game-controller.js';
import { applyTheme, applyHueTheme } from '../utils/theme.js';
import { nextLearningState } from '../utils/game-engine.js';
import { escapeHtml } from '../utils/dom-utils.js';
import { getAdapter } from '../utils/storage-adapter.js';
import { getBackendUrl, getAuthToken, getCloudEmail, setAuthSession, clearAuthSession, isLoggedIn } from '../utils/api-config.js';
import { createApiAdapter } from '../utils/api-storage-adapter.js';

document.addEventListener('DOMContentLoaded', async () => {
  // --- Navigation ---
  const tabs = document.querySelectorAll('.nav-tab');
  const sections = document.querySelectorAll('.view-section');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all
      tabs.forEach(t => t.classList.remove('active'));
      sections.forEach(s => s.classList.remove('active'));

      // Add to current
      tab.classList.add('active');
      document.getElementById(tab.dataset.target).classList.add('active');

      // Refresh data if switching to list, review, game, sentences, or videos
      if (tab.dataset.target === 'list-view') renderWords();
      if (tab.dataset.target === 'review-view') startReviewSession();
      if (tab.dataset.target === 'game-view') initGame();
      if (tab.dataset.target === 'sentences-view') renderSentences();
      if (tab.dataset.target === 'videos-view') renderVideos();
      if (tab.dataset.target === 'account-view') {
        // Trigger sync when user opens Account tab
        getAuthToken().then(t => {
          if (!t) return;
          updateSyncStatus('Syncing…');
          createApiAdapter(t).syncFromCloud()
            .then(() => updateSyncStatus('Last synced: just now'))
            .catch(() => updateSyncStatus('Offline — using local data'));
        });
      }
    });
  });

  // --- Settings Logic ---
  const aiProviderSelect = document.getElementById('ai-provider');
  const targetLangSelect = document.getElementById('target-lang');
  const saveSettingsBtn = document.getElementById('save-settings');
  const saveMsg = document.getElementById('save-msg');

  // Load current settings + apply theme immediately
  const currentSettings = await getSettings();
  // Use hue-based theme when accentHue is stored; legacy palette otherwise
  if (currentSettings.accentHue !== undefined) {
    applyHueTheme(currentSettings.accentHue, currentSettings.darkMode);
  } else {
    applyTheme(currentSettings);
  }
  // Default to 'cloud' if logged in, else 'freedict'
  const loggedIn = await isLoggedIn();
  const defaultProvider = loggedIn ? 'cloud' : 'freedict';
  aiProviderSelect.value = currentSettings.provider || defaultProvider;
  targetLangSelect.value = currentSettings.targetLanguage || 'Spanish';

  // ── Accent hue slider ──
  const hueSlider  = document.getElementById('accent-hue');
  const huePreview = document.getElementById('hue-preview');

  hueSlider.value = currentSettings.accentHue ?? 190;
  updateHuePreview(hueSlider.value);

  // Live-update theme as user drags the slider
  hueSlider.addEventListener('input', () => {
    const hue = parseInt(hueSlider.value, 10);
    applyHueTheme(hue, darkToggle.checked);
    updateHuePreview(hue);
  });

  /** Sync the color dot and slider thumb tint to the chosen hue. */
  function updateHuePreview(hue) {
    const color = `hsl(${hue}, 85%, 55%)`;
    huePreview.style.background  = color;
    hueSlider.style.accentColor  = color;
  }

  // ── Dark mode toggle ──
  const darkToggle = document.getElementById('dark-mode-toggle');
  darkToggle.checked = !!currentSettings.darkMode;
  darkToggle.addEventListener('change', () => {
    applyHueTheme(parseInt(hueSlider.value, 10), darkToggle.checked);
  });

  // Toggle provider description notes
  toggleProviderNote(aiProviderSelect.value);
  aiProviderSelect.addEventListener('change', () => toggleProviderNote(aiProviderSelect.value));

  function toggleProviderNote(provider) {
    document.getElementById('provider-note-cloud').style.display = provider === 'cloud' ? 'block' : 'none';
    document.getElementById('provider-note-free').style.display  = provider === 'freedict' ? 'block' : 'none';
  }

  saveSettingsBtn.addEventListener('click', async () => {
    const newSettings = {
      provider: aiProviderSelect.value,
      targetLanguage: targetLangSelect.value,
      accentHue: parseInt(hueSlider.value, 10),
      darkMode: darkToggle.checked
    };
    await saveSettings(newSettings);
    applyHueTheme(newSettings.accentHue, newSettings.darkMode);
    saveMsg.style.opacity = 1;
    setTimeout(() => { saveMsg.style.opacity = 0; }, 2000);
  });

  // --- Auto-Refresh on Storage Change ---
  // Debounced to collapse rapid bursts (e.g. multiple updateWord calls during a game session)
  // into a single re-render instead of one full table rebuild per round.
  let _renderDebounceTimer = null;
  // Auto-refresh via adapter — portable, no direct chrome.storage
  getAdapter().onChanged((changes) => {
    if (changes['vocabulary_list']) {
      if (!document.querySelector('.edit-def-area') &&
          document.getElementById('list-view').classList.contains('active')) {
        clearTimeout(_renderDebounceTimer);
        _renderDebounceTimer = setTimeout(() => renderWords(), 300);
      }
    }
  });

  // --- Vocabulary List ---
  const tableBody = document.getElementById('word-table-body');
  const emptyState = document.getElementById('empty-state');

  // Load initial
  await renderWords();

  async function renderWords() {
    const words = await getWords();
    tableBody.innerHTML = '';

    if (words.length === 0) {
      emptyState.style.display = 'block';
      document.querySelector('table').style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    document.querySelector('table').style.display = 'table';

    words.forEach(word => {
      const tr = document.createElement('tr');
      
      // Word Column
      const tdWord = document.createElement('td');
      tdWord.className = 'word-col';
      tdWord.innerHTML = `
        <div style="font-size:17px;font-weight:700;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-0.2px;">${escapeHtml(word.text)}</div>
        <button class="btn-icon" title="Listen" style="margin-top:4px;">🔊</button>
      `;
      tdWord.querySelector('button').onclick = (e) => {
        e.stopPropagation();
        speakText(word.text);
      };
      
      // Context/Meaning Column
      const tdContext = document.createElement('td');
      tdContext.className = 'context-col';
      
      const contextDiv = document.createElement('div');
      contextDiv.style.fontStyle = 'italic';
      contextDiv.style.marginBottom = '4px';
      contextDiv.style.color = 'var(--text-muted)';
      contextDiv.textContent = `"${word.context}"`;
      tdContext.appendChild(contextDiv);

      // Jump-to-moment link — shown only for words saved from YouTube
      if (word.videoId) {
        const sourceLink = document.createElement('a');
        sourceLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(word.videoId)}&t=${word.videoTime || 0}`;
        sourceLink.target = '_blank';
        sourceLink.rel = 'noopener noreferrer';
        sourceLink.textContent = `▶ Watch in context`;
        sourceLink.style.cssText = 'display:inline-block;font-size:11px;color:var(--brand);text-decoration:none;margin-bottom:8px;opacity:0.85;';
        sourceLink.onmouseenter = () => { sourceLink.style.textDecoration = 'underline'; sourceLink.style.opacity = '1'; };
        sourceLink.onmouseleave = () => { sourceLink.style.textDecoration = 'none'; sourceLink.style.opacity = '0.85'; };
        tdContext.appendChild(sourceLink);
      }

      const aiResultDiv = document.createElement('div');
      aiResultDiv.className = 'ai-result visible'; // Always visible if exists
      aiResultDiv.id = `ai-result-${encodeURIComponent(word.text)}`;
      
      // Render Definition Block
      const analysis = word.aiAnalysis || {};
      renderDefinitionBlock(aiResultDiv, word, analysis);
      
      tdContext.appendChild(aiResultDiv);

      // Tags Column
      const tdTags = document.createElement('td');
      tdTags.className = 'tags-col';
      if (analysis.tags) {
        analysis.tags.forEach(tag => {
          const tagSpan = document.createElement('span');
          tagSpan.className = 'tag';
          tagSpan.textContent = tag;
          tdTags.appendChild(tagSpan);
        });
      }

      // Actions Column
      const tdActions = document.createElement('td');
      tdActions.className = 'actions-col';
      
      const btnAnalyze = document.createElement('button');
      btnAnalyze.className = 'btn-ghost';
      btnAnalyze.textContent = '↻ Reload';
      btnAnalyze.onclick = () => handleAnalyze(word, aiResultDiv, btnAnalyze);
      
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-icon';
      btnDelete.style.color = '#e74c3c';
      btnDelete.innerHTML = '🗑️';
      btnDelete.title = 'Delete';
      btnDelete.onclick = () => handleDelete(word.text, btnDelete);
      
      tdActions.appendChild(btnAnalyze);
      tdActions.appendChild(btnDelete);
      
      tr.appendChild(tdWord);
      tr.appendChild(tdContext);
      tr.appendChild(tdTags);
      tr.appendChild(tdActions);
      
      tableBody.appendChild(tr);
    });
  }

  function renderDefinitionBlock(container, word, analysis) {
    container.innerHTML = '';

    // ── Meta: POS + pronunciation ──────────────────────────────────────────
    const meta = document.createElement('div');
    meta.style.cssText = 'margin-bottom:6px;font-size:0.85em;color:var(--text-muted)';
    meta.innerHTML = `<strong style="color:var(--text-main)">${escapeHtml(analysis.partOfSpeech || 'Unknown')}</strong>${analysis.pronunciation ? ` &nbsp;${escapeHtml(analysis.pronunciation)}` : ''}`;
    container.appendChild(meta);

    // ── Translation (primary, prominent) ──────────────────────────────────
    if (analysis.translation) {
      const transRow = document.createElement('div');
      transRow.style.cssText = 'color:var(--brand);font-weight:700;font-size:16px;margin-bottom:6px;display:flex;align-items:center;gap:5px';
      transRow.innerHTML = `<span style="opacity:0.75;font-size:13px">🌐</span>${escapeHtml(analysis.translation)}`;
      container.appendChild(transRow);
    }

    // ── Native-language definition (main explanation) ──────────────────────
    if (analysis.definitionTranslated) {
      const nativeDef = document.createElement('div');
      nativeDef.style.cssText = 'font-size:0.95em;line-height:1.6;color:var(--text-main);white-space:pre-line;margin-bottom:8px';
      nativeDef.textContent = analysis.definitionTranslated;
      container.appendChild(nativeDef);
    }

    // ── English definition (secondary, editable) ───────────────────────────
    const enLabel = document.createElement('div');
    enLabel.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:3px';
    enLabel.textContent = 'English';
    container.appendChild(enLabel);

    const defRow = document.createElement('div');
    defRow.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px';

    const defText = document.createElement('div');
    defText.style.cssText = 'font-size:0.9em;color:var(--text-muted);line-height:1.55;white-space:pre-line;flex:1;margin-right:8px';
    defText.textContent = analysis.definition || 'No definition.';

    const editBtn = document.createElement('button');
    editBtn.innerHTML = '✏️';
    editBtn.className = 'btn-icon';
    editBtn.style.fontSize = '12px';
    editBtn.title = 'Edit English definition';

    editBtn.onclick = () => {
      const textarea = document.createElement('textarea');
      textarea.className = 'edit-def-area';
      textarea.value = analysis.definition || '';
      textarea.style.cssText = 'width:100%;font-family:inherit;padding:5px;border:1px solid var(--brand);border-radius:4px';
      textarea.rows = 3;

      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.className = 'btn-primary';
      saveBtn.style.cssText = 'margin-top:5px;font-size:12px;padding:4px 8px';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.className = 'btn-ghost';
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

    // ── Example sentences ─────────────────────────────────────────────────
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
  }

  async function handleDelete(text, btnEl) {
    // Swap button to inline confirmation to avoid blocking confirm() dialog
    const original = btnEl.innerHTML;
    const originalTitle = btnEl.title;
    btnEl.innerHTML = '✓';
    btnEl.title = 'Confirm delete';
    btnEl.style.color = '#e74c3c';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-icon';
    cancelBtn.innerHTML = '✕';
    cancelBtn.title = 'Cancel';
    cancelBtn.style.marginLeft = '4px';

    btnEl.parentNode.insertBefore(cancelBtn, btnEl.nextSibling);

    btnEl.onclick = async () => {
      cancelBtn.remove();
      await deleteWord(text);
      await renderWords();
    };
    cancelBtn.onclick = () => {
      cancelBtn.remove();
      btnEl.innerHTML = original;
      btnEl.title = originalTitle;
      btnEl.style.color = '#e74c3c';
      btnEl.onclick = () => handleDelete(text, btnEl);
    };
  }

  async function handleAnalyze(word, resultElement, btnEl) {
    if (btnEl) btnEl.disabled = true;
    resultElement.innerHTML = '<span class="loading">Consulting...</span>';
    try {
      const analysis = await analyzeText(word.text, word.context);
      await updateWord(word.text, { aiAnalysis: analysis });
      renderDefinitionBlock(resultElement, word, analysis);
    } catch (error) {
      resultElement.innerHTML = `<span style="color:red">Error: ${error.message}</span>`;
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  // --- Sentences View ---
  // Shows each saved word's full sentence context with a jump-to-moment link for YouTube words.
  async function renderSentences() {
    const el = document.getElementById('sentences-list');
    const words = await getWords();
    const withContext = words.filter(w => w.context);

    if (!withContext.length) {
      el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:32px">No sentences saved yet. Save words from video subtitles or page text to see them here.</p>';
      return;
    }

    el.innerHTML = '';
    withContext.forEach(word => {
      const row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px solid var(--border);padding:16px 0;display:flex;gap:16px;align-items:flex-start;';

      // Word badge
      const badge = document.createElement('div');
      badge.style.cssText = 'min-width:80px;font-weight:700;font-size:14px;background:linear-gradient(135deg,var(--brand),var(--brand-2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;padding-top:2px;';
      badge.textContent = word.text;

      // Sentence + source
      const detail = document.createElement('div');
      const sentence = document.createElement('div');
      sentence.style.cssText = 'font-style:italic;color:var(--text-main);margin-bottom:6px;line-height:1.5;';
      sentence.textContent = `"${word.context}"`;

      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-muted);display:flex;gap:12px;align-items:center;flex-wrap:wrap;';

      if (word.title) {
        const titleSpan = document.createElement('span');
        titleSpan.textContent = word.title;
        meta.appendChild(titleSpan);
      }

      if (word.videoId) {
        const link = document.createElement('a');
        link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(word.videoId)}&t=${word.videoTime || 0}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '▶ Watch moment';
        link.style.cssText = 'color:var(--brand);text-decoration:none;font-weight:500;';
        link.onmouseenter = () => { link.style.textDecoration = 'underline'; };
        link.onmouseleave = () => { link.style.textDecoration = 'none'; };
        meta.appendChild(link);
      }

      detail.appendChild(sentence);
      detail.appendChild(meta);
      row.appendChild(badge);
      row.appendChild(detail);
      el.appendChild(row);
    });
  }

  // --- Videos View ---
  // Groups saved words by their source YouTube video. Non-YouTube words shown under "Other Sources".
  async function renderVideos() {
    const el = document.getElementById('videos-list');
    const words = await getWords();

    // Group by videoId — words without videoId go into a special "other" bucket
    const videoMap = new Map(); // videoId → { title, url, videoId, words[] }
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
      linkEl.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
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
        chip.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${w.videoTime || 0}`;
        chip.target = '_blank';
        chip.rel = 'noopener noreferrer';
        chip.title = w.context || '';
        chip.textContent = w.text;
        chip.style.cssText = `
          display:inline-block;padding:4px 10px;border-radius:20px;font-size:13px;font-weight:600;
          background:var(--brand-soft);color:var(--brand);text-decoration:none;
          border:1px solid var(--brand-border, rgba(0,0,0,0.08));
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

    // Other (non-YouTube) sources
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
        chip.title = w.context || '';
        chip.textContent = w.text;
        chip.style.cssText = 'display:inline-block;padding:4px 10px;border-radius:20px;font-size:13px;font-weight:600;background:var(--brand-soft);color:var(--text-muted);border:1px solid var(--border);';
        chips.appendChild(chip);
      });
      block.appendChild(header);
      block.appendChild(chips);
      el.appendChild(block);
    }
  }

  // --- Account Section ---
  await initAccountSection();

  // Sync from cloud when dashboard regains focus (poll-on-focus strategy)
  window.addEventListener('focus', async () => {
    const token = await getAuthToken();
    if (!token) return;
    const adapter = createApiAdapter(token);
    await adapter.syncFromCloud();
    updateSyncStatus('Last synced: just now');
  });

  async function initAccountSection() {
    const token = await getAuthToken();
    if (token) {
      await showLoggedInState(token);
    } else {
      showLoggedOutState();
    }

    // Send code
    document.getElementById('acct-send-code').addEventListener('click', handleSendCode);
    document.getElementById('acct-email').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendCode();
    });

    // Verify code
    document.getElementById('acct-verify-code').addEventListener('click', handleVerifyCode);
    document.getElementById('acct-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleVerifyCode();
    });

    // Resend
    document.getElementById('acct-resend').addEventListener('click', handleSendCode);

    // Sync now
    document.getElementById('acct-sync-now').addEventListener('click', async () => {
      updateSyncStatus('Syncing…');
      const t = await getAuthToken();
      if (!t) return;
      const adapter = createApiAdapter(t);
      await adapter.syncFromCloud();
      await renderWords();
      updateSyncStatus('Last synced: just now');
    });

    // Logout
    document.getElementById('acct-logout').addEventListener('click', handleLogout);
  }

  async function handleSendCode() {
    const emailInput = document.getElementById('acct-email');
    const errEl = document.getElementById('acct-send-error');
    const btn = document.getElementById('acct-send-code');
    const email = emailInput.value.trim();

    if (!email) { showError(errEl, 'Please enter your email address.'); return; }
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
      const res = await fetch(`${getBackendUrl()}/v1/auth/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { showError(errEl, data.error || 'Failed to send code.'); return; }

      // Switch to code-sent state
      document.getElementById('acct-email-display').textContent = email;
      document.getElementById('acct-logged-out').style.display = 'none';
      document.getElementById('acct-code-sent').style.display = 'block';
      document.getElementById('acct-code').focus();
    } catch {
      showError(errEl, 'Network error — check your connection.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Code';
    }
  }

  async function handleVerifyCode() {
    const email = document.getElementById('acct-email').value.trim();
    const code = document.getElementById('acct-code').value.trim();
    const errEl = document.getElementById('acct-verify-error');
    const btn = document.getElementById('acct-verify-code');

    if (!code) { showError(errEl, 'Please enter the code from your email.'); return; }
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Verifying…';

    try {
      const res = await fetch(`${getBackendUrl()}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) { showError(errEl, data.error || 'Incorrect or expired code.'); return; }

      // Store session (include email so we can display it on reload)
      await setAuthSession(data.token, data.userId, email);

      // Auto-switch provider to cloud
      const settings = await getSettings();
      await saveSettings({ ...settings, provider: 'cloud' });
      aiProviderSelect.value = 'cloud';
      toggleProviderNote('cloud');

      // One-time local → cloud vocab migration
      await migrateLocalToCloud(data.token);

      await showLoggedInState(data.token);
    } catch {
      showError(errEl, 'Network error — check your connection.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In';
    }
  }

  async function handleLogout() {
    await clearAuthSession();
    // Switch provider back to free tier
    const settings = await getSettings();
    await saveSettings({ ...settings, provider: 'freedict' });
    aiProviderSelect.value = 'freedict';
    toggleProviderNote('freedict');
    showLoggedOutState();
  }

  async function showLoggedInState(token) {
    document.getElementById('acct-logged-out').style.display = 'none';
    document.getElementById('acct-code-sent').style.display = 'none';
    document.getElementById('acct-logged-in').style.display = 'block';

    // Read stored email (persisted across page loads)
    const email = await getCloudEmail() ||
                  document.getElementById('acct-email').value ||
                  document.getElementById('acct-email-display').textContent || '';
    if (email) {
      document.getElementById('acct-avatar').textContent = email[0].toUpperCase();
      document.getElementById('acct-email-logged').textContent = email;
    }

    document.getElementById('acct-status-badge').innerHTML =
      '<span style="color:var(--success);font-weight:600;">✓ Cloud AI active</span>';

    // Trigger initial sync
    updateSyncStatus('Syncing…');
    try {
      const adapter = createApiAdapter(token);
      await adapter.syncFromCloud();
      await renderWords();
      updateSyncStatus('Last synced: just now');
    } catch {
      updateSyncStatus('Offline — using local data');
    }
  }

  function showLoggedOutState() {
    document.getElementById('acct-logged-out').style.display = 'block';
    document.getElementById('acct-code-sent').style.display = 'none';
    document.getElementById('acct-logged-in').style.display = 'none';
    document.getElementById('acct-code').value = '';
    document.getElementById('acct-send-error').style.display = 'none';
    document.getElementById('acct-verify-error').style.display = 'none';
  }

  async function migrateLocalToCloud(token) {
    // Push existing local vocab to cloud once on first login
    const MIGRATED_KEY = 'cloud_vocab_migrated';
    const already = await getAdapter().get(MIGRATED_KEY);
    if (already) return;

    try {
      const words = await getWords();
      if (words.length === 0) return;
      await fetch(`${getBackendUrl()}/v1/vocab`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: words }),
      });
      await getAdapter().set({ [MIGRATED_KEY]: true });
    } catch { /* silent — will retry on next sync */ }
  }

  function updateSyncStatus(text) {
    const el = document.getElementById('acct-sync-status');
    if (el) el.textContent = text;
  }

  function showError(el, message) {
    el.textContent = message;
    el.style.display = 'block';
  }

  // --- Review Mode ---
  let reviewQueue = [];
  let currentReviewIndex = 0;
  let retryCount = new Map(); // word.text → number of re-insertions (capped at 2)
  const reviewContainer = document.getElementById('review-container');
  const noReviewState = document.getElementById('no-review');

  async function startReviewSession() {
    const words = await getWords();
    // Fisher-Yates shuffle for an unbiased random order
    reviewQueue = [...words];
    for (let i = reviewQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [reviewQueue[i], reviewQueue[j]] = [reviewQueue[j], reviewQueue[i]];
    }
    currentReviewIndex = 0;
    retryCount = new Map(); // reset retry counts for new session
    showNextCard();
  }

  function showNextCard() {
    reviewContainer.innerHTML = '';
    
    if (currentReviewIndex >= reviewQueue.length) {
      reviewContainer.appendChild(noReviewState);
      noReviewState.innerHTML = '<h2>Session Complete!</h2><p>Great job reviewing your vocabulary.</p><button class="btn-primary" id="restart-review">Restart</button>';
      document.getElementById('restart-review').onclick = startReviewSession;
      return;
    }

    const word = reviewQueue[currentReviewIndex];
    const card = document.createElement('div');
    card.className = 'flashcard';
    
    const analysis = word.aiAnalysis || {};

    card.innerHTML = `
      <div class="flashcard-content">
        <div class="fc-word">${escapeHtml(word.text)}</div>
        <div class="fc-phonetic">${escapeHtml(analysis.pronunciation || '')}</div>
        <div class="fc-definition">
          ${analysis.translation ? `<div class="fc-translation">🌐 ${escapeHtml(analysis.translation)}</div>` : ''}
          ${analysis.definitionTranslated ? `<div class="fc-def-native">${escapeHtml(analysis.definitionTranslated)}</div>` : ''}
          ${analysis.definition ? `<div class="fc-def-en-label">English</div><div class="fc-def-en">${escapeHtml(analysis.definition)}</div>` : (!analysis.definitionTranslated ? '<div>No definition available.</div>' : '')}
          ${analysis.exampleSentence ? `
            <div class="fc-example-block">
              <div class="fc-example">"${escapeHtml(analysis.exampleSentence)}"</div>
              ${analysis.exampleSentenceTranslated ? `<div class="fc-example-trans">"${escapeHtml(analysis.exampleSentenceTranslated)}"</div>` : ''}
            </div>` : ''}
        </div>
        <div class="fc-hint">Click to flip</div>
      </div>
      <div class="review-controls">
        <button class="review-btn btn-hard">Hard / Again</button>
        <button class="review-btn btn-good">Good / Next</button>
      </div>
    `;

    // Click to flip
    card.addEventListener('click', function(e) {
      // Don't flip if clicking buttons
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') return;
      
      const def = this.querySelector('.fc-definition');
      const controls = this.querySelector('.review-controls');
      const hint = this.querySelector('.fc-hint');
      
      if (def.style.display === 'block') return; // Already flipped

      def.style.display = 'block';
      controls.classList.add('visible');
      hint.style.display = 'none';
      
      // Auto-pronounce on flip
      speakText(word.text);
    });

    // Buttons
    const btnHard = card.querySelector('.btn-hard');
    const btnGood = card.querySelector('.btn-good');

    btnHard.onclick = async (e) => {
      e.stopPropagation();
      // Cap re-insertions at 2 to prevent infinite review loops
      const count = (retryCount.get(word.text) || 0) + 1;
      retryCount.set(word.text, count);
      if (count <= 2) reviewQueue.push(word);
      // Persist relearn state so the game mode picks it up too
      await updateWord(word.text, { learningState: 'relearn' });
      currentReviewIndex++;
      showNextCard();
    };

    btnGood.onclick = async (e) => {
      e.stopPropagation();
      // Persist the promoted learning state to keep flashcard and game in sync
      const newState = nextLearningState(word, { correct: true, hintUsed: false, skipped: false });
      await updateWord(word.text, { learningState: newState });
      currentReviewIndex++;
      showNextCard();
    };

    reviewContainer.appendChild(card);
  }
});

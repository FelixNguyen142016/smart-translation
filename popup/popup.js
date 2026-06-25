import { getWords, getSettings } from '../utils/storage.js';
import { getAdapter } from '../utils/storage-adapter.js';
import { applyTheme, applyHueTheme } from '../utils/theme.js';

document.addEventListener('DOMContentLoaded', async () => {
  const wordListElement = document.getElementById('word-list');
  const dashboardLink = document.getElementById('open-dashboard');

  // Apply stored theme/dark mode immediately.
  // Prefer hue-based theme when accentHue is saved; fall back to palette.
  const settings = await getSettings();
  if (settings.accentHue !== undefined) {
    applyHueTheme(settings.accentHue, settings.darkMode);
  } else {
    applyTheme(settings);
  }

  // Load words
  const words = await getWords();

  renderWords(words.slice(0, 5)); // Show top 5 recent words

  // Listen for vocabulary changes via adapter (portable — no direct chrome.storage)
  getAdapter().onChanged((changes) => {
    if (changes['vocabulary_list']) {
      renderWords((changes['vocabulary_list'].newValue ?? []).slice(0, 5));
    }
  });

  // Open dashboard
  dashboardLink.addEventListener('click', () => chrome.runtime.openOptionsPage());

  function renderWords(words) {
    wordListElement.innerHTML = '';

    if (words.length === 0) {
      wordListElement.innerHTML = '<div class="empty-state">No words saved yet.<br>Select text and right-click to save.</div>';
      return;
    }

    words.forEach(word => {
      const li = document.createElement('div');
      li.className = 'word-item';

      const title = document.createElement('div');
      title.className = 'word-title';
      title.textContent = word.text;

      const translation = document.createElement('div');
      translation.className = 'word-translation';
      translation.textContent = word.aiAnalysis?.translation || word.aiAnalysis?.definition?.slice(0, 60) || '';

      li.appendChild(title);
      li.appendChild(translation);
      wordListElement.appendChild(li);
    });
  }
});


// search.js — Quick search bar renderer

// Apply dark mode from shared settings
(function applyTheme() {
  try {
    const settings = JSON.parse(localStorage.getItem('extension_settings') || '{}');
    if (settings.darkMode) document.documentElement.classList.add('dark');
  } catch (_) {}
})();

const input = document.getElementById('search-input');

// Focus input immediately when the window appears
window.addEventListener('load', () => input.focus());

input.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') {
    window.electronAPI.closeSearch();
    return;
  }

  if (e.key === 'Enter') {
    const word = input.value.trim();
    if (!word) return;
    // Disable input while processing to prevent double-submit
    input.disabled = true;
    await window.electronAPI.searchWord(word);
    // Main process closes this window after routing to popup
  }
});

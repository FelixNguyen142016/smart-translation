// tauri-bridge.js — single adapter replacing all three Electron preload scripts.
// Exposes the same window.electronAPI surface the renderer already uses, backed
// by Tauri invoke() + event listeners. Multi-argument IPC payloads (the old
// `analyze-word` word/token/savedData args) are combined into one object.
// Requires `app.withGlobalTauri: true` in tauri.conf.json.
(function () {
  if (!window.__TAURI__) return; // not running under Tauri (e.g. opened in a browser)

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const ua = navigator.userAgent;
  const platform = ua.includes('Mac') ? 'darwin' : ua.includes('Win') ? 'win32' : 'linux';

  window.electronAPI = {
    platform,

    // ── main window ──────────────────────────────────────────────────────
    setToken:      (token) => invoke('set_token', { token }),
    sendWordCache: (words) => invoke('update_word_cache', { words }),
    showDashboard: ()      => invoke('show_dashboard'),

    // ── popup window ─────────────────────────────────────────────────────
    getToken:   () => invoke('get_token'),
    closePopup: () => invoke('close_popup'),
    showWordOfDay: (word) => invoke('show_word_of_day', { word }),
    onAnalyzeWord: (cb) => {
      const dispatch = (p) => { if (p) cb(p.word, p.token ?? null, p.savedData ?? null, p.wotd ?? false); };
      // Popup reuse: subsequent words arrive as events
      listen('analyze-word', (e) => dispatch(e.payload));
      // First open: the payload was stored in Rust before this page loaded
      invoke('popup_ready').then(dispatch).catch(() => {});
    },

    // ── search bar window ────────────────────────────────────────────────
    searchWord:  (word) => invoke('search_word', { word }),
    closeSearch: ()     => invoke('close_search'),
  };
})();

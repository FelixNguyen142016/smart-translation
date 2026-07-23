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
      // Pull-based handoff: Rust always stashes the payload in `pending_popup`
      // and emits a bare `popup-wake` event; the payload itself never rides on
      // the event. We pull via `popup_ready` (which take()s the stash) on
      // every wake, plus once right after the listener is registered — that
      // initial pull covers any word that arrived while this page was still
      // loading, so no request can fall into the listener-registration gap.
      // Double-pulls are safe: take() returns null the second time and
      // dispatch() ignores null.
      const pull = () => invoke('popup_ready').then(dispatch).catch(() => {});
      listen('popup-wake', pull).then(pull);
    },

    // ── search bar window ────────────────────────────────────────────────
    searchWord:  (word) => invoke('search_word', { word }),
    closeSearch: ()     => invoke('close_search'),
  };
})();

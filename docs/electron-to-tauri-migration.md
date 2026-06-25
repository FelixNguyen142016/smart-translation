# Electron → Tauri Migration Plan

## Strategy

Finish and polish the app on Electron first. When everything is stable and tested, migrate to Tauri. The UI (`renderer/`) is identical in both — the migration is a targeted rewrite of `main.js` only, not a full rebuild.

**Why Electron-first:**
- Iterate fast without learning Rust
- Fix bugs on a stable foundation, not a moving target
- Migrate a finished, tested product

**Why Tauri as the end goal:**
- Significantly smaller bundle size (major advantage for user downloads/installs)
- Mac + Windows support
- Uses the OS's native webview, no bundled Chromium

---

## The Core Rule During Development

> **"Is this UI logic or OS logic?"**

| Type | Where it goes | Migration fate |
|------|--------------|----------------|
| UI logic (rendering, state, API calls) | `renderer/` | Carries over **unchanged** |
| OS logic (clipboard, hotkey, windows, file system) | `main.js` | Rewritten in **Rust commands** |

Keep this separation clean from the start. Every feature added to Electron should follow this boundary — that's the only discipline required.

---

## What the Migration Looks Like

When the time comes, the migration has two parts:

### Part 1 — Carry over unchanged
The entire `renderer/` directory moves to Tauri as-is:
- `renderer/index.html`
- `renderer/app.js`
- `renderer/popup.html` / `popup.js`
- `renderer/storage-shim.js`, `theme.js`, `game-controller.js`, etc.
- All CSS, assets, icons

No changes needed to any of this.

### Part 2 — Rewrite `main.js` in Rust

| Electron (`main.js`) | Tauri equivalent |
|----------------------|-----------------|
| `globalShortcut.register()` | `tauri-plugin-global-shortcut` |
| Second `BrowserWindow` (hotkey popup) | `tauri::WebviewWindow::builder()` |
| `ipcMain` / `ipcRenderer` bridge | Tauri `invoke()` + `#[tauri::command]` |
| `clipboard.readText()` | `tauri-plugin-clipboard-manager` |
| `app.getPath()` / file system | `tauri-plugin-fs` |
| Auto-updater | `tauri-plugin-updater` |

The `window.electronAPI.*` calls in the renderer get replaced with `window.__TAURI__.invoke('command_name')` — same pattern, different target.

---

## Features Built in Electron and Their Tauri Status

| Feature | Electron implementation | Tauri migration effort |
|---------|------------------------|----------------------|
| Hotkey popup (Cmd+Shift+T) | `globalShortcut` + second `BrowserWindow` | Direct equivalents exist — low effort |
| Word analysis API calls | `fetch()` in renderer | No change needed |
| Vocab storage (Cloudflare Worker) | `fetch()` in renderer | No change needed |
| Auth (JWT) | `localStorage` in renderer | No change needed |
| Dark mode / theming | CSS variables in renderer | No change needed |
| Settings persistence | `localStorage` in renderer | No change needed |

Nothing built in Electron is a dead end — it all translates.

---

## Migration Checklist (for when the time comes)

- [ ] Scaffold new Tauri project (`cargo tauri init`)
- [ ] Copy `renderer/` into Tauri's `dist/` or configure `devPath`
- [ ] Port each `main.js` IPC handler to a Rust `#[tauri::command]`
- [ ] Replace `window.electronAPI.*` calls in renderer with `window.__TAURI__.invoke()`
- [ ] Register global shortcut via `tauri-plugin-global-shortcut`
- [ ] Recreate popup window via `WebviewWindow::builder()`
- [ ] Test on macOS and Windows
- [ ] Set up `tauri-plugin-updater` for auto-updates
- [ ] Build and sign installers for both platforms

---

## Current Status

**Phase: Electron (active development)**

Completing all features and fixing all bugs on the Electron version before migration begins. The migration date is undefined — migration triggers when the app is feature-complete and stable.

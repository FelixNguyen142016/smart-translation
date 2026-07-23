# Semantica — Tauri Setup

New Tauri v2 project, fully separate from the legacy Electron build in `desktop/` (which is untouched apart from the shared renderer bug fixes).

## Layout

```
semantica-tauri/
├── src/                      — frontend (copied from desktop/renderer, with bug fixes)
│   └── tauri-bridge.js       — NEW: replaces all 3 Electron preload scripts
└── src-tauri/
    ├── src/lib.rs            — Rust backend (replaces desktop/main.js)
    ├── src/main.rs           — entry point
    ├── tauri.conf.json       — main window config, withGlobalTauri
    ├── capabilities/default.json
    └── icons/                — placeholder icons (replace, see below)
```

## Prerequisites (one-time)

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Tauri CLI
cargo install tauri-cli --version "^2"
# (or: npm install -D @tauri-apps/cli and use `npx tauri` instead of `cargo tauri`)

# macOS: Xcode command line tools
xcode-select --install
```

Windows additionally needs the Microsoft C++ Build Tools and WebView2 (preinstalled on Win 11).

## Run / Build

```bash
cd semantica-tauri
cargo tauri dev      # development, hot-reloads frontend from src/
cargo tauri build    # production installers (.dmg / .msi / .exe)
```

## Replace the placeholder icons

The icons in `src-tauri/icons/` are generated placeholders so the build works.
Replace them with the real brand icon:

```bash
cargo tauri icon path/to/semantica-icon-1024.png
```

## What changed vs Electron

| Area | Electron | Tauri |
|------|----------|-------|
| Preloads | `preload.js` / `preload-popup.js` / `preload-search.js` | single `src/tauri-bridge.js` (same `window.electronAPI` surface → renderer code unchanged) |
| IPC | multi-arg `webContents.send('analyze-word', word, token, savedData)` | single-object event payload `{ word, token, savedData }` + `popup_ready` handshake for first open |
| Search shortcut | `Ctrl+Shift+F` (conflicting) | `Cmd/Ctrl+Shift+D` |
| Translate entry | `Cmd+Shift+T` clipboard shortcut | **removed** — system tray icon; left-click drops down the quick search bar (cache-aware) |
| Window drag | `-webkit-app-region: drag` | `data-tauri-drag-region` attributes |
| State | `_authToken`, `_wordCache` in main.js | `AppState` (Mutex) managed by Tauri, same commands |
| Lifecycle | quit on all-windows-closed (except macOS) | stays alive in the tray; quit via tray menu |

## Version-pin note

`lib.rs` targets current Tauri v2 APIs (`show_menu_on_left_click`, `ShortcutEvent.state`,
`monitor_from_point`, `cursor_position`). If `cargo tauri dev` reports a missing method on
an older/newer minor version, these are the four call sites to adjust — the logic is unaffected.

// Semantica — Tauri backend.
// Replaces desktop/main.js (Electron): shared auth token + word cache state,
// the quick-search window, the translate popup, the system tray, and the
// Cmd/Ctrl+Shift+D global shortcut. The old Cmd+Shift+T clipboard shortcut is
// intentionally gone — the tray icon + search bar is the new translate entry.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

const SEARCH_W: f64 = 520.0;
const SEARCH_H: f64 = 62.0;
const POPUP_W: f64 = 360.0;
const POPUP_H: f64 = 520.0;
const WOTD_W: f64 = 400.0;
const WOTD_H: f64 = 600.0;

#[derive(Default)]
struct AppState {
    auth_token: Mutex<Option<String>>,
    word_cache: Mutex<Vec<Value>>,
    /// Payload for a popup window that is still loading (handed over via `popup_ready`)
    pending_popup: Mutex<Option<Value>>,
}

// ── Commands (former ipcMain handlers) ──────────────────────────────────────

#[tauri::command]
fn set_token(state: tauri::State<'_, AppState>, token: Option<String>) {
    *state.auth_token.lock().unwrap() = token;
}

#[tauri::command]
fn get_token(state: tauri::State<'_, AppState>) -> Option<String> {
    state.auth_token.lock().unwrap().clone()
}

#[tauri::command]
fn update_word_cache(state: tauri::State<'_, AppState>, words: Vec<Value>) {
    *state.word_cache.lock().unwrap() = words;
}

/// Show the (possibly hidden) main dashboard window.
/// Called from the tray menu and by the renderer when the user isn't logged in.
#[tauri::command]
fn show_dashboard(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn close_search(app: AppHandle) {
    if let Some(w) = app.get_webview_window("search") {
        let _ = w.close();
    }
}

#[tauri::command]
fn close_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.close();
    }
}

/// Search bar Enter: look the word up in the cache, close the search bar,
/// open the popup with savedData (instant render) or null (normal API flow).
///
/// Async: Tauri's own docs for `WebviewWindowBuilder::build()` (called inside
/// `show_translate_popup`) state it deadlocks — or, empirically here, silently
/// produces an unstyled/blank window — on Windows when called from a
/// synchronous command or event handler (https://github.com/tauri-apps/wry/issues/583).
/// Marking this command `async` routes it through Tauri's async dispatch
/// instead of the sync-command worker pool, which is the fix the docs
/// recommend. A previous fixed-duration sleep here targeted a different
/// theory (a webview-teardown race) and did not resolve the real issue.
#[tauri::command]
async fn search_word(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    word: String,
) -> Result<(), ()> {
    let needle = word.to_lowercase();
    let saved = state
        .word_cache
        .lock()
        .unwrap()
        .iter()
        .find(|w| {
            w.get("text")
                .and_then(Value::as_str)
                .map(|t| t.to_lowercase() == needle)
                .unwrap_or(false)
        })
        .cloned();
    close_search(app.clone());
    show_translate_popup(&app, &word, saved);
    Ok(())
}

/// Called by the popup page once its JS is ready — returns the payload stored
/// before the window existed. Solves the "emit before listener registered" race.
#[tauri::command]
fn popup_ready(state: tauri::State<'_, AppState>) -> Option<Value> {
    state.pending_popup.lock().unwrap().take()
}

/// Word of the Day: opens the popup in WOTD hero mode, anchored at the tray
/// corner of the primary monitor (top-right on macOS, bottom-right on Windows).
///
/// Async for the same reason as `search_word` above — see its doc comment.
#[tauri::command]
async fn show_word_of_day(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    word: String,
) -> Result<(), ()> {
    let needle = word.to_lowercase();
    let saved = state
        .word_cache
        .lock()
        .unwrap()
        .iter()
        .find(|w| {
            w.get("text")
                .and_then(Value::as_str)
                .map(|t| t.to_lowercase() == needle)
                .unwrap_or(false)
        })
        .cloned();
    let token = state.auth_token.lock().unwrap().clone();
    let payload = json!({ "word": word, "token": token, "savedData": saved, "wotd": true });

    // Always stash the payload and (if the window is already up) send a bare
    // wake event — the popup pulls the payload itself via `popup_ready`. See
    // the identical note in `show_translate_popup` for why the payload is
    // never sent inside the event.
    *state.pending_popup.lock().unwrap() = Some(payload);

    if let Some(win) = app.get_webview_window("popup") {
        let _ = app.emit_to("popup", "popup-wake", ());
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let (x, y) = wotd_position(&app);
    // NOTE: do not auto-open DevTools here. Opening it moves OS focus to the
    // inspector, which fires WindowEvent::Focused(false) on this window and
    // trips the blur-dismiss handler below — the popup closes itself instantly.
    // Debug manually via right-click → Inspect Element (or Cmd/Ctrl+Shift+I)
    // during `cargo tauri dev` — the "devtools" Cargo feature is intentionally
    // disabled (see Cargo.toml), so this inspector is NOT available in release
    // builds; end users can't open it.
    let build_result = WebviewWindowBuilder::new(&app, "popup", WebviewUrl::App("popup.html".into()))
        .inner_size(WOTD_W, WOTD_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(true)
        .focused(true)
        .build();
    if let Err(e) = build_result {
        log_window_error(&app, "failed to create Word of the Day popup window", &e);
    }
    Ok(())
}

/// `eprintln!` is silently discarded in release builds on Windows — `main.rs`
/// sets `windows_subsystem = "windows"` there, which detaches stderr — so a
/// window-creation failure in a packaged build would otherwise leave zero
/// trace. Best-effort mirror to a log file in the app's log dir as well.
fn log_window_error(app: &AppHandle, context: &str, err: &tauri::Error) {
    eprintln!("Semantica: {context}: {err}");
    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("window-errors.log"))
    {
        use std::io::Write;
        let _ = f.write_all(format!("[{secs}] {context}: {err}\n").as_bytes());
    }
}

/// Tray-corner anchor: below the menu bar top-right (macOS), above the
/// taskbar bottom-right (Windows), top-right elsewhere.
fn wotd_position(app: &AppHandle) -> (f64, f64) {
    let Some(m) = app.primary_monitor().ok().flatten() else {
        return (100.0, 60.0);
    };
    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);
    let x = pos.x + size.width - WOTD_W - 16.0;
    if cfg!(target_os = "windows") {
        (x, pos.y + size.height - WOTD_H - 56.0)
    } else {
        (x, pos.y + 44.0)
    }
}

// ── Window helpers ───────────────────────────────────────────────────────────

fn show_translate_popup(app: &AppHandle, word: &str, saved: Option<Value>) {
    let state = app.state::<AppState>();
    let token = state.auth_token.lock().unwrap().clone();
    let payload = json!({ "word": word, "token": token, "savedData": saved });

    // Always stash the payload in `pending_popup`, then wake the window if it
    // already exists. The payload is deliberately NOT carried by the event:
    // if the window exists but its JS hasn't registered the event listener
    // yet (fast consecutive searches while the page is still loading), an
    // emitted payload would be silently lost. The bridge instead pulls via
    // `popup_ready` both on wake and once right after registering its
    // listener, so whichever side is ready last still collects the newest
    // payload — and newer requests simply overwrite older pending ones.
    *state.pending_popup.lock().unwrap() = Some(payload);

    if let Some(win) = app.get_webview_window("popup") {
        let _ = app.emit_to("popup", "popup-wake", ());
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let (x, y) = popup_position(app);
    // NOTE: do not auto-open DevTools here — see the identical note in
    // show_word_of_day above. Debug manually during `cargo tauri dev` via
    // right-click → Inspect Element — disabled in release builds.
    let build_result = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("popup.html".into()))
        .inner_size(POPUP_W, POPUP_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(true)
        .focused(true)
        .build();
    if let Err(e) = build_result {
        log_window_error(app, "failed to create translate popup window", &e);
    }
}

/// Cmd/Ctrl+Shift+E — quick translate: read whatever text is currently on the
/// system clipboard (the user is expected to have just highlighted a word or
/// short phrase in any app and copied it) and open the translate popup for it
/// directly, skipping the search bar entirely. Mirrors the old Electron
/// Cmd/Ctrl+Shift+T clipboard-translate hotkey (`desktop/main.js`), including
/// its length/word-count sanity check so an accidental large clipboard
/// selection (a paragraph, a whole page) doesn't get sent as a "word" lookup.
///
/// Spawned on its own OS thread rather than run inline in the shortcut event
/// handler: Tauri's own docs (see the `search_word`/`show_word_of_day` doc
/// comments above) warn that `WebviewWindowBuilder::build()` — called deep
/// inside `show_translate_popup` — deadlocks or silently misbehaves on
/// Windows when invoked synchronously from an event handler such as this
/// global shortcut callback.
fn quick_translate_from_clipboard(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(raw) = app.clipboard().read_text() else { return };
        let word = raw.trim();
        if word.is_empty() || word.chars().count() > 80 || word.split_whitespace().count() > 6 {
            return;
        }
        let word = word.to_string();
        let needle = word.to_lowercase();
        let state = app.state::<AppState>();
        let saved = state
            .word_cache
            .lock()
            .unwrap()
            .iter()
            .find(|w| {
                w.get("text")
                    .and_then(Value::as_str)
                    .map(|t| t.to_lowercase() == needle)
                    .unwrap_or(false)
            })
            .cloned();
        show_translate_popup(&app, &word, saved);
    });
}

/// Popup near the cursor, flipped away from screen edges (mirrors the Electron math).
fn popup_position(app: &AppHandle) -> (f64, f64) {
    let cursor = app
        .cursor_position()
        .unwrap_or(PhysicalPosition::new(200.0, 200.0));
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return (200.0, 200.0) };

    let scale = m.scale_factor();
    let (cx, cy) = (cursor.x / scale, cursor.y / scale);
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);

    let mut px = cx + 14.0;
    let mut py = cy + 14.0;
    if px + POPUP_W > pos.x + size.width {
        px = cx - POPUP_W - 14.0;
    }
    if py + POPUP_H > pos.y + size.height {
        py = cy - POPUP_H - 14.0;
    }
    (px, py)
}

/// Show (or focus) the quick search bar.
/// `anchor`: physical click position when opened from the tray icon — the bar
/// drops down centred under it. Without an anchor (global shortcut) the bar
/// appears centred, 28% from the top, on the monitor the cursor is on.
fn show_search_bar(app: &AppHandle, anchor: Option<PhysicalPosition<f64>>) {
    if let Some(win) = app.get_webview_window("search") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    let point = anchor.or_else(|| app.cursor_position().ok());
    let monitor = point
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };

    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);

    let (px, py) = match anchor {
        // Tray click: drop down centred under the icon, clamped to the monitor
        Some(a) => {
            let ax = a.x / scale;
            let ay = a.y / scale;
            let px = (ax - SEARCH_W / 2.0)
                .max(pos.x + 8.0)
                .min(pos.x + size.width - SEARCH_W - 8.0);
            (px, ay + 8.0)
        }
        // Shortcut: centred, ~28% from the top (matches the Electron UX)
        None => (
            pos.x + (size.width - SEARCH_W) / 2.0,
            pos.y + size.height * 0.28,
        ),
    };

    let _ = WebviewWindowBuilder::new(app, "search", WebviewUrl::App("search.html".into()))
        .inner_size(SEARCH_W, SEARCH_H)
        .position(px, py)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(true)
        .focused(true)
        .build();
}

// ── Auto-update ──────────────────────────────────────────────────────────────

/// Check the update endpoint once at startup. If a newer version exists, ask
/// the user with a native dialog; on "Install" download + verify + install,
/// then restart into the new version. A decline is remembered for nothing —
/// the user is simply asked again on the next launch. Every failure path is
/// silent (logged only): the updater must never block or break normal use,
/// e.g. when offline or when the endpoint is temporarily unreachable.
fn check_for_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("Semantica: updater unavailable: {e}");
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => return, // already on the newest version
            Err(e) => {
                eprintln!("Semantica: update check failed: {e}");
                return;
            }
        };

        let version = update.version.clone();
        let app_for_install = app.clone();
        app.dialog()
            .message(format!(
                "Semantica {version} is available.\n\nInstall now? The app will restart to finish updating."
            ))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Install".to_string(),
                "Later".to_string(),
            ))
            .show(move |install| {
                if !install {
                    return; // asked again next launch
                }
                tauri::async_runtime::spawn(async move {
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => app_for_install.restart(),
                        Err(e) => eprintln!("Semantica: update install failed: {e}"),
                    }
                });
            });
    });
}

// ── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin({
            // Cmd/Ctrl+Shift+D — quick search bar (replaces the conflicting
            // Ctrl+Shift+F). Cmd/Ctrl+Shift+E — quick translate of whatever's
            // on the clipboard (revives the old Cmd+Shift+T clipboard-
            // translate hotkey under a new, non-conflicting binding). Parsed
            // once here and moved into the handler closure below, which
            // matches the shortcut it's given against these by value instead
            // of re-parsing a string on every keypress.
            let search_shortcut: Shortcut = "CommandOrControl+Shift+D".parse().unwrap();
            let translate_shortcut: Shortcut = "CommandOrControl+Shift+E".parse().unwrap();
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([search_shortcut, translate_shortcut])
                .expect("invalid shortcut definition")
                .with_handler(move |app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &search_shortcut {
                        show_search_bar(app, None);
                    } else if shortcut == &translate_shortcut {
                        quick_translate_from_clipboard(app.clone());
                    }
                })
                .build()
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        // Start Semantica at login (background app, like Grammarly)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // In-app updates: signed artifacts fetched from the public
        // semantica-releases repo (see tauri.conf.json → plugins.updater).
        // The check itself runs from setup() — see check_for_updates above.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            set_token,
            get_token,
            update_word_cache,
            search_word,
            popup_ready,
            show_word_of_day,
            show_dashboard,
            close_search,
            close_popup
        ])
        .on_window_event(|window, event| {
            match event {
                // Blur-dismiss for the two floating windows (Electron parity)
                WindowEvent::Focused(false) => {
                    let label = window.label();
                    if label == "search" || label == "popup" {
                        let _ = window.close();
                    }
                }
                // Background app: closing the dashboard hides it instead of
                // quitting — Semantica keeps running in the tray.
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // Register the app to start at login (idempotent)
            let _ = app.autolaunch().enable();

            // Non-blocking update check (prompts only if a new version exists)
            check_for_updates(app.handle().clone());

            // System tray: left-click drops down the quick search/translate bar;
            // right-click shows a small menu.
            let open_item = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Semantica", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

            TrayIconBuilder::with_id("semantica-tray")
                .icon(app.default_window_icon().expect("bundle icon missing").clone())
                .tooltip("Semantica — quick word lookup")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open-dashboard" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        show_search_bar(tray.app_handle(), Some(position));
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Semantica")
        .run(|app, event| {
            match event {
                // Keep living in the tray when all windows are closed; explicit
                // quits (tray menu → app.exit) carry an exit code and pass through.
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                // macOS: clicking the Dock icon re-opens the hidden dashboard
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });
}

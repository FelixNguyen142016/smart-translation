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
use tauri_plugin_global_shortcut::ShortcutState;

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
#[tauri::command]
fn search_word(app: AppHandle, state: tauri::State<'_, AppState>, word: String) {
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
    // Give WebView2 a moment to tear down the search webview before creating
    // a new one for the popup. Windows shares a WebView2 environment across
    // an app's windows, and spinning up a new webview in the same tick as
    // destroying another one can silently fail to attach/navigate there —
    // the window still appears (correct position/size) but its content never
    // paints, with no error surfaced anywhere. macOS/WKWebView doesn't share
    // this fragility, which is why this only ever showed up during Windows
    // testing. This command already runs off the main thread (Tauri
    // dispatches sync commands to a worker pool), so sleeping here doesn't
    // block the UI.
    std::thread::sleep(std::time::Duration::from_millis(150));
    show_translate_popup(&app, &word, saved);
}

/// Called by the popup page once its JS is ready — returns the payload stored
/// before the window existed. Solves the "emit before listener registered" race.
#[tauri::command]
fn popup_ready(state: tauri::State<'_, AppState>) -> Option<Value> {
    state.pending_popup.lock().unwrap().take()
}

/// Word of the Day: opens the popup in WOTD hero mode, anchored at the tray
/// corner of the primary monitor (top-right on macOS, bottom-right on Windows).
#[tauri::command]
fn show_word_of_day(app: AppHandle, state: tauri::State<'_, AppState>, word: String) {
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

    if let Some(win) = app.get_webview_window("popup") {
        let _ = app.emit_to("popup", "analyze-word", payload);
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    *state.pending_popup.lock().unwrap() = Some(payload);

    let (x, y) = wotd_position(&app);
    // NOTE: do not auto-open DevTools here. Opening it moves OS focus to the
    // inspector, which fires WindowEvent::Focused(false) on this window and
    // trips the blur-dismiss handler below — the popup closes itself instantly.
    // Use right-click → Inspect Element (or Cmd/Ctrl+Shift+I) to debug manually.
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
        eprintln!("Semantica: failed to create Word of the Day popup window: {e}");
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

    // Reuse the popup if it is already open
    if let Some(win) = app.get_webview_window("popup") {
        let _ = app.emit_to("popup", "analyze-word", payload);
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    *state.pending_popup.lock().unwrap() = Some(payload);

    let (x, y) = popup_position(app);
    // NOTE: do not auto-open DevTools here — see the identical note in
    // show_word_of_day above. Use right-click → Inspect Element instead.
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
        eprintln!("Semantica: failed to create translate popup window: {e}");
    }
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

// ── App entry ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Cmd/Ctrl+Shift+D — replaces the conflicting Ctrl+Shift+F.
                // The old Cmd+Shift+T translate shortcut is removed on purpose.
                .with_shortcuts(["CommandOrControl+Shift+D"])
                .expect("invalid shortcut definition")
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        show_search_bar(app, None);
                    }
                })
                .build(),
        )
        // Start Semantica at login (background app, like Grammarly)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
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

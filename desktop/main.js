// main.js — Electron main process for VocabAI Desktop

const { app, BrowserWindow, Menu, globalShortcut, clipboard, ipcMain, screen } = require('electron');
const path = require('path');

let mainWindow = null;
let popupWindow = null;

// ── Auth token shared between windows via IPC ──────────────────────────────
let _authToken = null;
ipcMain.handle('set-token', (_, token) => { _authToken = token; });
ipcMain.handle('get-token', () => _authToken);
ipcMain.handle('close-popup', () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close();
    popupWindow = null;
  }
});


// ── Main window ────────────────────────────────────────────────────────────
function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 580,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Open DevTools with F12 (remove before final release)
  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools();
  });
}

// ── Translate popup ────────────────────────────────────────────────────────
function showTranslatePopup(word) {
  const { x, y } = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x, y });
  const { bounds } = display;

  // Position near cursor, keep inside screen bounds
  let px = x + 14;
  let py = y + 14;
  if (px + 360 > bounds.x + bounds.width)  px = x - 374;
  if (py + 500 > bounds.y + bounds.height) py = y - 514;

  // Reuse existing popup if open
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setPosition(px, py);
    popupWindow.webContents.send('analyze-word', word);
    popupWindow.show();
    popupWindow.focus();
    return;
  }

  popupWindow = new BrowserWindow({
    width: 360,
    height: 520,
    x: px,
    y: py,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    transparent: true,
    hasShadow: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload-popup.js'),
    },
    show: false,
  });

  popupWindow.loadFile(path.join(__dirname, 'renderer', 'popup.html'));

  popupWindow.once('ready-to-show', () => {
    popupWindow.show();
    popupWindow.webContents.send('analyze-word', word);
  });

  // Close when user clicks elsewhere
  popupWindow.on('blur', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.close();
      popupWindow = null;
    }
  });

  popupWindow.on('closed', () => { popupWindow = null; });
}

// ── Global hotkey: Cmd+Shift+T (Mac) / Ctrl+Shift+T (Win) ────────────────
// Flow: select word → Cmd+C → Cmd+Shift+T → popup appears
function registerHotkey() {
  const ok = globalShortcut.register('CommandOrControl+Shift+T', () => {
    const text = clipboard.readText().trim();
    // Only process single words or short phrases — not paragraphs
    if (!text || text.length > 80 || text.split(/\s+/).length > 6) return;
    showTranslatePopup(text);
  });
  if (!ok) console.error('[VocabAI] Hotkey registration failed — another app may be using Ctrl/Cmd+Shift+T');
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.on('ready', () => {
  createWindow();
  registerHotkey();
});

// macOS: re-open window on dock click
app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

// Keep app running in background on macOS so hotkey stays active even with window closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

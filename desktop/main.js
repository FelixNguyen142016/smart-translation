// main.js — Electron main process for VocabAI Desktop

const { app, BrowserWindow, Menu, globalShortcut, clipboard, ipcMain, screen } = require('electron');
const path = require('path');

let mainWindow   = null;
let popupWindow  = null;
let searchWindow = null;

// ── Auth token shared between windows via IPC ──────────────────────────────
let _authToken = null;
// Word cache pushed from main window renderer — used by search bar for instant lookup
let _wordCache = [];

ipcMain.handle('set-token',   (_, token) => { _authToken = token; });
ipcMain.handle('get-token',   ()         => _authToken);
ipcMain.on('update-word-cache', (_, words) => { _wordCache = words || []; });

ipcMain.handle('close-popup', () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.close();
    popupWindow = null;
  }
});

ipcMain.handle('close-search', () => {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.close();
    searchWindow = null;
  }
});

// search-word: called from search bar on Enter
// Checks word cache → routes to popup with savedData (found) or null (new)
ipcMain.handle('search-word', (_, word) => {
  const match = _wordCache.find(w => w.text?.toLowerCase() === word.toLowerCase()) || null;
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.close();
    searchWindow = null;
  }
  showTranslatePopup(word, match);
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
}

// ── Translate popup ────────────────────────────────────────────────────────
// savedData: full word object from vocab cache, or null for a new word
function showTranslatePopup(word, savedData = null) {
  const { x, y } = screen.getCursorScreenPoint();
  const display   = screen.getDisplayNearestPoint({ x, y });
  const { bounds } = display;

  let px = x + 14;
  let py = y + 14;
  if (px + 360 > bounds.x + bounds.width)  px = x - 374;
  if (py + 500 > bounds.y + bounds.height) py = y - 514;

  // Reuse existing popup if open
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setPosition(px, py);
    popupWindow.webContents.send('analyze-word', word, _authToken, savedData);
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
    popupWindow.webContents.send('analyze-word', word, _authToken, savedData);
  });

  popupWindow.on('blur', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.close();
      popupWindow = null;
    }
  });

  popupWindow.on('closed', () => { popupWindow = null; });
}

// ── Search bar window ──────────────────────────────────────────────────────
function showSearchBar() {
  // If already open, just focus it
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.focus();
    return;
  }

  const { bounds } = screen.getPrimaryDisplay();
  const winW = 520;
  const winH = 62;
  const px   = Math.round(bounds.x + (bounds.width  - winW) / 2);
  const py   = Math.round(bounds.y + bounds.height * 0.28); // ~28% from top

  searchWindow = new BrowserWindow({
    width:  winW,
    height: winH,
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
      preload: path.join(__dirname, 'preload-search.js'),
    },
    show: false,
  });

  searchWindow.loadFile(path.join(__dirname, 'renderer', 'search.html'));
  searchWindow.once('ready-to-show', () => searchWindow.show());

  // Dismiss when user clicks elsewhere
  searchWindow.on('blur', () => {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.close();
      searchWindow = null;
    }
  });

  searchWindow.on('closed', () => { searchWindow = null; });
}

// ── Global hotkeys ─────────────────────────────────────────────────────────
function registerHotkeys() {
  // Existing: select word → copy → Cmd/Ctrl+Shift+T → translate popup
  const translateOk = globalShortcut.register('CommandOrControl+Shift+T', () => {
    const text = clipboard.readText().trim();
    if (!text || text.length > 80 || text.split(/\s+/).length > 6) return;
    showTranslatePopup(text);
  });
  if (!translateOk) console.error('[VocabAI] Translate hotkey failed (Ctrl/Cmd+Shift+T)');

  // New: Cmd/Ctrl+Shift+F → open quick search bar
  const searchOk = globalShortcut.register('CommandOrControl+Shift+F', () => {
    showSearchBar();
  });
  if (!searchOk) console.error('[VocabAI] Search hotkey failed (Ctrl/Cmd+Shift+F)');
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.on('ready', () => {
  createWindow();
  registerHotkeys();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

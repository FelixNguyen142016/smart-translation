// preload-popup.js — Preload for the floating translate popup window

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // Get the auth token stored by the main process
  getToken: () => ipcRenderer.invoke('get-token'),
  // Close this popup window
  closePopup: () => ipcRenderer.invoke('close-popup'),
  // Listen for the word to analyze (sent by main process after hotkey)
  onAnalyzeWord: (cb) => ipcRenderer.on('analyze-word', (_, word) => cb(word)),
});

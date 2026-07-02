// preload-search.js — Preload for the quick search bar window

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // Send the searched word to main process (main will check vocab + open popup)
  searchWord: (word) => ipcRenderer.invoke('search-word', word),
  // Close this search window
  closeSearch: () => ipcRenderer.invoke('close-search'),
});

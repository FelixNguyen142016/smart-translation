// preload.js — Preload for main window

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // Called after login so main process can share token with popup window
  setToken: (token) => ipcRenderer.invoke('set-token', token),
});

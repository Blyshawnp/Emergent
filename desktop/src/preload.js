/**
 * Preload script — exposes safe APIs to the renderer process.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => '2.5.0',
  isElectron: true,
  platform: process.platform,
});

/**
 * Preload script — exposes safe APIs to the renderer process.
 */
const { contextBridge, ipcRenderer } = require('electron');
let desktopPackage = {};

try {
  desktopPackage = require('../package.json');
} catch (_err) {
  desktopPackage = {};
}

const DEFAULT_APP_VERSION = '1.0.1';

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.sendSync('app:getVersion') || desktopPackage.version || DEFAULT_APP_VERSION,
  isNotificationManager: () => Boolean(ipcRenderer.sendSync('app:isNotificationManager')),
  getRuntimeFlags: () => ipcRenderer.sendSync('app:getRuntimeFlags') || {},
  getBackendUrl: () => ipcRenderer.sendSync('backend:getUrl') || '',
  getAdminToken: () => ipcRenderer.sendSync('app:getAdminToken') || '',
  getDeviceName: () => ipcRenderer.sendSync('app:getDeviceName') || '',
  isElectron: true,
  platform: process.platform,
  quitApp: () => ipcRenderer.invoke('app:quit'),
  respondToQuitConfirmation: (confirmed) => ipcRenderer.invoke('app:quit-response', Boolean(confirmed)),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setUnsavedChanges: (value) => ipcRenderer.invoke('app:setUnsavedChanges', Boolean(value)),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  getUpdateState: () => ipcRenderer.invoke('updates:getState'),
  installPendingUpdate: () => ipcRenderer.invoke('updates:installPending'),
  acknowledgeInstalledUpdate: () => ipcRenderer.invoke('updates:ackInstalled'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterQuitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  updaterGetStatus: () => ipcRenderer.invoke('updater:get-status'),
  updaterManualDownload: () => ipcRenderer.invoke('updater:manual-download'),
  getAboutInfo: () => ipcRenderer.invoke('app:getAboutInfo'),
  getBackendState: () => ipcRenderer.invoke('backend:getState'),
  retryBackendStartup: (options = {}) => ipcRenderer.invoke('backend:retryStartup', options || {}),
  getAssetUrl: (filename) => ipcRenderer.invoke('assets:getUrl', filename),
  authSession: {
    get: () => ipcRenderer.invoke('authSession:get'),
    save: (session) => ipcRenderer.invoke('authSession:save', session),
    clear: () => ipcRenderer.invoke('authSession:clear'),
  },
  getPendingDeepLink: () => ipcRenderer.invoke('auth:getPendingDeepLink'),
  onAppEvent: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, type, payload) => callback(type, payload);
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  },
});

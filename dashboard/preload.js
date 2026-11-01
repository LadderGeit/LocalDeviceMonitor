const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deviceWatch', {
  getData: () => ipcRenderer.invoke('data:get'),
  openLog: (mac) => ipcRenderer.invoke('open:log', mac),
  openFolder: () => ipcRenderer.invoke('open:folder'),
  clearLog: (mac) => ipcRenderer.invoke('log:clear', mac),
  startWatcher: () => ipcRenderer.invoke('watcher:start'),
  stopWatcher: () => ipcRenderer.invoke('watcher:stop'),
  updateDevice: (change) => ipcRenderer.invoke('devices:update', change),
  scanNetwork: () => ipcRenderer.invoke('network:scan'),
  onChange: (callback) => ipcRenderer.on('data:changed', () => callback()),
  onVendor: (callback) => ipcRenderer.on('network:vendor', (_, update) => callback(update)),
});

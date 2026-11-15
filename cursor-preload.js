const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aiCursor', {
  onPosition: (callback) => ipcRenderer.on('ai-cursor-position', (_event, value) => callback(value)),
  onVisible: (callback) => ipcRenderer.on('ai-cursor-visible', (_event, value) => callback(value)),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chat: (messages, model) => ipcRenderer.send('chat', { messages, model }),
  mouseIn: () => ipcRenderer.send('mouse-in'),
  mouseOut: () => ipcRenderer.send('mouse-out'),
  hide: () => ipcRenderer.send('hide'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  onToken: (cb) => ipcRenderer.on('token', (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on('done', (_e, err) => cb(err)),
  onFocus: (cb) => ipcRenderer.on('focus-input', () => cb()),
  onGeometry: (cb) => ipcRenderer.on('geometry', (_e, g) => cb(g)),
  onVisibility: (cb) => ipcRenderer.on('visibility', (_e, v) => cb(v)),
});

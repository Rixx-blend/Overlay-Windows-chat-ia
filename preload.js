const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chat: (messages, model) => ipcRenderer.send('chat', { messages, model }),
  resize: (w, h) => ipcRenderer.send('resize', { w, h }),
  mouseIn: () => ipcRenderer.send('mouse-in'),
  mouseOut: () => ipcRenderer.send('mouse-out'),
  hide: () => ipcRenderer.send('hide'),
  onToken: (cb) => ipcRenderer.on('token', (_e, t) => cb(t)),
  onDone: (cb) => ipcRenderer.on('done', (_e, err) => cb(err)),
  onFocus: (cb) => ipcRenderer.on('focus-input', () => cb()),
});

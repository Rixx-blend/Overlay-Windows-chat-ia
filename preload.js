const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, value) => cb(value));

contextBridge.exposeInMainWorld('api', {
  // Chat : opts = { engine, model, level, allowActions }
  chat: (messages, opts) => ipcRenderer.send('chat', { messages, ...opts }),
  transcribe: (buf) => ipcRenderer.invoke('transcribe', buf),
  runCommand: (command) => ipcRenderer.invoke('run-command', command),

  // Paramètres et IA locale
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  ollamaStatus: () => ipcRenderer.invoke('ollama-status'),
  installLocalAI: () => ipcRenderer.invoke('install-local-ai'),

  // Mises à jour
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Fenêtre
  protect: (on) => ipcRenderer.invoke('protect', on),
  mouseIn: () => ipcRenderer.send('mouse-in'),
  mouseOut: () => ipcRenderer.send('mouse-out'),
  hide: () => ipcRenderer.send('hide'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // Événements venant du processus principal
  onToken: (cb) => on('token', cb),
  onDone: (cb) => on('done', cb),
  onFocus: (cb) => on('focus-input', () => cb()),
  onGeometry: (cb) => on('geometry', cb),
  onVisibility: (cb) => on('visibility', cb),
  onMode: (cb) => on('mode', cb),
  onSnapshot: (cb) => on('snapshot', () => cb()),
  onFpsToggle: (cb) => on('fps-toggle', () => cb()),
  onCaptureStart: (cb) => on('capture-start', () => cb()),
  onCaptureEnd: (cb) => on('capture-end', () => cb()),
  onOllamaProgress: (cb) => on('ollama-progress', cb),
  onUpdateStatus: (cb) => on('update-status', cb),
});

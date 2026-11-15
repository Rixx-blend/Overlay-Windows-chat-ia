const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, value) => cb(value));

contextBridge.exposeInMainWorld('api', {
  // Chat : opts = { engine, model, level, allowActions }
  chat: (messages, opts) => ipcRenderer.send('chat', { messages, ...opts }),
  transcribe: (buf) => ipcRenderer.invoke('transcribe', buf),
  runCommand: (command) => ipcRenderer.invoke('run-command', command),
  computerUseStart: (task) => ipcRenderer.invoke('computer-use-start', task),
  computerUseStop: () => ipcRenderer.invoke('computer-use-stop'),
  computerUseApprove: (approved) => ipcRenderer.invoke('computer-use-approve', approved),
  computerUseState: () => ipcRenderer.invoke('computer-use-state'),
  onComputerUseStatus: (cb) => on('computer-use-status', cb),
  onComputerUseHistory: (cb) => on('computer-use-history', cb),
  onComputerUseConfirmation: (cb) => on('computer-use-confirmation', cb),
  launchApp: (nom) => ipcRenderer.invoke('launch-app', nom),

  // Paramètres et IA locale
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  openTavilyKeys: () => ipcRenderer.invoke('open-tavily-keys'),
  ollamaStatus: () => ipcRenderer.invoke('ollama-status'),
  startupModelsStatus: () => ipcRenderer.invoke('startup-models-status'),
  downloadSdxlModel: () => ipcRenderer.invoke('download-sdxl-model'),
  installLocalAI: () => ipcRenderer.invoke('install-local-ai'),
  imageStatus: () => ipcRenderer.invoke('image-status'),
  generateImage: (options) => ipcRenderer.invoke('generate-image', options),
  removeBackground: (imagePath) => ipcRenderer.invoke('remove-background', imagePath),
  saveGeneratedImage: (imagePath) => ipcRenderer.invoke('save-generated-image', imagePath),
  copyGeneratedImage: (imagePath) => ipcRenderer.invoke('copy-generated-image', imagePath),
  openGeneratedImage: () => ipcRenderer.invoke('open-generated-image'),
  onImageProgress: (cb) => on('image-progress', cb),

  // Mises à jour
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Fenêtre
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  onWindowMaximized: (cb) => on('window-maximized', cb),
  protect: (on) => ipcRenderer.invoke('protect', on),
  cardRect: (r) => ipcRenderer.send('card-rect', r),
  onHover: (cb) => on('hover', cb),
  focusWindow: () => ipcRenderer.send('focus-me'),
  hide: () => ipcRenderer.send('hide'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // Événements venant du processus principal
  onToken: (cb) => on('token', cb),
  onDone: (cb) => on('done', cb),
  onSources: (cb) => on('sources', cb),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
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

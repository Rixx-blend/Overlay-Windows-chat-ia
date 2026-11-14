const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session } = require('electron');
const path = require('path');

const API_URL = 'https://api.openai.com/v1/chat/completions';

// Fenêtre de taille fixe (assez grande pour la carte ouverte) : aucun redimensionnement pendant l'animation
const WIN_W = 620;
const WIN_H = 580;

let win = null;

function displayOf() {
  return screen.getDisplayMatching(win.getBounds());
}

// Position de la fenêtre dans son écran : le renderer en déduit la zone du bureau à afficher
function sendGeometry() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const d = displayOf();
  win.webContents.send('geometry', {
    x: b.x - d.bounds.x,
    y: b.y - d.bounds.y,
    w: b.width,
    h: b.height,
    dw: d.bounds.width,
    dh: d.bounds.height,
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.round(workArea.x + (workArea.width - WIN_W) / 2),
    y: Math.round(workArea.y + workArea.height * 0.2),
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // Exclut la fenêtre de la capture : sinon le verre se capturerait lui-même
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.once('did-finish-load', () => {
    sendGeometry();
    win.webContents.send('visibility', win.isVisible());
  });
  win.on('move', sendGeometry);
  win.on('show', () => {
    sendGeometry();
    win.webContents.send('visibility', true);
  });
  win.on('hide', () => win.webContents.send('visibility', false));
}

// Le renderer demande le flux de l'écran (vidéo GPU continue, bien plus rapide que des captures d'image)
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const d = displayOf();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
    callback(src ? { video: src } : {});
  });
}

// Déplacement de la fenêtre : on suit la position du curseur côté système
let dragOffset = null;
ipcMain.on('drag-start', () => {
  if (!win) return;
  const [x, y] = win.getPosition();
  const p = screen.getCursorScreenPoint();
  dragOffset = { x: p.x - x, y: p.y - y };
});
ipcMain.on('drag-move', () => {
  if (!win || !dragOffset) return;
  const p = screen.getCursorScreenPoint();
  win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
});
ipcMain.on('drag-end', () => {
  dragOffset = null;
});

ipcMain.on('mouse-in', () => win && win.setIgnoreMouseEvents(false));
ipcMain.on('mouse-out', () => win && win.setIgnoreMouseEvents(true, { forward: true }));
ipcMain.on('hide', () => win && win.hide());

// Streaming : la clé reste dans le processus principal (variable d'environnement)
ipcMain.on('chat', async (e, { messages, model }) => {
  const send = (channel, value) => {
    if (!e.sender.isDestroyed()) e.sender.send(channel, value);
  };
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} : ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) send('token', delta);
        } catch {
          /* ligne SSE incomplète : ignorée */
        }
      }
    }
    send('done', null);
  } catch (err) {
    send('done', err.message);
  }
});

function toggleOverlay() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    win.webContents.send('focus-input');
  }
}

app.whenReady().then(() => {
  createWindow();
  setupCapture();
  setupPermissions();
  globalShortcut.register('Control+Alt+Space', toggleOverlay);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

// Autorise le micro (et le partage d'écran) pour cette application uniquement
function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture'].includes(permission));
  });
}

// Transcription vocale (Whisper) : l'audio part du processus principal, la clé reste côté serveur
ipcMain.handle('transcribe', async (_e, buf) => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/webm' }), 'audio.webm');
  form.append('model', 'whisper-1');
  form.append('language', 'fr');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}` },
    body: form,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).text || '';
});

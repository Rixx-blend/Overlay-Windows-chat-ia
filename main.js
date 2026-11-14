const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');

const API_URL = 'https://api.openai.com/v1/chat/completions';

// Fenêtre de taille fixe, assez grande pour la carte en état ouvert.
// Pas de redimensionnement pendant l'animation : plus de lag, la transparence laisse passer les clics.
const WIN_W = 620;
const WIN_H = 580;

// Le fond est flouté de toute façon : on le capture à demi-résolution (beaucoup plus rapide)
const CAPTURE_SCALE = 0.5;

let win = null;
let capturing = false;
let queued = false;
let dragOffset = null;

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
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // Exclut la fenêtre de la capture d'écran : on peut ainsi capturer le bureau derrière elle
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Les zones vides laissent passer les clics ; la carte les reprend au survol
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.once('did-finish-load', scheduleCapture);
  win.on('move', scheduleCapture);
  win.on('show', scheduleCapture);
  setInterval(() => {
    if (win && win.isVisible()) scheduleCapture();
  }, 1000);
}

// Une seule capture à la fois ; si une demande arrive pendant, on en relance une
function scheduleCapture() {
  if (capturing) {
    queued = true;
    return;
  }
  capturing = true;
  capture()
    .catch((err) => console.error('capture :', err.message))
    .finally(() => {
      capturing = false;
      if (queued) {
        queued = false;
        scheduleCapture();
      }
    });
}

async function capture() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const s = display.scaleFactor * CAPTURE_SCALE;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * s),
      height: Math.round(display.size.height * s),
    },
  });
  const src = sources.find((x) => x.display_id === String(display.id)) || sources[0];
  if (!src || win.isDestroyed()) return;

  const full = src.thumbnail;
  const fs = full.getSize();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const x = clamp(Math.round((b.x - display.bounds.x) * s), 0, fs.width - 1);
  const y = clamp(Math.round((b.y - display.bounds.y) * s), 0, fs.height - 1);
  const w = Math.max(1, Math.min(Math.round(b.width * s), fs.width - x));
  const h = Math.max(1, Math.min(Math.round(b.height * s), fs.height - y));

  // JPEG : bien plus rapide à encoder/décoder que le PNG
  const jpeg = full.crop({ x, y, width: w, height: h }).toJPEG(75);
  if (!win.isDestroyed()) {
    win.webContents.send('backdrop', 'data:image/jpeg;base64,' + jpeg.toString('base64'));
  }
}

// Déplacement de la fenêtre : on suit la position du curseur côté système (fluide, sans lag)
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
  scheduleCapture();
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
  // Ctrl+Alt+Espace : affiche / masque l'overlay, depuis n'importe quelle application
  globalShortcut.register('Control+Alt+Space', toggleOverlay);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

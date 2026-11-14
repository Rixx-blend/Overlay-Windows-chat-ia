const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const os = require('os');
const path = require('path');

const API_URL = 'https://api.openai.com/v1/chat/completions';
// Windows 11 = build >= 22000 : seul cas où l'acrylique natif (vrai flou du bureau) est disponible
const IS_WIN11 = parseInt(os.release().split('.')[2] || '0', 10) >= 22000;

const BASE_W = 504;
const BASE_H = 90;
let win = null;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    x: Math.round(workArea.x + (workArea.width - BASE_W) / 2),
    y: Math.round(workArea.y + workArea.height * 0.25),
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: true,
    ...(IS_WIN11 ? { backgroundMaterial: 'acrylic' } : { transparent: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Les zones vides de la fenêtre laissent passer les clics ; la carte les reprend au survol.
  win.setIgnoreMouseEvents(true, { forward: true });
}

// Le renderer demande la taille de la carte ; la fenêtre suit en restant centrée.
ipcMain.on('resize', (_e, { w, h }) => {
  if (!win) return;
  const W = Math.min(Math.max(Math.round(w), 100), 800);
  const H = Math.min(Math.max(Math.round(h), 60), 640);
  const b = win.getBounds();
  win.setBounds({
    x: b.x + Math.round((b.width - W) / 2),
    y: b.y,
    width: W,
    height: H,
  });
});

ipcMain.on('mouse-in', () => win && win.setIgnoreMouseEvents(false));
ipcMain.on('mouse-out', () => win && win.setIgnoreMouseEvents(true, { forward: true }));
ipcMain.on('hide', () => win && win.hide());

// Streaming : la clé reste dans le processus principal (variable d'environnement).
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
  // Ctrl+Alt+Espace : affiche / masque l'overlay, même depuis une autre application
  globalShortcut.register('Control+Alt+Space', toggleOverlay);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

// Surveillance globale du clavier et de la souris (Win+Maj+S, Impr écran)
let uIOhook = null;
let UiohookKey = null;
try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (err) {
  console.error('raccourcis de capture indisponibles :', err.message);
}

const API_URL = 'https://api.openai.com/v1/chat/completions';
const OLLAMA = 'http://127.0.0.1:11434';
const OLLAMA_MODEL = 'qwen2.5vl:3b';
const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';

// Fenêtre de taille fixe (assez grande pour la carte ouverte et les paramètres)
const WIN_W = 620;
const WIN_H = 600;

// Niveaux de réflexion : longueur et effort de la réponse
const LEVELS = {
  low: { hint: 'Réponds brièvement, en 2 à 4 phrases.', tokens: 400, effort: 'low' },
  high: { hint: 'Réponds de façon claire et détaillée, avec une structure si elle aide.', tokens: 1500, effort: 'medium' },
  max: { hint: 'Analyse en profondeur, étape par étape, et vérifie ta réponse avant de la donner.', tokens: 4000, effort: 'high' },
};

const ACTION_HINT = `

Tu peux agir sur le PC. Seulement si l'utilisateur le demande, propose UNE commande PowerShell dans un bloc exactement ainsi :
\`\`\`action
{"tool":"powershell","command":"..."}
\`\`\`
Rien d'autre dans ce bloc. L'utilisateur validera avant toute exécution.`;

const DEFAULTS = {
  engine: 'ollama',
  model: 'qwen2.5vl:3b',
  level: 'low',
  autoUpdate: true,
  allowActions: false,
  setupDone: false,
};

let win = null;
let liveGlass = true; // true : verre live, overlay masqué des captures ; false : fond figé, overlay visible
let settings = { ...DEFAULTS };
let firstRun = false;
let dragOffset = null;
let capturing = false;
let snipActive = false;
let captureTimer = null;

// ---------- Paramètres ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
    firstRun = true;
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('paramètres :', err.message);
  }
}

// ---------- Fenêtre ----------
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
    skipTaskbar: false,
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
  win.setContentProtection(liveGlass);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message) => log(`renderer[${level}] ${message}`));
  win.webContents.on('render-process-gone', (_e, d) => log(`renderer gone: ${d.reason}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`chargement échoué: ${code} ${desc}`));
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.once('did-finish-load', () => {
    sendGeometry();
    win.webContents.send('visibility', win.isVisible());
    win.webContents.send('mode', liveGlass);
  });
  win.on('move', sendGeometry);
  win.on('show', () => {
    sendGeometry();
    win.webContents.send('visibility', true);
  });
  win.on('hide', () => win.webContents.send('visibility', false));
}

// Flux de l'écran pour le verre (getDisplayMedia)
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

// Micro et partage d'écran autorisés pour cette application uniquement
function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture'].includes(permission));
  });
}

// ---------- Mises à jour automatiques (GitHub Releases) ----------
function setupUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  const push = (state, extra = {}) => {
    if (win && !win.isDestroyed()) win.webContents.send('update-status', { state, ...extra });
  };
  autoUpdater.on('checking-for-update', () => push('checking'));
  autoUpdater.on('update-available', (i) => push('available', { version: i.version }));
  autoUpdater.on('update-not-available', () => push('none'));
  autoUpdater.on('download-progress', (p) => push('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => push('ready', { version: i.version }));
  autoUpdater.on('error', (err) => push('error', { message: err.message }));
}

function checkForUpdates() {
  if (!app.isPackaged) return Promise.resolve({ ok: false, message: 'Mises à jour disponibles dans la version installée uniquement.' });
  return autoUpdater.checkForUpdates()
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, message: err.message }));
}

// ---------- Ollama (IA locale) ----------
const report = (text) => {
  if (win && !win.isDestroyed()) win.webContents.send('ollama-progress', text);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ollamaExe = () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');

// Lance le serveur Ollama en arrière-plan (sans fenêtre)
function startOllamaServer() {
  try {
    const cmd = fs.existsSync(ollamaExe()) ? ollamaExe() : 'ollama';
    const child = spawn(cmd, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignoré : le statut sera affiché dans les paramètres */
  }
}

async function ollamaTags() {
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function readLines(res, onLine) {
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
      if (line) onLine(line);
    }
  }
  const rest = buf.trim();
  if (rest) onLine(rest);
}

async function downloadTo(url, dest, onPercent) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`téléchargement HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const ws = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  let last = -1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!ws.write(value)) await new Promise((r) => ws.once('drain', r));
    if (total) {
      const p = Math.floor((got / total) * 100);
      if (p !== last && p % 5 === 0) {
        last = p;
        onPercent(p);
      }
    }
  }
  await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
}

function runInstaller(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function pullModel() {
  const res = await fetch(OLLAMA + '/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: true }),
  });
  if (!res.ok) throw new Error(`téléchargement du modèle HTTP ${res.status}`);
  await readLines(res, (line) => {
    const j = JSON.parse(line);
    if (j.error) throw new Error(j.error);
    if (j.total && j.completed) report(`Modèle ${OLLAMA_MODEL} : ${Math.round((j.completed / j.total) * 100)} %`);
    else if (j.status) report(j.status);
  });
}

// Installe Ollama (si besoin), démarre son serveur et télécharge qwen2.5vl:3b
async function installLocalAI() {
  report('Vérification d’Ollama…');
  let tags = await ollamaTags();
  if (!tags) {
    if (!fs.existsSync(ollamaExe())) {
      report('Téléchargement d’Ollama…');
      const installer = path.join(os.tmpdir(), 'OllamaSetup.exe');
      await downloadTo(OLLAMA_INSTALLER_URL, installer, (p) => report(`Téléchargement d’Ollama : ${p} %`));
      report('Installation d’Ollama…');
      await runInstaller(installer);
    }
    report('Démarrage d’Ollama…');
    startOllamaServer();
    for (let i = 0; i < 60 && !tags; i++) {
      await sleep(1000);
      tags = await ollamaTags();
    }
    if (!tags) throw new Error('Ollama ne répond pas. Lancez-le depuis le menu Démarrer puis réessayez.');
  }
  const has = (tags.models || []).some((m) => m.name === OLLAMA_MODEL || m.name === OLLAMA_MODEL + ':latest');
  if (!has) {
    report(`Téléchargement du modèle ${OLLAMA_MODEL}…`);
    await pullModel();
  }
  report('IA locale prête.');
  return 'IA locale prête.';
}

function toOllamaMessages(msgs) {
  return msgs.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const images = m.content
      .filter((p) => p.type === 'image_url')
      .map((p) => p.image_url.url.split(',')[1]);
    return { role: m.role, content: text, images };
  });
}

// ---------- Chat : OpenAI ou Ollama, avec niveau de réflexion ----------
ipcMain.on('chat', async (e, payload) => {
  const { messages, engine, model, level, allowActions } = payload;
  const L = LEVELS[level] || LEVELS.low;
  let sys = `Tu es un assistant installé sur le PC de l'utilisateur, dans un overlay. ${L.hint}`;
  if (allowActions) sys += ACTION_HINT;
  const full = [{ role: 'system', content: sys }, ...messages];
  const send = (channel, value) => {
    if (!e.sender.isDestroyed()) e.sender.send(channel, value);
  };

  try {
    if (engine === 'ollama') {
      const res = await fetch(OLLAMA + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: toOllamaMessages(full),
          stream: true,
          options: { num_predict: L.tokens, temperature: 0.6 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}. L'IA locale est-elle installée ?`);
      await readLines(res, (line) => {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message && j.message.content) send('token', j.message.content);
      });
    } else {
      const body = { model, messages: full, stream: true, max_completion_tokens: L.tokens };
      if (/^(gpt-5|o\d)/.test(model)) body.reasoning_effort = L.effort;
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} : ${await res.text()}`);
      await readLines(res, (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) send('token', delta);
        } catch {
          /* ligne incomplète : ignorée */
        }
      });
    }
    send('done', null);
  } catch (err) {
    const down = /fetch failed/i.test(err.message) || err.cause?.code === 'ECONNREFUSED';
    send(
      'done',
      down ? "L'IA locale ne répond pas. Ouvrez les paramètres (engrenage) et cliquez sur Installer." : err.message,
    );
  }
});

// ---------- Actions sur le PC (validées par l'utilisateur côté renderer) ----------
ipcMain.handle('run-command', (_e, command) => new Promise((resolve) => {
  if (!settings.allowActions) {
    resolve({ ok: false, out: 'Actions désactivées dans les paramètres.' });
    return;
  }
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', String(command)],
    { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      const out = ((stdout || '') + (stderr ? '\n' + stderr : '')).trim();
      resolve({ ok: !err, out: out.slice(0, 4000) || (err ? err.message : '(aucune sortie)') });
    },
  );
}));

// ---------- IPC : paramètres, IA locale, mises à jour ----------
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});
ipcMain.handle('ollama-status', async () => {
  const tags = await ollamaTags();
  const models = tags ? (tags.models || []).map((m) => m.name) : [];
  return {
    installed: fs.existsSync(ollamaExe()),
    running: !!tags,
    hasModel: models.some((n) => n === OLLAMA_MODEL || n === OLLAMA_MODEL + ':latest'),
  };
});
ipcMain.handle('install-local-ai', () => installLocalAI());
ipcMain.handle('check-update', () => checkForUpdates());
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

// ---------- Transcription vocale (Whisper) ----------
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

// ---------- Déplacement, souris, masquage ----------
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
// Zone de la carte dans la fenêtre (en pixels logiques), envoyée par le renderer
let cardRect = null;
let interactive = false;
let hoverState = false;
ipcMain.on('card-rect', (_e, r) => {
  cardRect = r;
});

// Le processus principal suit le curseur : la fenêtre ne capte les clics que sur la carte
// (ou pendant un déplacement). Ailleurs, les clics passent aux applications dessous.
function trackCursor() {
  if (!win || win.isDestroyed() || !cardRect) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const lx = p.x - b.x;
  const ly = p.y - b.y;
  const inside =
    lx >= cardRect.x && lx <= cardRect.x + cardRect.w &&
    ly >= cardRect.y && ly <= cardRect.y + cardRect.h;

  const want = inside || dragOffset !== null;
  if (want !== interactive) {
    interactive = want;
    log(`clics captés=${want} curseur=(${lx},${ly}) carte=${JSON.stringify(cardRect)}`);
    if (want) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  }
  if (inside !== hoverState) {
    hoverState = inside;
    win.webContents.send('hover', inside);
  }
}

// Journal de diagnostic : %APPDATA%\OverlayIA\debug.log
function log(msg) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'debug.log'),
      `${new Date().toISOString()} ${msg}\n`,
    );
  } catch {
    /* journal facultatif */
  }
}
ipcMain.on('focus-me', () => {
  if (win && !win.isDestroyed()) win.focus();
});
ipcMain.on('hide', () => win && win.hide());

// Le renderer masque temporairement l'overlay des captures pour figer un fond propre
ipcMain.handle('protect', (_e, on) => {
  if (win && !win.isDestroyed()) win.setContentProtection(!!on);
  return true;
});

// ---------- Raccourcis ----------
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

function toggleLive() {
  if (!win) return;
  liveGlass = !liveGlass;
  win.setContentProtection(liveGlass);
  win.webContents.send('mode', liveGlass);
}

// Capture d'écran du bureau AVEC l'overlay visible, enregistrée dans Images puis ouverte
async function takeScreenshot() {
  if (!win || win.isDestroyed()) return;
  const wasLive = liveGlass;
  if (wasLive) {
    win.setContentProtection(false);
    await sleep(150);
  }
  try {
    const d = displayOf();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(d.size.width * d.scaleFactor),
        height: Math.round(d.size.height * d.scaleFactor),
      },
    });
    const src = sources.find((x) => x.display_id === String(d.id)) || sources[0];
    if (src) {
      const file = path.join(app.getPath('pictures'), 'OverlayIA-' + Date.now() + '.png');
      fs.writeFileSync(file, src.thumbnail.toPNG());
      shell.openPath(file);
    }
  } finally {
    if (wasLive && !win.isDestroyed()) win.setContentProtection(true);
  }
}

// Win+Maj+S et Impr écran : l'overlay devient visible pendant la capture, puis repasse en live
function beginCapture(kind) {
  if (!win || win.isDestroyed() || capturing) return;
  capturing = true;
  win.webContents.send('capture-start');
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.setContentProtection(false);
  }, 120);
  if (kind === 'print') {
    captureTimer = setTimeout(endCapture, 1500);
  } else {
    snipActive = true;
    captureTimer = setTimeout(endCapture, 20000);
  }
}

function endCapture() {
  if (!capturing) return;
  capturing = false;
  snipActive = false;
  clearTimeout(captureTimer);
  if (win && !win.isDestroyed()) {
    win.setContentProtection(liveGlass);
    win.webContents.send('capture-end');
  }
}

function setupHook() {
  if (!uIOhook || !UiohookKey) return;
  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.PrintScreen) {
      beginCapture('print');
    } else if (e.keycode === UiohookKey.S && e.metaKey && e.shiftKey) {
      beginCapture('snip');
    } else if (e.keycode === UiohookKey.Escape && snipActive) {
      clearTimeout(captureTimer);
      captureTimer = setTimeout(endCapture, 200);
    }
  });
  uIOhook.on('mouseup', () => {
    if (!snipActive) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(endCapture, 500);
  });
  uIOhook.start();
}

// Une seule instance : relancer l'appli (ou cliquer sur l'icône épinglée) réaffiche l'overlay
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
    win.webContents.send('focus-input');
  });
}

app.whenReady().then(() => {
  log(`démarrage v${app.getVersion()} (empaqueté=${app.isPackaged})`);
  loadSettings();
  if (firstRun) saveSettings();

  createWindow();
  setInterval(trackCursor, 40);
  setupCapture();
  setupPermissions();
  setupUpdater();
  setupHook();

  globalShortcut.register('Control+Alt+Space', toggleOverlay);
  globalShortcut.register('Control+Alt+B', () => win && win.webContents.send('snapshot'));
  globalShortcut.register('Control+Alt+L', toggleLive);
  globalShortcut.register('Control+Alt+P', takeScreenshot);
  globalShortcut.register('Control+Alt+F', () => win && win.webContents.send('fps-toggle'));

  // Mises à jour : recherche au démarrage puis toutes les 6 heures, si activé
  if (app.isPackaged && settings.autoUpdate) {
    setTimeout(() => checkForUpdates(), 8000);
    setInterval(() => settings.autoUpdate && checkForUpdates(), 6 * 60 * 60 * 1000);
  }

  // IA locale déjà installée mais arrêtée : on relance son serveur sans rien demander.
  // L'installation, elle, est proposée dans l'overlay (le renderer demande).
  ollamaTags().then((t) => {
    if (!t && fs.existsSync(ollamaExe())) startOllamaServer();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

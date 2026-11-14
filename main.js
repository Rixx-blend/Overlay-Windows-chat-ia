const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session, shell, dialog, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile, spawn, spawnSync } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { createComputerUse } = require('./computer-use');

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
// Détourage : port du pipeline de rembg (github.com/danielgatis/rembg), modèle isnet-general-use.
const RMBG_MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx';
const RMBG_MODEL_NAME = 'isnet-general-use.onnx';
const RMBG_MODEL_MD5 = 'fc16ebd8b0c10d971d3513d564d01e29';
const { predictIsnetMask } = require('./rembg');
let rmbgSessionPromise = null;

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

Tu PEUX ouvrir des logiciels et agir sur le PC : ne dis jamais que tu ne peux pas le faire, et n'invente jamais de raccourci clavier. Si l'utilisateur te demande de contrôler le PC (fichiers, fermer une appli, réglages, etc.), réponds TOUJOURS par un bloc action, jamais par un refus.
Quand l'utilisateur demande une action, réponds par une phrase courte, puis ajoute UNE commande PowerShell dans un bloc exactement ainsi :
\`\`\`action
{"tool":"powershell","command":"..."}
\`\`\`
Le bloc ne contient que ce JSON. Pour ouvrir un logiciel installé, utilise Start-Process. Blender est en général dans C:/Program Files/Blender Foundation, par exemple : {"tool":"powershell","command":"Start-Process (Get-ChildItem 'C:/Program Files/Blender Foundation' -Recurse -Filter blender.exe | Select-Object -First 1).FullName"}
Interprète les noms dictés ou saisis avec tolérance : fautes de frappe, accents, mots manquants, noms abrégés, nom commercial différent du nom installé, éditeur et numéro de version ajoutés au nom. Ne conclus pas qu'un logiciel est absent uniquement parce que son libellé exact diffère. Pour ouvrir une application, laisse le résolveur local rechercher le meilleur candidat ; si plusieurs applications restent réellement plausibles, demande une précision au lieu d'en choisir une au hasard. L'utilisateur validera avant toute exécution.`;

const DEFAULTS = {
  engine: 'ollama',
  model: 'qwen2.5vl:3b',
  level: 'low',
  autoUpdate: true,
  allowActions: true,
  webSearch: false,
  // Clé API Tavily saisie par l'utilisateur, stockée uniquement sur son PC.
  tavilyKey: '',
  setupDone: false,
};

let win = null;
const computerUse = createComputerUse({ desktopCapturer, screen, execFile, clipboard, getWindow: () => win });
let liveGlass = true; // true : verre live, overlay masqué des captures ; false : fond figé, overlay visible
let settings = { ...DEFAULTS };
let firstRun = false;
let lastGeneratedImage = null;
// Les images générées ne sont plus enregistrées dans Images : elles vivent dans un
// dossier temporaire de session, supprimé à la fermeture. C'est à l'utilisateur de
// les télécharger via le bouton Enregistrer.
let tempReferencePath = null;
function sessionImageDirectory() {
  const directory = path.join(app.getPath('temp'), 'OverlayIA-session');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
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
// Même logique qu'IA VOCAL : Ollama trouvé dans le PATH ou dans son dossier d'installation
function findOllama() {
  const candidats = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
  ];
  const local = candidats.find((c) => fs.existsSync(c));
  if (local) return local;
  try {
    const r = spawnSync('where', ['ollama'], { windowsHide: true, encoding: 'utf8' });
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.trim());
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

// Lance « ollama serve » en arrière-plan, sans fenêtre
function startOllamaServer() {
  const exe = findOllama();
  if (!exe) return false;
  const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

async function attendreServeur(ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await ollamaTags()) return true;
    await sleep(1000);
  }
  return false;
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

// Vérifie le modèle sans le conserver en mémoire après l'installation.
async function prechauffer() {
  report('Démarrage du cerveau local…');
  const r = await fetch(OLLAMA + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: 'Réponds simplement OK.',
      stream: false,
      keep_alive: 0,
      options: { num_predict: 1, num_ctx: 2048 },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
}

async function pullModel() {
  const res = await fetch(OLLAMA + '/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: true }),
  });
  if (!res.ok) throw new Error(`téléchargement du modèle HTTP ${res.status}`);
  let dernier = -20;
  await readLines(res, (line) => {
    const j = JSON.parse(line);
    if (j.error) throw new Error(j.error);
    if (j.total && j.completed != null) {
      const pct = Math.floor((j.completed * 100) / j.total);
      if (pct >= dernier + 20) {
        dernier = pct;
        report(`Téléchargement du modèle local : ${pct} %`);
      }
    }
  });
}

// Prépare l'IA locale comme IA VOCAL : Ollama (installé si besoin), serveur, modèle, préchauffage
async function installLocalAI() {
  try {
    report('Vérification d’Ollama…');
    if (!findOllama()) {
      report('Téléchargement d’Ollama…');
      const installeur = path.join(os.tmpdir(), 'OllamaSetup.exe');
      await downloadTo(OLLAMA_INSTALLER_URL, installeur, (p) => report(`Téléchargement d’Ollama : ${p} %`));
      const erreur = await shell.openPath(installeur);
      if (erreur) throw new Error('impossible d’ouvrir l’installeur : ' + erreur);
      report('Terminez l’installation d’Ollama dans la fenêtre ouverte. La suite démarre toute seule.');
      const fin = Date.now() + 15 * 60 * 1000;
      while (!findOllama() && Date.now() < fin) await sleep(3000);
      if (!findOllama()) throw new Error('Ollama n’est pas installé');
    }
    if (!(await ollamaTags())) {
      report('Démarrage du moteur local Ollama…');
      startOllamaServer();
      if (!(await attendreServeur(45000))) throw new Error('le service Ollama ne démarre pas');
    }
    const tags = await ollamaTags();
    const noms = (tags?.models || []).map((m) => m.name);
    if (!noms.includes(OLLAMA_MODEL) && !noms.includes(OLLAMA_MODEL + ':latest')) await pullModel();
    await prechauffer();
    report('IA locale prête.');
    return 'IA locale prête.';
  } catch (err) {
    const msg = 'Préparation locale impossible : ' + err.message;
    report(msg);
    throw new Error(msg);
  }
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
// Envoie une requête Ollama en gardant la réponse en mémoire jusqu'à sa fin.
// Ainsi, un échec du GPU suivi d'un nouvel essai CPU ne mélange jamais deux générations.
async function requestOllamaChat(messages, model, tokenLimit, send) {
  const baseOptions = {
    num_predict: Math.min(tokenLimit, 1200),
    num_ctx: 8192,
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
    repeat_last_n: 128,
    repeat_penalty: 1.12,
  };

  const attempts = [
    { label: 'GPU', options: baseOptions },
    { label: 'CPU de secours', options: { ...baseOptions, num_gpu: 0 } },
  ];
  let lastError;

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    try {
      if (index > 0) report('Instabilité détectée sur le calcul graphique. Nouvel essai en mode CPU…');
      const res = await fetch(OLLAMA + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10 * 60 * 1000),
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          // Décharge Qwen dès que la réponse est terminée : aucune VRAM/RAM réservée au repos.
          keep_alive: 0,
          options: attempt.options,
        }),
      });

      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Ollama HTTP ${res.status} : ${detail.slice(0, 500)}`);
      }

      let answer = '';
      let completed = false;
      await readLines(res, (line) => {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message?.content) answer += j.message.content;
        if (j.done) completed = true;
      });

      if (!completed) throw new Error("Ollama a interrompu le flux avant la fin de la réponse.");
      if (!answer.trim()) throw new Error("Ollama a terminé sans produire de réponse.");
      send('token', answer);
      return;
    } catch (err) {
      lastError = err;
      const repeatError = /token repeat limit reached|répétition de tokens/i.test(err.message || '');
      // Le second essai CPU cible notamment les erreurs du moteur vision CUDA.
      if (index === 0 && (repeatError || messages.some((m) => Array.isArray(m.images) && m.images.length))) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Échec de génération Ollama.");
}

// ---------- Recherche web (Tavily) ----------
// Chaque utilisateur saisit sa propre clé dans les paramètres : aucune clé n'est
// incluse dans l'app ni dans le dépôt.
async function searchWeb(query) {
  const key = settings.tavilyKey || '';
  if (!key) throw new Error('clé Tavily absente : ajoute-la dans les paramètres');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: query.slice(0, 400), max_results: 5 }),
  });
  if (!res.ok) throw new Error(`recherche HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, 5).map((r) => ({
    title: String(r.title || '').replace(/<[^>]+>/g, ''),
    url: String(r.url || ''),
    description: String(r.content || '').replace(/<[^>]+>/g, ''),
  }));
}

// Ouvre une page web (https uniquement) dans le navigateur par défaut.
ipcMain.handle('open-link', (_e, url) => {
  const value = String(url || '');
  if (/^https:\/\//.test(value)) shell.openExternal(value);
});

// Ouvre uniquement la page de création de clé Tavily dans le navigateur.
ipcMain.handle('open-tavily-keys', () => {
  shell.openExternal('https://app.tavily.com/home');
});

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content?.find?.((part) => part.type === 'text')?.text || '';
}

ipcMain.on('chat', async (e, payload) => {
  const { messages, engine, model, level, allowActions } = payload;
  const L = LEVELS[level] || LEVELS.low;
  let sys = `Tu es un assistant installé sur le PC de l'utilisateur, dans un overlay. ${L.hint}
Tu fonctionnes localement. Ton modèle est Qwen 2.5 VL 3B, développé par Alibaba Cloud, exécuté localement par Ollama. Ne prétends jamais être un autre modèle et n'invente jamais de version.
Réponds directement à la demande. Évite les répétitions et arrête-toi dès que la réponse est complète.
Mise en forme OBLIGATOIRE dans chaque réponse : marque au moins un passage clé en **gras**, un nuance en *italique*, un point important en ++souligné++ et un chiffre ou une alerte en ==surligné==. Exemple : « Il a **150 000 abonnés** sur YouTube, très actif sur *TikTok* ; son point fort est ++le rendu visuel++ et ==une vidéo à succès==. » Reste lisible : deux à quatre mises en forme par réponse. Utilise des listes à puces (- ) quand il y a plusieurs éléments.`;
  if (allowActions) sys += ACTION_HINT;
  // Recherche web : les résultats sont donnés au modèle avec des numéros ; la liste
  // des sources est envoyée à part et affichée repliée sous la réponse.
  let sourcesList = [];
  if (payload.webSearch) {
    const query = lastUserText(messages);
    if (query) {
      try {
        const results = await searchWeb(query);
        if (results.length) {
          sys += `\n\nRésultats de recherche web à utiliser (cite-les avec [1], [2]… et précise quand une info vient de la recherche) :\n`
            + results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.description}`).join('\n');
          sourcesList = results;
        } else {
          sys += '\n\nLa recherche web n\'a donné aucun résultat. Dis-le et réponds prudemment.';
        }
      } catch (err) {
        sys += `\n\nLa recherche web a échoué (${err.message}). Dis-le à l'utilisateur et réponds prudemment, sans inventer de sources.`;
      }
    }
  }
  const full = [{ role: 'system', content: sys }, ...messages];
  const send = (channel, value) => {
    if (!e.sender.isDestroyed()) e.sender.send(channel, value);
  };

  try {
    if (engine === 'ollama') {
      if (!(await ollamaTags())) {
        report('Démarrage du moteur local Ollama…');
        startOllamaServer();
        if (!(await attendreServeur(45000))) throw new Error('Le service Ollama ne démarre pas.');
      }
      await requestOllamaChat(toOllamaMessages(full), model, L.tokens, send);
    } else {
      const body = { model, messages: full, stream: true, max_completion_tokens: L.tokens };
      // reasoning_effort n'existe que sur les modèles de raisonnement (gpt-5, o3, o4…).
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
      let answer = '';
      await readLines(res, (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) answer += delta;
        } catch {
          /* ligne incomplète : ignorée */
        }
      });
      if (answer) send('token', answer);
    }
    if (sourcesList.length) send('sources', sourcesList);
    send('done', null);
  } catch (err) {
    const down = /fetch failed/i.test(err.message) || err.cause?.code === 'ECONNREFUSED';
    const message = /token repeat limit reached/i.test(err.message)
      ? "Ollama produit une sortie incohérente, même après un nouvel essai CPU. Vérifiez la mise à jour d'Ollama et du modèle qwen2.5vl:3b ; le problème vient du moteur ou du modèle, pas de l'historique du chat."
      : down
        ? "L'IA locale ne répond pas. Ouvrez les paramètres (engrenage) et cliquez sur Installer."
        : err.message;
    send('done', message);
  }
});

// ---------- Ouvrir une application par son nom (tolère les fautes de dictée) ----------
const ALIAS_APP = {
  'bloc notes': 'notepad',
  'bloc-notes': 'notepad',
  calculatrice: 'calc',
  explorateur: 'explorer',
  'gestionnaire des taches': 'taskmgr',
  terminal: 'wt',
  'premier pro': 'premiere pro',
  'after effect': 'after effects',
};

const normaliser = (t) =>
  String(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Distance de Damerau-Levenshtein : tolère aussi les lettres inversées (ex. aftre).
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Compare les mots utiles plutôt que le libellé complet :
// "After Effects" doit correspondre à "Adobe After Effects 2026".
const MOTS_GENERIQUES = new Set([
  'adobe', 'microsoft', 'the', 'app', 'application', 'software',
  '2024', '2025', '2026', '2027', 'x64', 'x86', '64', '32',
]);

function scoreMot(demande, candidat) {
  if (demande === candidat) return 1;
  if (candidat.startsWith(demande) || candidat.includes(demande)) return 0.96;
  if (demande.startsWith(candidat) && candidat.length >= 3) return 0.9;
  const dist = distance(demande, candidat);
  const limite = demande.length >= 7 ? 2 : demande.length >= 4 ? 1 : 0;
  if (dist > limite) return 0;
  return Math.max(0, 1 - dist / Math.max(demande.length, candidat.length));
}

function scoreNom(demande, libelle) {
  const d = normaliser(demande);
  const l = normaliser(libelle);
  if (!d || !l) return 0;
  if (d === l) return 1;
  if (l.includes(d)) return 0.99;

  const mots = d.split(' ').filter((m) => m.length > 1 && !MOTS_GENERIQUES.has(m));
  const motsL = l.split(' ').filter((m) => m.length > 1 && !MOTS_GENERIQUES.has(m));
  if (!mots.length || !motsL.length) return 0;

  const scores = mots.map((mot) => Math.max(0, ...motsL.map((x) => scoreMot(mot, x))));
  const couverture = scores.filter((s) => s >= 0.72).length / mots.length;
  const moyenne = scores.reduce((a, b) => a + b, 0) / scores.length;
  // La couverture évite qu'un seul mot courant suffise à ouvrir la mauvaise application.
  return couverture * 0.78 + moyenne * 0.22;
}

// Raccourcis du menu Démarrer (utilisateur et ensemble du PC)
function listerRaccourcis() {
  const dossiers = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const sortie = [];
  const parcourir = (dossier, profondeur) => {
    if (profondeur > 4) return;
    let entrees = [];
    try {
      entrees = fs.readdirSync(dossier, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entrees) {
      const p = path.join(dossier, e.name);
      if (e.isDirectory()) parcourir(p, profondeur + 1);
      else if (e.name.toLowerCase().endsWith('.lnk')) sortie.push({ label: e.name.slice(0, -4), file: p });
    }
  };
  dossiers.forEach((d) => parcourir(d, 0));
  return sortie;
}

// Cherche un exécutable (ex. blender.exe) dans un dossier, sur 3 niveaux au plus
function chercherExe(dossier, nomExe, profondeur = 0) {
  if (profondeur > 3) return null;
  let entrees = [];
  try {
    entrees = fs.readdirSync(dossier, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entrees) {
    if (!e.isDirectory() && e.name.toLowerCase() === nomExe) return path.join(dossier, e.name);
  }
  for (const e of entrees) {
    if (e.isDirectory()) {
      const trouve = chercherExe(path.join(dossier, e.name), nomExe, profondeur + 1);
      if (trouve) return trouve;
    }
  }
  return null;
}

function trouverApplication(nom) {
  const cle = normaliser(nom);
  const alias = ALIAS_APP[cle] || cle;
  if (alias === 'blender') {
    const b = chercherExe('C:\\Program Files\\Blender Foundation', 'blender.exe');
    if (b) return b;
  }
  let meilleur = null;
  let score = 0;
  let second = 0;
  for (const r of listerRaccourcis()) {
    const s = scoreNom(alias, r.label);
    if (s > score) {
      second = score;
      score = s;
      meilleur = r;
    } else if (s > second) second = s;
  }
  // Sûr : correspondance nette et sans second candidat proche
  if (meilleur && score >= 0.78 && (score - second >= 0.08 || score >= 0.98)) return meilleur.file;
  try {
    const r = spawnSync('where', [alias], { windowsHide: true, encoding: 'utf8' });
    const ligne = (r.stdout || '').split(/\r?\n/).find((l) => l.trim());
    if (ligne) return ligne.trim();
  } catch {
    /* rien trouvé */
  }
  return null;
}

ipcMain.handle('launch-app', async (_e, nom) => {
  if (!settings.allowActions) return { ok: false, out: 'Les actions sur le PC sont désactivées dans les paramètres.' };
  const cible = trouverApplication(String(nom || ''));
  if (!cible) return { ok: false, out: `Je ne trouve pas « ${nom} » sur ce PC.` };
  const erreur = await shell.openPath(cible);
  return erreur ? { ok: false, out: `Impossible d'ouvrir « ${nom} » : ${erreur}` } : { ok: true, out: `J'ouvre ${nom}.` };
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

// ---------- Agent visuel Computer Use ----------
ipcMain.handle('computer-use-start', async (_e, task) => {
  if (!settings.allowActions) return { ok: false, error: 'Active d’abord les actions sur le PC dans les paramètres.' };
  if (!String(task || '').trim()) return { ok: false, error: 'Décris la tâche à effectuer.' };
  computerUse.start(String(task)).catch((err) => log('Computer Use : ' + err.message));
  return { ok: true };
});
ipcMain.handle('computer-use-stop', () => { computerUse.stop(); return { ok: true }; });
ipcMain.handle('computer-use-approve', (_e, approved) => { computerUse.approve(approved); return { ok: true }; });
ipcMain.handle('computer-use-state', () => computerUse.getState());
// ---------- IPC : paramètres, IA locale, mises à jour ----------
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});
ipcMain.handle('startup-models-status', () => getStartupModelsStatus());
ipcMain.handle('download-sdxl-model', () => downloadSdxlModel());
ipcMain.handle('ollama-status', async () => {
  const tags = await ollamaTags();
  const models = tags ? (tags.models || []).map((m) => m.name) : [];
  return {
    installed: !!findOllama(),
    running: !!tags,
    hasModel: models.some((n) => n === OLLAMA_MODEL || n === OLLAMA_MODEL + ':latest'),
  };
});
ipcMain.handle('install-local-ai', () => installLocalAI());

// ---------- Génération d'images locale : ComfyUI + Stable Diffusion XL 1.0 ----------
const COMFY_URL = 'http://127.0.0.1:8188';
const SDXL_CHECKPOINT = 'sd_xl_base_1.0.safetensors';
const SDXL_DOWNLOAD_URL = 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors';
const SDXL_SHA256 = '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b';
const imageReport = (message) => {
  if (win && !win.isDestroyed()) win.webContents.send('image-progress', message);
};

async function comfyRequest(route, options = {}, timeout = 10000) {
  const response = await fetch(COMFY_URL + route, {
    ...options,
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ComfyUI HTTP ${response.status}${detail ? ' : ' + detail.slice(0, 400) : ''}`);
  }
  return response;
}

let comfyLaunchInProgress = false;
let comfyInstallInProgress = false;
let comfyOwnedPid = null;
let comfyIdleTimer = null;
let comfyGenerationInProgress = false;

async function scheduleComfyIdleShutdown() {
  if (!comfyOwnedPid || comfyGenerationInProgress) return;
  clearTimeout(comfyIdleTimer);
  // Libère immédiatement les poids SDXL du GPU/RAM après la génération.
  try {
    await fetch(COMFY_URL + '/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
  if (!comfyOwnedPid || comfyGenerationInProgress) return;
  comfyIdleTimer = setTimeout(() => {
    if (!comfyOwnedPid || comfyGenerationInProgress) return;
    const pid = comfyOwnedPid;
    comfyOwnedPid = null;
    if (pid && process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    imageReport('ComfyUI arrêté après inactivité. Les ressources sont libérées.');
  }, 15000);
  if (typeof comfyIdleTimer.unref === 'function') comfyIdleTimer.unref();
}

function findComfyInstallation() {
  const home = os.homedir();
  const roots = [
    settings.comfyuiPath,
    home,
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'OneDrive'),
    'C:\\',
    'D:\\',
  ].filter(Boolean);
  const queue = roots.map((root) => ({ root: path.resolve(root), depth: 0 }));
  const visited = new Set();
  let inspected = 0;
  while (queue.length && inspected < 2500) {
    const item = queue.shift();
    if (!item || visited.has(item.root)) continue;
    visited.add(item.root);
    inspected++;
    const root = item.root;
    try {
      // Le dossier advanced contient parfois des scripts qui supposent que le cwd
      // est la racine portable. Normaliser advanced vers son dossier parent.
      const portableRoot = path.basename(root).toLowerCase() === 'advanced' ? path.dirname(root) : root;
      const nvidiaBat = path.join(portableRoot, 'run_nvidia_gpu.bat');
      const cpuBat = path.join(portableRoot, 'run_cpu.bat');
      const advancedCpuBat = path.join(portableRoot, 'advanced', 'run_cpu.bat');
      const portablePython = path.join(portableRoot, 'python_embeded', 'python.exe');
      const portableMain = path.join(portableRoot, 'ComfyUI', 'main.py');
      if ((fs.existsSync(portablePython) && fs.existsSync(portableMain)) ||
          fs.existsSync(nvidiaBat) || fs.existsSync(cpuBat) || fs.existsSync(advancedCpuBat)) {
        return {
          root: portableRoot,
          bat: fs.existsSync(nvidiaBat) ? nvidiaBat : null,
          cpuBat: fs.existsSync(cpuBat) ? cpuBat : (fs.existsSync(advancedCpuBat) ? advancedCpuBat : null),
          python: portablePython,
          main: portableMain,
        };
      }
      const regularMain = path.join(root, 'main.py');
      const venvPython = path.join(root, 'venv', 'Scripts', 'python.exe');
      if (fs.existsSync(regularMain) && fs.existsSync(venvPython)) {
        return { root, bat: null, cpuBat: null, python: venvPython, main: regularMain };
      }
      if (item.depth >= 3) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'WindowsApps') continue;
        if (entry.name.toLowerCase().includes('comfy') || item.depth < 2) {
          queue.push({ root: path.join(root, entry.name), depth: item.depth + 1 });
        }
      }
    } catch {}
  }
  return null;
}

function hasNvidiaGpu() {
  const candidates = [
    'nvidia-smi',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
  ];
  for (const executable of candidates) {
    try {
      const result = spawnSync(executable, ['-L'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (result.status === 0 && /GPU/i.test(result.stdout || '')) return true;
    } catch {}
  }
  return false;
}

async function installComfyPortable() {
  if (comfyInstallInProgress) {
    while (comfyInstallInProgress) await sleep(1000);
    const existing = findComfyInstallation();
    if (existing) return existing;
    throw new Error('Installation de ComfyUI interrompue.');
  }

  const existing = findComfyInstallation();
  if (existing) {
    settings.comfyuiPath = existing.root;
    saveSettings();
    imageReport('Installation ComfyUI existante détectée : ' + existing.root);
    return existing;
  }

  comfyInstallInProgress = true;
  const home = os.homedir();
  const archive = path.join(os.tmpdir(), 'ComfyUI_windows_portable_nvidia.7z');
  const extractor = path.join(os.tmpdir(), '7zr.exe');
  const searchDirs = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), home];
  let existingArchive = null;
  for (const dir of searchDirs) {
    try {
      const match = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^ComfyUI.*\\.7z$/i.test(entry.name))
        .map((entry) => path.join(dir, entry.name))[0];
      if (match) { existingArchive = match; break; }
    } catch {}
  }
  const sourceArchive = existingArchive || archive;
  const downloadUrl = 'https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z';

  try {
    if (existingArchive) {
      imageReport('Archive ComfyUI déjà téléchargée détectée. Préparation de l’installation…');
    } else {
      imageReport('ComfyUI absent. Téléchargement de ComfyUI Windows Portable…');
      await downloadTo(downloadUrl, archive, (percent) => {
        imageReport('Téléchargement de ComfyUI Portable : ' + percent + ' %');
      });
    }

    imageReport('Préparation de l’extracteur 7-Zip…');
    await downloadTo('https://www.7-zip.org/a/7zr.exe', extractor, () => {});
    imageReport('Extraction de ComfyUI dans ' + path.join(home, 'ComfyUI_windows_portable') + '…');
    await new Promise((resolve, reject) => {
      execFile(extractor, ['x', sourceArchive, '-o' + home, '-y'], {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error('Extraction de ComfyUI impossible : ' + (stderr || error.message).slice(0, 500)));
        else resolve();
      });
    });

    const installation = findComfyInstallation();
    if (!installation) throw new Error('Extraction terminée, mais aucun lanceur ComfyUI n’a été trouvé. Vérifie le contenu de l’archive.');
    settings.comfyuiPath = installation.root;
    saveSettings();
    imageReport('ComfyUI Portable prêt dans ' + installation.root);
    return installation;
  } catch (err) {
    imageReport('Installation de ComfyUI impossible : ' + err.message);
    throw err;
  } finally {
    try { if (fs.existsSync(archive)) fs.unlinkSync(archive); } catch {}
    try { if (fs.existsSync(extractor)) fs.unlinkSync(extractor); } catch {}
    comfyInstallInProgress = false;
  }
}

async function startComfyIfAvailable() {
  if (comfyLaunchInProgress) return;
  // Ne pas lancer une deuxième instance si le serveur répond déjà.
  try {
    const active = await fetch(COMFY_URL + '/system_stats', { signal: AbortSignal.timeout(1500) });
    if (active.ok) return;
  } catch {}

  const installation = findComfyInstallation();
  if (!installation) {
    imageReport('Installation ComfyUI introuvable. Vérifie le dossier sélectionné.');
    return;
  }

  comfyLaunchInProgress = true;
  const logFile = path.join(app.getPath('userData'), 'comfyui-startup.log');
  let logFd = null;
  let child = null;
  let exitInfo = null;

  try {
    imageReport('Démarrage automatique de ComfyUI…');
    try {
      logFd = fs.openSync(logFile, 'w');
      fs.writeSync(logFd, '\n\n===== Démarrage ComfyUI ' + new Date().toISOString() + ' =====\n');
    } catch (err) {
      imageReport('Impossible de créer le journal ComfyUI : ' + err.message);
    }

    // Lancer directement le Python portable évite les erreurs de guillemets
    // et les chemins relatifs cassés dans advanced\\run_cpu.bat.
    if (installation.python && installation.main &&
        fs.existsSync(installation.python) && fs.existsSync(installation.main)) {
      const gpuAvailable = hasNvidiaGpu();
      const args = ['-s', installation.main, '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch'];
      if (installation.python.toLowerCase().includes('python_embeded')) args.push('--windows-standalone-build');
      if (!gpuAvailable) args.push('--cpu');
      if (logFd !== null) {
        fs.writeSync(logFd, 'Racine ComfyUI : ' + installation.root + '\n');
        fs.writeSync(logFd, 'Python : ' + installation.python + '\n');
        fs.writeSync(logFd, 'GPU NVIDIA détecté : ' + gpuAvailable + '\n');
      }
      child = spawn(installation.python, args, {
        cwd: installation.root,
        detached: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        windowsHide: true,
      });
    } else {
      throw new Error('Aucun lanceur ComfyUI ou Python valide trouvé dans ' + installation.root);
    }

    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch {}
      logFd = null;
    }

    child.on('error', (err) => {
      exitInfo = 'Erreur de lancement : ' + err.message;
    });
    child.on('exit', (code, signal) => {
      exitInfo = 'Le processus ComfyUI s’est arrêté (code ' + code + (signal ? ', signal ' + signal : '') + ').';
    });
    child.unref();
    comfyOwnedPid = child.pid || null;

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const response = await fetch(COMFY_URL + '/system_stats', { signal: AbortSignal.timeout(2500) });
        if (response.ok) {
          settings.comfyuiPath = installation.root;
          saveSettings();
          imageReport('ComfyUI est actif sur le port 8188.');
          return;
        }
      } catch {}
      if (exitInfo) break;
    }

    let details = '';
    try {
      details = fs.readFileSync(logFile, 'utf8').slice(-2200).trim();
    } catch {}
    imageReport(
      'Échec du démarrage de ComfyUI. ' +
      (exitInfo || 'Le serveur ne répond pas après 90 secondes.') +
      (details ? '\nJournal :\n' + details : '') +
      '\nJournal complet : ' + logFile
    );
  } catch (err) {
    imageReport('Impossible de démarrer ComfyUI : ' + err.message + '\nJournal : ' + logFile);
  } finally {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch {}
    }
    comfyLaunchInProgress = false;
  }
}

async function getImageStatus() {
  // Un simple rafraîchissement d'état ne doit jamais démarrer ComfyUI.
  try {
    await comfyRequest('/system_stats');
    const infoResponse = await comfyRequest('/object_info/CheckpointLoaderSimple');
    const info = await infoResponse.json();
    const choices = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    const checkpoints = Array.isArray(choices) ? choices : [];
    return {
      running: true,
      installed: checkpoints.includes(SDXL_CHECKPOINT),
      checkpoint: SDXL_CHECKPOINT,
      checkpoints,
      message: checkpoints.includes(SDXL_CHECKPOINT)
        ? 'ComfyUI prêt · SDXL 1.0 installé'
        : 'ComfyUI actif · checkpoint SDXL 1.0 manquant',
    };
  } catch {
    const installed = !!findComfyInstallation();
    return {
      running: false,
      installed: false,
      checkpoint: SDXL_CHECKPOINT,
      checkpoints: [],
      message: installed
        ? 'ComfyUI est installé mais son serveur ne démarre pas sur le port 8188'
        : 'ComfyUI sera installé automatiquement dans le dossier utilisateur au premier lancement de la génération.',
    };
  }
}

function getComfyCheckpointDirectories() {
  const home = os.homedir();
  const roots = [
    path.join(home, 'ComfyUI_windows_portable', 'ComfyUI'),
    path.join(home, 'ComfyUI', 'ComfyUI'),
    path.join(home, 'ComfyUI'),
    path.join(process.env.LOCALAPPDATA || home, 'Programs', 'ComfyUI', 'ComfyUI'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ComfyUI', 'ComfyUI'),
    'C:\\ComfyUI\\ComfyUI',
    'D:\\ComfyUI_windows_portable\\ComfyUI',
    'D:\\ComfyUI\\ComfyUI',
  ];
  const directories = [];
  if (settings.sdxlCheckpointDir) directories.push(settings.sdxlCheckpointDir);
  for (const root of roots) directories.push(path.join(root, 'models', 'checkpoints'));
  return [...new Set(directories.map((directory) => path.resolve(directory)))];
}

function findComfyCheckpointDirectory() {
  return getComfyCheckpointDirectories().find((directory) =>
    fs.existsSync(path.join(directory, SDXL_CHECKPOINT))
  ) || getComfyCheckpointDirectories().find((directory) => fs.existsSync(path.dirname(path.dirname(directory))));
}

async function getStartupModelsStatus() {
  let tags = await ollamaTags();
  // Ne démarre pas Ollama juste pour afficher l'état des modèles.
  const installedNames = (tags?.models || []).map((model) => model.name);
  const manifestRoot = path.join(process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models'), 'manifests', 'registry.ollama.ai', 'library');
  const modelManifest = path.join(manifestRoot, 'qwen2.5vl', '3b');
  const qwenInstalled = installedNames.includes(OLLAMA_MODEL)
    || installedNames.includes(OLLAMA_MODEL + ':latest')
    || fs.existsSync(modelManifest);
  const imageStatus = await getImageStatus();
  const checkpointDirectory = findComfyCheckpointDirectory();
  const checkpointPath = checkpointDirectory ? path.join(checkpointDirectory, SDXL_CHECKPOINT) : null;
  const sdxlInstalled = imageStatus.running
    ? imageStatus.installed
    : !!(checkpointPath && fs.existsSync(checkpointPath) && fs.statSync(checkpointPath).size > 6_000_000_000);

  return {
    qwenInstalled,
    ollamaInstalled: !!findOllama(),
    ollamaRunning: !!tags,
    sdxlInstalled,
    comfyRunning: imageStatus.running,
    comfyMessage: imageStatus.message,
    needsSetup: !qwenInstalled || !sdxlInstalled,
  };
}

async function downloadSdxlModel() {
  const directory = findComfyCheckpointDirectory()
    || path.join(os.homedir(), 'ComfyUI_windows_portable', 'ComfyUI', 'models', 'checkpoints');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, SDXL_CHECKPOINT);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 6_000_000_000) {
    settings.sdxlCheckpointDir = directory;
    saveSettings();
    imageReport('Checkpoint SDXL déjà présent dans le dossier sélectionné.');
    return { ok: true, alreadyExists: true };
  }

  const temporary = destination + '.download';
  try {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    imageReport('Connexion à Hugging Face pour télécharger SDXL (6,94 Go)…');
    await downloadTo(SDXL_DOWNLOAD_URL, temporary, (percent) => {
      imageReport('Téléchargement SDXL : ' + percent + ' %');
    });
    const size = fs.statSync(temporary).size;
    if (size < 6_000_000_000) throw new Error('Le fichier reçu est incomplet (' + Math.round(size / 1_000_000) + ' Mo).');

    imageReport('Vérification de l’intégrité du fichier SDXL…');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(temporary);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    if (hash.digest('hex') !== SDXL_SHA256) throw new Error('La vérification SHA-256 a échoué. Le fichier téléchargé est invalide.');

    fs.renameSync(temporary, destination);
    settings.sdxlCheckpointDir = directory;
    saveSettings();
    imageReport('SDXL téléchargé et vérifié. Démarre ou actualise ComfyUI pour le charger.');
    return { ok: true, path: destination };
  } catch (err) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    imageReport('Échec du téléchargement SDXL : ' + err.message);
    throw err;
  }
}

function fileMd5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

async function getRmbgModelPath() {
  const directory = path.join(app.getPath('userData'), 'models', 'rembg');
  const modelPath = path.join(directory, RMBG_MODEL_NAME);
  if (fs.existsSync(modelPath) && fileMd5(modelPath) === RMBG_MODEL_MD5) return modelPath;
  fs.mkdirSync(directory, { recursive: true });
  const temporary = modelPath + '.download';
  imageReport('Téléchargement de rembg (ISNet, environ 170 Mo, uniquement la première fois)…');
  try {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    await downloadTo(RMBG_MODEL_URL, temporary, (percent) => imageReport('Téléchargement rembg : ' + percent + ' %'));
    if (fileMd5(temporary) !== RMBG_MODEL_MD5) throw new Error('Le modèle rembg téléchargé ne correspond pas à la somme de contrôle attendue.');
    fs.renameSync(temporary, modelPath);
    return modelPath;
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function getRmbgSession() {
  if (!rmbgSessionPromise) {
    rmbgSessionPromise = (async () => {
      const ort = require('onnxruntime-node');
      const modelPath = await getRmbgModelPath();
      imageReport('Chargement de rembg (ISNet, premier chargement potentiellement long)…');
      // CPU uniquement : c'est le chemin vérifié contre rembg. L'accélération DirectML
      // peut produire des masques faux sans erreur visible, donc elle n'est pas utilisée ici.
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      return { ort, session };
    })().catch((error) => {
      rmbgSessionPromise = null;
      throw error;
    });
  }
  return rmbgSessionPromise;
}

function buildSdxlWorkflow({ prompt, negative, width, height, steps, referenceName, seed: requestedSeed, denoise }) {
  const seed = Number.isInteger(requestedSeed) ? requestedSeed : Math.floor(Math.random() * 2147483647);
  const latentNode = referenceName
    ? { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['1', 2] } }
    : { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  const workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: SDXL_CHECKPOINT } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed, steps, cfg: referenceName ? 7.5 : 7,
        sampler_name: 'dpmpp_2m', scheduler: 'karras',
        // Denoise img2img réglé par l'utilisateur (défaut 0.6 côté interface).
        denoise: referenceName ? denoise : 1,
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0],
        latent_image: referenceName ? ['9', 0] : ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    // PreviewImage : ComfyUI n'écrit pas le résultat dans son dossier de sortie.
    '7': { class_type: 'PreviewImage', inputs: { images: ['6', 0] } },
  };
  if (referenceName) {
    workflow['8'] = { class_type: 'LoadImage', inputs: { image: referenceName } };
    workflow['9'] = latentNode;
  } else {
    workflow['4'] = latentNode;
  }
  return workflow;
}

async function generateLocalImage(options) {
  const prompt = String(options?.prompt || '').trim();
  const referenceDataUrl = Array.isArray(options?.referenceImages) ? options.referenceImages[0] : null;
  const negative = String(options?.negative || '').trim();
  const requestedWidth = Number(options?.width);
  const requestedHeight = Number(options?.height);
  const validDimensions = (value) => Number.isInteger(value) && value >= 512 && value <= 1536 && value % 8 === 0;
  const width = validDimensions(requestedWidth) ? requestedWidth : 1024;
  const height = validDimensions(requestedHeight) ? requestedHeight : 1024;
  if (width * height > 1500000) throw new Error('Résolution trop élevée : limite de 1,5 mégapixel pour éviter un manque de mémoire.');
  const steps = Math.min(40, Math.max(10, Number(options?.steps) || 25));
  // Graine fixée par l'utilisateur pour comparer deux prompts sur la même base ; sinon aléatoire.
  const requestedSeed = Number(options?.seed);
  const seed = Number.isInteger(requestedSeed) && requestedSeed >= 0 && requestedSeed <= 2147483647
    ? requestedSeed
    : Math.floor(Math.random() * 2147483647);
  // Force de modification (img2img) : entre 0.3 (proche de la référence) et 0.95 (presque libre).
  const denoise = Math.min(0.95, Math.max(0.3, Number(options?.denoise) || 0.6));
  if (!prompt) throw new Error('Écris un prompt avant de lancer la génération.');
  if (prompt.length > 2000 || negative.length > 1000) throw new Error('Prompt trop long.');

  clearTimeout(comfyIdleTimer);
  comfyGenerationInProgress = true;
  let status;
  if (!findComfyInstallation()) await installComfyPortable();
  await startComfyIfAvailable();
  status = await getImageStatus();
  if (!status.running) {
    throw new Error('ComfyUI est installé mais ne démarre pas. Vérifie les pilotes graphiques et le fichier debug.log.');
  }
  if (!status.installed) {
    throw new Error('Checkpoint SDXL absent. Place sd_xl_base_1.0.safetensors dans ComfyUI/models/checkpoints puis actualise ComfyUI.');
  }

  let referenceName = null;
  let referenceWidth = width;
  let referenceHeight = height;
  const referenceImages = Array.isArray(options?.referenceImages) ? options.referenceImages : [];
  if (referenceImages.length > 1) {
    throw new Error('Pour modifier une image correctement, ajoute une seule référence principale à la fois.');
  }
  if (referenceImages.length === 1) {
    const sharp = require('sharp');
    const match = String(referenceImages[0]).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('Une image de référence est invalide.');
    const referenceBufferInput = Buffer.from(match[2], 'base64');
    if (referenceBufferInput.length > 8 * 1024 * 1024) throw new Error('Une image de référence dépasse 8 Mo.');

    // Conserver le ratio original. L'ancien redimensionnement forcé en 1024x1024
    // ajoutait des bandes grises et déformait les références portrait/paysage.
    const metadata = await sharp(referenceBufferInput).metadata();
    let sourceWidth = Number(metadata.width) || 1024;
    let sourceHeight = Number(metadata.height) || 1024;
    if (metadata.orientation >= 5 && metadata.orientation <= 8) {
      [sourceWidth, sourceHeight] = [sourceHeight, sourceWidth];
    }
    const scale = Math.min(1, 1536 / sourceWidth, 1536 / sourceHeight, Math.sqrt(1500000 / (sourceWidth * sourceHeight)));
    referenceWidth = Math.max(512, Math.round((sourceWidth * scale) / 8) * 8);
    referenceHeight = Math.max(512, Math.round((sourceHeight * scale) / 8) * 8);
    while (referenceWidth * referenceHeight > 1500000) {
      if (referenceWidth >= referenceHeight) referenceWidth -= 8;
      else referenceHeight -= 8;
    }

    const comfy = findComfyInstallation();
    const inputDirectory = path.join(path.dirname(comfy.main), 'input');
    fs.mkdirSync(inputDirectory, { recursive: true });
    referenceName = 'overlayia-reference-' + crypto.randomUUID() + '.png';
    const preparedReference = await sharp(referenceBufferInput).rotate()
      .resize(referenceWidth, referenceHeight, { fit: 'fill', kernel: 'lanczos3' })
      .png().toBuffer();
    await fs.promises.writeFile(path.join(inputDirectory, referenceName), preparedReference);
    tempReferencePath = path.join(inputDirectory, referenceName);
  }
  // SDXL est un modèle texte-image : il ne suit pas une consigne du type « Edit the image… ».
  // Cette phrase consommait le budget CLIP (77 tokens) au détriment du prompt utilisateur,
  // donc on envoie le prompt tel quel ; la fidélité à la référence vient du denoise (img2img).
  const workflowPrompt = prompt;

  imageReport(referenceName ? 'Modification de l’image de référence…' : 'Envoi du prompt à Stable Diffusion XL…');
  const submitted = await comfyRequest('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: buildSdxlWorkflow({ prompt: workflowPrompt, negative, width: referenceName ? referenceWidth : width, height: referenceName ? referenceHeight : height, steps: referenceName ? Math.max(30, steps) : steps, referenceName, seed, denoise }),
      client_id: 'overlayia-' + process.pid,
    }),
  });
  const { prompt_id: promptId, error, node_errors: nodeErrors } = await submitted.json();
  if (!promptId) {
    const detail = error?.message || JSON.stringify(nodeErrors || error || 'workflow refusé');
    throw new Error('ComfyUI a refusé le workflow : ' + detail.slice(0, 500));
  }

  imageReport('Génération SDXL en cours…');
  const deadline = Date.now() + 10 * 60 * 1000;
  let image = null;
  while (Date.now() < deadline) {
    await sleep(1200);
    const historyResponse = await comfyRequest('/history/' + encodeURIComponent(promptId));
    const history = await historyResponse.json();
    const outputs = history?.[promptId]?.outputs || {};
    for (const node of Object.values(outputs)) {
      if (node.images?.length) { image = node.images[0]; break; }
    }
    if (image) break;
  }
  if (!image) throw new Error('Délai dépassé : aucune image reçue après 10 minutes.');

  imageReport('Récupération et sauvegarde de l’image…');
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  });
  const imageResponse = await comfyRequest('/view?' + query.toString(), {}, 120000);
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  // Fichier temporaire de session uniquement : rien n'est enregistré dans Images.
  // La graine utilisée est inscrite dans le nom pour pouvoir relancer la même génération.
  const usedSeed = seed;
  const safeName = 'SDXL-' + new Date().toISOString().replace(/[:.]/g, '-') + '-seed' + usedSeed + '.png';
  const outputPath = path.join(sessionImageDirectory(), safeName);
  fs.writeFileSync(outputPath, buffer);
  lastGeneratedImage = outputPath;
  imageReport('Image générée. Utilise Enregistrer pour la télécharger.');
  return { ok: true, path: outputPath, seed: usedSeed, dataUrl: 'data:image/png;base64,' + buffer.toString('base64') };
}

ipcMain.handle('image-status', () => getImageStatus());
ipcMain.handle('generate-image', async (_e, options) => {
  try {
    return await generateLocalImage(options);
  } finally {
    comfyGenerationInProgress = false;
    // La copie de référence envoyée à ComfyUI n'est plus utile une fois la génération finie.
    if (tempReferencePath) {
      fs.rm(tempReferencePath, { force: true }, () => {});
      tempReferencePath = null;
    }
    scheduleComfyIdleShutdown();
  }
});

async function removeImageBackground(imagePath) {
  const outputDirectory = path.resolve(sessionImageDirectory());
  const resolved = path.resolve(String(imagePath || ''));
  if (!resolved.startsWith(outputDirectory + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('Image source introuvable ou chemin non autorisé.');
  }

  const sharp = require('sharp');
  const { ort, session } = await getRmbgSession();
  imageReport('Préparation de l’image pour le détourage…');
  const original = await sharp(resolved).rotate().png().toBuffer();

  imageReport('Calcul du masque du sujet avec rembg (ISNet)…');
  const { mask, width, height } = await predictIsnetMask(sharp, ort, session, original);

  // Diagnostic : si presque tout le masque est opaque, le modèle n'a pas trouvé de fond à retirer.
  let opaque = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= 128) opaque++;
  const opaqueShare = opaque / mask.length;
  if (opaqueShare > 0.95) log(`rembg : ${(opaqueShare * 100).toFixed(1)} % de l’image gardée comme sujet (fond non détecté).`);

  imageReport('Création du PNG transparent…');
  const alphaPng = await sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const transparentPng = await sharp(original)
    .removeAlpha()
    .joinChannel(alphaPng)
    .png()
    .toBuffer();

  const parsed = path.parse(resolved);
  const destination = path.join(parsed.dir, parsed.name + '-sans-fond.png');
  fs.writeFileSync(destination, transparentPng);
  lastGeneratedImage = destination;
  imageReport('Détourage terminé. PNG transparent enregistré.');
  return {
    ok: true,
    path: destination,
    dataUrl: 'data:image/png;base64,' + transparentPng.toString('base64'),
  };
}

ipcMain.handle('remove-background', async (_e, imagePath) => {
  try {
    return await removeImageBackground(imagePath);
  } catch (error) {
    imageReport('Détourage impossible : ' + error.message);
    throw error;
  }
});
function getTrustedGeneratedImage(imagePath) {
  const outputDirectory = path.resolve(sessionImageDirectory());
  const resolved = path.resolve(String(imagePath || ''));
  if (!resolved.startsWith(outputDirectory + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('Image générée introuvable ou chemin non autorisé.');
  }
  return resolved;
}

ipcMain.handle('save-generated-image', async (_e, imagePath) => {
  try {
    const source = getTrustedGeneratedImage(imagePath);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), path.basename(source)),
      filters: [{ name: 'Images PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.copyFileSync(source, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (error) { return { ok: false, message: error.message }; }
});

ipcMain.handle('copy-generated-image', async (_e, imagePath) => {
  try {
    const source = getTrustedGeneratedImage(imagePath);
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty()) throw new Error('Image illisible.');
    clipboard.writeImage(image);
    return { ok: true };
  } catch (error) { return { ok: false, message: error.message }; }
});

ipcMain.handle('open-generated-image', async () => {
  if (!lastGeneratedImage || !fs.existsSync(lastGeneratedImage)) return { ok: false, message: 'Aucune image générée dans cette session.' };
  const error = await shell.openPath(lastGeneratedImage);
  return { ok: !error, message: error || 'Image ouverte.' };
});
ipcMain.handle('check-update', () => checkForUpdates());
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

// ---------- Transcription vocale locale (whisper.cpp + modèle ggml-base) ----------
// Tout tourne sur le PC : l'audio n'est envoyé à aucun service. Le moteur et le modèle
// sont téléchargés une seule fois, au premier usage de la dictée.
const WHISPER_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip';
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const WHISPER_MODEL_MIN_SIZE = 140 * 1024 * 1024;
let whisperReady = null;

function whisperDirectory() {
  return path.join(app.getPath('userData'), 'models', 'whisper');
}

function findWhisperExe(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findWhisperExe(full);
      if (found) return found;
    } else if (['whisper-cli.exe', 'main.exe'].includes(entry.name.toLowerCase())) {
      return full;
    }
  }
  return null;
}

function ensureWhisper() {
  if (whisperReady) return whisperReady;
  whisperReady = (async () => {
    const dir = whisperDirectory();
    fs.mkdirSync(dir, { recursive: true });
    let exe = findWhisperExe(dir);
    if (!exe) {
      const zip = path.join(dir, 'whisper-bin-x64.zip');
      report('Téléchargement du moteur de dictée (une seule fois)…');
      await downloadTo(WHISPER_ZIP_URL, zip, (percent) => report('Moteur de dictée : ' + percent + ' %'));
      const binDir = path.join(dir, 'bin');
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${binDir}' -Force`],
        { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
      exe = findWhisperExe(binDir);
      if (!exe) throw new Error('Exécutable whisper introuvable après extraction.');
    }
    const modelPath = path.join(dir, 'ggml-base.bin');
    if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < WHISPER_MODEL_MIN_SIZE) {
      report('Téléchargement du modèle de dictée (environ 148 Mo, une seule fois)…');
      const temporary = modelPath + '.download';
      await downloadTo(WHISPER_MODEL_URL, temporary, (percent) => report('Modèle de dictée : ' + percent + ' %'));
      fs.renameSync(temporary, modelPath);
    }
    return { exe, modelPath };
  })().catch((err) => {
    whisperReady = null;
    throw err;
  });
  return whisperReady;
}

ipcMain.handle('transcribe', async (_e, wavBuffer) => {
  const { exe, modelPath } = await ensureWhisper();
  const wavPath = path.join(app.getPath('temp'), 'overlayia-dictee-' + Date.now() + '.wav');
  fs.writeFileSync(wavPath, Buffer.from(wavBuffer));
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(exe, ['-m', modelPath, '-f', wavPath, '-l', 'fr', '-nt', '-np'],
        { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out)));
    });
    return String(stdout).trim();
  } finally {
    fs.rm(wavPath, { force: true }, () => {});
  }
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

  // Les moteurs locaux restent arrêtés au repos et démarrent à la première requête.
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Nettoyage du dossier temporaire de session (images non enregistrées).
  fs.rmSync(path.join(app.getPath('temp'), 'OverlayIA-session'), { recursive: true, force: true });
});

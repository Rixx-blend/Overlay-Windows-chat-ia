const bridge = window.api;
const $ = (id) => document.getElementById(id);

const card = $('card');
const chat = $('chat');
const input = $('input');
const send = $('send');
const mic = $('mic');
const newchat = $('newchat');
const attach = $('attach');
const file = $('file');
const tray = $('tray');
const modelBtn = $('modelBtn');
const modelName = $('modelName');
const menu = $('menu');
const settingsBtn = $('settingsBtn');
const closePanel = $('closePanel');
const imagesBtn = $('imagesBtn');
const closeImages = $('closeImages');
const imagePanel = $('imagePanel');


// Seule IA utilisée : la locale (Ollama). Pas de clé API nécessaire pour le chat.
const MODELS = { ollama: ['qwen2.5vl:3b'] };
const LEVEL_LABELS = { low: 'Bas', high: 'Haut', max: 'Max' };
const levelBtn = $('levelBtn');
const levelName = $('levelName');
const levelMenu = $('levelMenu');
let setupLine = null; // ligne de progression de l'installation proposée dans le chat
const PLACEHOLDER = "Demander n'importe quoi...";
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_TEXT = 200 * 1024;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|js|jsx|ts|tsx|py|html|css|xml|ya?ml|ini|log|bat|ps1|cfg|java|c|cpp|h|cs|go|rs|sql)$/i;
const ACTION_RE = /```(?:action|json)\s*([\s\S]*?)```/;
const LEVEL_BARS = { low: 1, high: 2, max: 3 };

let settings = { engine: 'ollama', model: 'qwen2.5vl:3b', level: 'low', autoUpdate: true, allowActions: true };
let messages = [];
let pending = [];
let current = null; // bulle de réponse en cours
let aiText = '';
let lastAsk = ''; // dernier message de l'utilisateur : dit si son action était demandée
// « ouvre Blender », « lance la calculatrice »… : le nom de l'application est le groupe 2
const LAUNCH_RE = /^(?:peux[- ]tu\s+)?(ouvre|ouvrir|lance|lancer|d[ée]marre|d[ée]marrer)(?:-moi)?\s+(?:moi\s+)?(?:le\s+|la\s+|les\s+|l')?(.+?)\s*[.!?]*$/i;
// Verbes d'action demandés par l'utilisateur : dans ce cas la commande est exécutée sans confirmation
const ASK_ACTION_RE = /(ouvr|lanc|d[ée]marr|ferm|supprim|effac|install|ex[ée]cut|affich|minimis|maximis|cr[ée]e|renomm|copi|colle)/i;
const LEVEL_ORDER = ['low', 'high', 'max'];
let busy = false;
let recorder = null;
let transcribing = false;
let closeTimer = null;
let hovering = false;
let dragging = false;
let dragQueued = false;

// ---------- Ouverture / fermeture de la carte ----------
function setOpen(open) {
  card.classList.toggle('open', open);
}

function keepOpen() {
  clearTimeout(closeTimer);
  setOpen(true);
}

function canClose() {
  return (
    messages.length === 0 &&
    !input.value &&
    pending.length === 0 &&
    !recorder &&
    !transcribing &&
    !busy &&
    !hovering &&
    menu.hidden &&
    levelMenu.hidden &&
    !document.querySelector('.setup') &&
    !card.classList.contains('settings') &&
    document.activeElement !== input
  );
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (canClose()) setOpen(false);
  }, 300);
}

// Le processus principal indique si le curseur est sur la carte
bridge.onHover((v) => {
  hovering = v;
  if (v) keepOpen();
  else scheduleClose();
});

// Le processus principal doit connaître la zone de la carte pour savoir où capter les clics
new ResizeObserver(() => {
  const r = card.getBoundingClientRect();
  bridge.cardRect({ x: r.left, y: r.top, w: r.width, h: r.height });
}).observe(card);
input.addEventListener('focus', keepOpen);
input.addEventListener('blur', scheduleClose);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (card.classList.contains('images')) {
    closeImagePanel();
  } else if (card.classList.contains('settings')) {
    closeSettings();
  } else if (!menu.hidden || !levelMenu.hidden) {
    menu.hidden = true;
    levelMenu.hidden = true;
  } else {
    input.blur();
    if (!messages.length) setOpen(false);
  }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
send.addEventListener('click', submit);

// ---------- Déplacement de la carte (suit le curseur) ----------
card.addEventListener('pointerdown', (e) => {
  bridge.focusWindow();
  if (e.button !== 0 || e.target.closest('input, button, .menu, .chat, .tray, .panel')) return;
  dragging = true;
  bridge.dragStart();
  card.setPointerCapture(e.pointerId);
});
card.addEventListener('pointermove', () => {
  if (!dragging || dragQueued) return;
  dragQueued = true;
  requestAnimationFrame(() => {
    dragQueued = false;
    bridge.dragMove();
  });
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  bridge.dragEnd();
}
card.addEventListener('pointerup', endDrag);
card.addEventListener('pointercancel', endDrag);

// ---------- Pièces jointes ----------
function flash(text) {
  input.placeholder = text;
  setTimeout(() => (input.placeholder = PLACEHOLDER), 2500);
}

function readAsDataURL(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

// Image réduite (1024 px max) et convertie en JPEG : le modèle local accepte mal les grands fichiers
async function shrinkImage(f) {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.9);
}

async function readAttachment(f) {
  const base = { name: f.name, size: f.size };
  if (f.type.startsWith('image/')) {
    if (f.size > MAX_IMAGE) throw new Error(`${f.name} : image trop lourde (8 Mo max)`);
    return { ...base, kind: 'image', url: await shrinkImage(f) };
  }
  if (f.type.startsWith('text/') || TEXT_EXT.test(f.name)) {
    const text = await f.slice(0, MAX_TEXT).text();
    return { ...base, kind: 'text', text, snip: text.slice(0, 160) };
  }
  return { ...base, kind: 'file', ext: (f.name.split('.').pop() || '?').slice(0, 4).toUpperCase() };
}

attach.addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const files = [...file.files];
  file.value = '';
  for (const f of files) {
    try {
      pending.push(await readAttachment(f));
    } catch (err) {
      flash(err.message);
    }
  }
  renderTray();
  keepOpen();
});

function renderTray() {
  tray.replaceChildren();
  pending.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip ' + a.kind;
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.url;
      chip.appendChild(img);
    } else if (a.kind === 'text') {
      const s = document.createElement('div');
      s.className = 'snip';
      s.textContent = a.snip;
      chip.appendChild(s);
    } else {
      const f = document.createElement('div');
      f.className = 'fico';
      f.textContent = a.ext;
      chip.appendChild(f);
    }
    const n = document.createElement('div');
    n.className = 'cname';
    n.textContent = a.name;
    chip.appendChild(n);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Retirer';
    x.onclick = () => {
      pending.splice(i, 1);
      renderTray();
      scheduleClose();
    };
    chip.appendChild(x);
    tray.appendChild(chip);
  });
  tray.hidden = pending.length === 0;
}

// Contenu envoyé à l'IA : texte + fichiers texte inline + images
function buildContent(text) {
  let body = text;
  const images = [];
  for (const a of pending) {
    if (a.kind === 'text') body += `\n\n[Fichier ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
    else if (a.kind === 'file') body += `\n\n[Fichier joint : ${a.name} (contenu non lisible directement)]`;
    else if (a.kind === 'image') images.push(a);
  }
  if (!images.length) return body;
  return [
    { type: 'text', text: body || 'Décris cette image.' },
    ...images.map((a) => ({ type: 'image_url', image_url: { url: a.url } })),
  ];
}

// ---------- Messages ----------
function addBubble(role, text, atts = []) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  if (atts.length) {
    const d = document.createElement('div');
    d.className = 'att';
    d.textContent = '📎 ' + atts.map((a) => a.name).join(', ');
    el.appendChild(d);
  }
  chat.appendChild(el);
  chat.classList.add('has');
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function submit() {
  const text = input.value.trim();
  if (busy || (!text && !pending.length)) return;
  lastAsk = text;
  // « ouvre X » : ouverture directe, sans passer par le modèle
  const lancer = text.match(LAUNCH_RE);
  if (lancer && !pending.length) {
    input.value = '';
    addBubble('user', text);
    messages.push({ role: 'user', content: text });
    bridge.launchApp(lancer[2]).then((r) => {
      addBubble('sys', r.out);
      messages.push({ role: 'user', content: `Résultat : ${r.out}` });
    });
    return;
  }
  const atts = pending.slice();
  const content = buildContent(text);
  addBubble('user', text, atts);
  messages.push({ role: 'user', content });
  input.value = '';
  pending = [];
  renderTray();
  startAI();
}

// Indicateur de réflexion : grille de pixels en vague, libellé qui scintille, temps écoulé
function makeLoader(label) {
  const wrap = document.createElement('div');
  wrap.className = 'thinking';
  const grid = document.createElement('span');
  grid.className = 'px-grid';
  for (let i = 0; i < 9; i++) {
    const r = Math.floor(i / 3);
    const c = i % 3;
    const cell = document.createElement('span');
    cell.style.animationDelay = (c + Math.abs(r - 1)) * 90 + 'ms';
    grid.appendChild(cell);
  }
  const text = document.createElement('span');
  text.className = 'shimmer';
  text.textContent = label;
  const time = document.createElement('span');
  time.className = 'timer';
  const t0 = performance.now();
  const tick = setInterval(() => {
    const s = (performance.now() - t0) / 1000;
    time.textContent = s < 60 ? s.toFixed(1) + 's' : `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
  }, 100);
  wrap.append(grid, text, time);
  return { el: wrap, stop: () => clearInterval(tick) };
}

let stopLoader = null;

function startAI() {
  current = addBubble('ai', '');
  aiText = '';
  busy = true;
  send.classList.add('busy');
  const loader = makeLoader('Réflexion');
  stopLoader = loader.stop;
  current.replaceChildren(loader.el);
  bridge.chat(messages, {
    engine: settings.engine,
    model: settings.model,
    level: settings.level,
    allowActions: settings.allowActions,
  });
}

bridge.onToken((t) => {
  if (!current) return;
  if (stopLoader) {
    stopLoader();
    stopLoader = null;
  }
  aiText += t;
  current.textContent = aiText;
  chat.scrollTop = chat.scrollHeight;
});

bridge.onDone((err) => {
  busy = false;
  send.classList.remove('busy');
  if (stopLoader) {
    stopLoader();
    stopLoader = null;
  }
  if (!current) return;
  if (err) {
    current.classList.add('err');
    current.textContent = 'Erreur : ' + err;
  } else {
    const m = aiText.match(ACTION_RE);
    const shown = aiText.replace(ACTION_RE, '').trim();
    current.textContent = shown || (m ? '' : '(réponse vide)');
    messages.push({ role: 'assistant', content: aiText });
    if (m && settings.allowActions) proposeAction(m[1]);
  }
  current = null;
  chat.scrollTop = chat.scrollHeight;
  scheduleClose();
});

// Exécute une commande sans demander (quand l'utilisateur l'a demandée lui-même)
async function runCmd(cmd) {
  const r = await bridge.runCommand(cmd);
  addBubble('sys', (r.ok ? 'Résultat :\n' : 'Échec :\n') + r.out);
  messages.push({ role: 'user', content: `Résultat de la commande "${cmd}" :\n${r.out}` });
}

// Commande proposée par l'IA : exécutée directement si l'utilisateur a demandé une action,
// sinon affichée et exécutée seulement après validation
function proposeAction(raw) {
  let cmd = '';
  try {
    cmd = String(JSON.parse(raw.trim()).command || '');
  } catch {
    addBubble('sys', 'Commande illisible.');
    return;
  }
  if (ASK_ACTION_RE.test(lastAsk)) {
    runCmd(cmd);
    return;
  }
  if (!cmd) return;

  const box = document.createElement('div');
  box.className = 'action';
  const label = document.createElement('div');
  label.textContent = 'Commande proposée sur votre PC :';
  const pre = document.createElement('pre');
  pre.textContent = cmd;
  const row = document.createElement('div');
  row.className = 'act-row';
  const no = document.createElement('button');
  no.className = 'btn';
  no.textContent = 'Refuser';
  const yes = document.createElement('button');
  yes.className = 'btn dark';
  yes.textContent = 'Exécuter';
  row.append(no, yes);
  box.append(label, pre, row);
  chat.appendChild(box);
  chat.scrollTop = chat.scrollHeight;

  const lock = () => (yes.disabled = no.disabled = true);
  no.onclick = () => {
    lock();
    addBubble('sys', 'Commande refusée.');
  };
  yes.onclick = async () => {
    lock();
    yes.textContent = 'Exécution…';
    const r = await bridge.runCommand(cmd);
    addBubble('sys', (r.ok ? 'Résultat :\n' : 'Échec :\n') + r.out);
    messages.push({ role: 'user', content: `Résultat de la commande "${cmd}" :\n${r.out}` });
    yes.textContent = 'Exécutée';
  };
}

newchat.addEventListener('click', () => {
  if (busy) return;
  messages = [];
  pending = [];
  chat.replaceChildren();
  chat.classList.remove('has');
  renderTray();
  input.focus();
});

// ---------- Dictée vocale ----------
mic.addEventListener('click', toggleMic);

async function toggleMic() {
  if (transcribing) return;
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    flash('Micro indisponible');
    return;
  }
  const chunks = [];
  const opts = MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : {};
  const rec = new MediaRecorder(stream, opts);
  recorder = rec;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    mic.classList.remove('rec');
    transcribing = true;
    mic.classList.add('busy');
    try {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const text = await bridge.transcribe(await blob.arrayBuffer());
      input.value = (input.value ? input.value + ' ' : '') + text.trim();
    } catch {
      flash('Transcription impossible');
    }
    transcribing = false;
    mic.classList.remove('busy');
    keepOpen();
    input.focus();
  };
  rec.start();
  mic.classList.add('rec');
  keepOpen();
}

// ---------- Choix du modèle ----------
function renderMenu() {
  menu.replaceChildren();
  for (const m of MODELS[settings.engine]) {
    const b = document.createElement('button');
    b.textContent = m;
    if (m === settings.model) b.className = 'on';
    b.onclick = (e) => {
      e.stopPropagation();
      settings.model = m;
      bridge.setSettings({ model: m });
      menu.hidden = true;
      renderMenu();
      scheduleClose();
    };
    menu.appendChild(b);
  }
  modelName.textContent = settings.model;
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  levelMenu.hidden = true;
  menu.hidden = !menu.hidden;
  if (!menu.hidden) {
    renderMenu();
    keepOpen();
  } else {
    scheduleClose();
  }
});

// ---------- Niveau de réflexion (à côté du modèle) ----------
function renderLevel() {
  levelName.textContent = LEVEL_LABELS[settings.level] || 'Bas';
  const bars = LEVEL_BARS[settings.level] || 1;
  document.querySelectorAll('#levelBars rect').forEach((r, i) => r.classList.toggle('off', i >= bars));
  levelMenu.replaceChildren();
  for (const [value, label] of Object.entries(LEVEL_LABELS)) {
    const b = document.createElement('button');
    b.textContent = label;
    if (value === settings.level) b.className = 'on';
    b.onclick = (e) => {
      e.stopPropagation();
      settings.level = value;
      bridge.setSettings({ level: value });
      levelMenu.hidden = true;
      renderLevel();
      scheduleClose();
    };
    levelMenu.appendChild(b);
  }
}

// Un clic fait passer au niveau suivant : Bas, Haut, Max, puis Bas
levelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = true;
  levelMenu.hidden = true;
  const i = LEVEL_ORDER.indexOf(settings.level);
  settings.level = LEVEL_ORDER[(i + 1) % LEVEL_ORDER.length];
  bridge.setSettings({ level: settings.level });
  renderLevel();
  keepOpen();
});

// ---------- Paramètres ----------
async function refreshOllama() {
  const el = $('ollamaStatus');
  try {
    const s = await bridge.ollamaStatus();
    el.textContent = s.running && s.hasModel
      ? 'Prête'
      : s.installed || s.running
        ? 'Installée, modèle à télécharger'
        : 'Non installée';
  } catch {
    el.textContent = 'État inconnu';
  }
}

function fillPanel() {
  $('autoUpd').checked = !!settings.autoUpdate;
  $('allowAct').checked = !!settings.allowActions;
  refreshOllama();
  bridge.getVersion().then((v) => ($('version').textContent = v));
}

function openSettings() {
  card.classList.add('settings');
  keepOpen();
  fillPanel();
}

// ---------- Générateur local Stable Diffusion XL ----------
function closeImagePanel() {
  card.classList.remove('images');
  scheduleClose();
}

async function refreshSdxlStatus() {
  const status = $('sdxlStatus');
  status.textContent = 'Vérification de ComfyUI…';
  try {
    const result = await bridge.imageStatus();
    status.textContent = result.message;
    status.classList.toggle('status-ready', result.running && result.installed);
    status.classList.toggle('status-error', !result.running || !result.installed);
  } catch (err) {
    status.textContent = 'État indisponible : ' + err.message;
    status.classList.add('status-error');
  }
}

function openImagePanel() {
  card.classList.remove('settings');
  card.classList.add('images');
  keepOpen();
  refreshSdxlStatus();
}

imagesBtn.addEventListener('click', openImagePanel);
closeImages.addEventListener('click', closeImagePanel);
$('checkSdxl').addEventListener('click', refreshSdxlStatus);

$('generateImage').addEventListener('click', async () => {
  const button = $('generateImage');
  const result = $('imageResult');
  button.disabled = true;
  result.hidden = true;
  $('imageProgress').textContent = 'Préparation…';
  try {
    const generated = await bridge.generateImage({
      prompt: $('imagePrompt').value,
      negative: $('imageNegative').value,
      width: Number($('imageWidth').value),
      height: Number($('imageHeight').value),
      steps: Number($('imageSteps').value),
    });
    $('generatedImage').src = generated.dataUrl;
    $('imageSavedPath').textContent = 'Enregistrée dans Images/OverlayIA';
    result.hidden = false;
    $('imageProgress').textContent = 'Génération terminée.';
  } catch (err) {
    $('imageProgress').textContent = 'Erreur : ' + err.message;
    refreshSdxlStatus();
  } finally {
    button.disabled = false;
  }
});

bridge.onImageProgress((message) => {
  $('imageProgress').textContent = message;
});

$('openGeneratedImage').addEventListener('click', async () => {
  const result = await bridge.openGeneratedImage();
  $('imageProgress').textContent = result.message;
});


function closeSettings() {
  card.classList.remove('settings');
  scheduleClose();
}

settingsBtn.addEventListener('click', openSettings);
closePanel.addEventListener('click', closeSettings);

$('autoUpd').addEventListener('change', (e) => {
  settings.autoUpdate = e.target.checked;
  bridge.setSettings({ autoUpdate: settings.autoUpdate });
});

$('allowAct').addEventListener('change', (e) => {
  settings.allowActions = e.target.checked;
  bridge.setSettings({ allowActions: settings.allowActions });
});

$('installAI').addEventListener('click', async () => {
  const btn = $('installAI');
  btn.disabled = true;
  $('ollamaProg').textContent = 'Démarrage…';
  try {
    $('ollamaProg').textContent = await bridge.installLocalAI();
  } catch (err) {
    $('ollamaProg').textContent = 'Erreur : ' + err.message;
  }
  btn.disabled = false;
  refreshOllama();
});

bridge.onImageProgress((t) => {
  if (setupLine) setupLine.textContent = t;
});

bridge.onOllamaProgress((t) => {
  $('ollamaProg').textContent = t;
  if (setupLine) setupLine.textContent = t;
  if (/prête/i.test(t)) {
    refreshOllama();
    const box = document.querySelector('.setup');
    if (box) setTimeout(() => box.remove(), 1500);
  }
});

// Proposition d'installation dans le chat, affichée tant que le modèle n'est pas prêt

function showSetupPrompt(status) {
  const box = document.createElement('div');
  box.className = 'action setup';
  const label = document.createElement('div');
  label.textContent = 'Vérification des modèles locaux';
  const details = document.createElement('div');
  details.className = 'prog';
  const qwenRow = document.createElement('div');
  qwenRow.className = 'act-row';
  const qwenLabel = document.createElement('span');
  const qwenButton = document.createElement('button');
  qwenButton.className = 'btn dark';
  qwenButton.textContent = 'Télécharger Qwen';
  qwenRow.append(qwenLabel, qwenButton);

  const sdxlRow = document.createElement('div');
  sdxlRow.className = 'act-row';
  const sdxlLabel = document.createElement('span');
  const sdxlButton = document.createElement('button');
  sdxlButton.className = 'btn dark';
  sdxlButton.textContent = 'Télécharger SDXL · 6,94 Go';
  sdxlRow.append(sdxlLabel, sdxlButton);

  const prog = document.createElement('div');
  prog.className = 'prog';
  const row = document.createElement('div');
  row.className = 'act-row';
  const later = document.createElement('button');
  later.className = 'btn';
  later.textContent = 'Plus tard';
  row.append(later);
  box.append(label, details, qwenRow, sdxlRow, prog, row);
  chat.appendChild(box);
  chat.classList.add('has');
  setupLine = prog;
  keepOpen();

  const update = (s) => {
    qwenLabel.textContent = s.qwenInstalled ? 'Qwen 2.5 VL 3B · installé' : 'Qwen 2.5 VL 3B · manquant';
    qwenButton.disabled = !!s.qwenInstalled;
    qwenButton.textContent = s.qwenInstalled ? 'Installé' : 'Télécharger';
    sdxlLabel.textContent = s.sdxlInstalled
      ? 'Stable Diffusion XL 1.0 · installé'
      : 'Stable Diffusion XL 1.0 · manquant';
    sdxlButton.disabled = !!s.sdxlInstalled;
    sdxlButton.textContent = s.sdxlInstalled ? 'Installé' : 'Télécharger · 6,94 Go';
    details.textContent = !s.comfyRunning
      ? (s.sdxlInstalled
        ? 'Les fichiers SDXL sont présents, mais ComfyUI ne répond pas sur le port 8188. Démarre ComfyUI pour générer des images.'
        : 'ComfyUI ne répond pas sur le port 8188. S’il est déjà installé, démarre-le après le téléchargement du checkpoint.')
      : 'ComfyUI détecté.';
    if (!s.needsSetup && s.comfyRunning) {
      label.textContent = 'Les deux modèles sont installés.';
      prog.textContent = 'Configuration locale prête.';
      setTimeout(() => {
        box.remove();
        setupLine = null;
      }, 1200);
    } else if (!s.needsSetup) {
      label.textContent = 'Les deux modèles sont présents.';
    }
  };
  update(status);

  later.onclick = () => {
    box.remove();
    setupLine = null;
    scheduleClose();
  };
  qwenButton.onclick = async () => {
    qwenButton.disabled = later.disabled = sdxlButton.disabled = true;
    prog.textContent = 'Préparation d’Ollama et téléchargement de Qwen…';
    try {
      await bridge.installLocalAI();
    } catch (err) {
      prog.textContent = 'Erreur Qwen : ' + err.message;
    } finally {
      later.disabled = false;
      update(await bridge.startupModelsStatus());
    }
  };
  sdxlButton.onclick = async () => {
    qwenButton.disabled = later.disabled = sdxlButton.disabled = true;
    prog.textContent = 'Téléchargement automatique dans le dossier checkpoints de ComfyUI (6,94 Go)…';
    try {
      const result = await bridge.downloadSdxlModel();
      if (result.cancelled) {
        prog.textContent = 'Téléchargement annulé.';
      } else {
        const next = await bridge.startupModelsStatus();
        update(next);
        if (!next.comfyRunning) {
          prog.textContent = 'Checkpoint téléchargé. Démarre ComfyUI, puis actualise le statut dans l’onglet Images.';
        }
      }
    } catch (err) {
      prog.textContent = 'Erreur SDXL : ' + err.message;
    } finally {
      later.disabled = false;
      update(await bridge.startupModelsStatus());
    }
  };
}

// ---------- Mises à jour ----------
$('checkUpd').addEventListener('click', async () => {
  const r = await bridge.checkUpdate();
  if (!r.ok) $('updStatus').textContent = r.message;
});

bridge.onUpdateStatus((s) => {
  const el = $('updStatus');
  if (s.state === 'ready') {
    el.textContent = `Version ${s.version} prête.`;
    $('restartUpd').hidden = false;
    return;
  }
  const texts = {
    checking: 'Recherche de mise à jour…',
    available: `Version ${s.version} trouvée, téléchargement…`,
    downloading: `Téléchargement : ${s.percent} %`,
    none: 'Vous êtes à jour.',
    error: 'Erreur de mise à jour : ' + s.message,
  };
  el.textContent = texts[s.state] || '';
});

$('restartUpd').addEventListener('click', () => bridge.installUpdate());

// ---------- Glisser depuis la carte, focus depuis les raccourcis ----------
bridge.onFocus(() => {
  keepOpen();
  input.focus();
});

// ---------- Démarrage ----------
(async function init() {
  try {
    settings = { ...settings, ...(await bridge.getSettings()) };
  } catch {
    /* valeurs par défaut */
  }
  // Toujours l'IA locale : d'anciens réglages OpenAI sont ignorés
  settings.engine = 'ollama';
  settings.model = 'qwen2.5vl:3b';
  if (!LEVEL_LABELS[settings.level]) settings.level = 'low';
  // Une seule fois : activer les actions PC par défaut (chaque commande reste validée)
  if (!settings.actionsOn) {
    settings.allowActions = true;
    settings.actionsOn = true;
    bridge.setSettings({ allowActions: true, actionsOn: true });
  }
  input.placeholder = PLACEHOLDER;
  renderMenu();
  renderLevel();

  // IA locale déjà installée : rien à faire. Sinon, on propose l'installation.
  try {
    const s = await bridge.startupModelsStatus();
    if (s.needsSetup || !s.comfyRunning) showSetupPrompt(s);
  } catch {
    showSetupPrompt({ qwenInstalled: false, sdxlInstalled: false, comfyRunning: false, needsSetup: true });
  }
})();

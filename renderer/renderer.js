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
const imageModeBtn = $('imageModeBtn');


// Seule IA utilisée : la locale (Ollama). Pas de clé API nécessaire pour le chat.
const MODELS = { ollama: ['qwen2.5vl:3b'] };
const LEVEL_LABELS = { low: 'Bas', high: 'Haut', max: 'Max' };
const levelBtn = $('levelBtn');
const levelName = $('levelName');
const levelMenu = $('levelMenu');
let setupLine = null; // ligne de progression de l'installation proposée dans le chat
const PLACEHOLDER = "Demander n'importe quoi...";
let imageMode = false;
let imageProgressLabel = null;
let lastGeneratedImagePath = null;
let lastGeneratedImageDataUrl = null;
let editReferenceDataUrl = null;
let references = [];
let dragDepth = 0;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_TEXT = 200 * 1024;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|js|jsx|ts|tsx|py|html|css|xml|ya?ml|ini|log|bat|ps1|cfg|java|c|cpp|h|cs|go|rs|sql)$/i;
const ACTION_RE = /```(?:action|json)\s*([\s\S]*?)```/;
const LEVEL_BARS = { low: 1, high: 2, max: 3 };

let settings = { engine: 'ollama', model: 'qwen2.5vl:3b', level: 'low', autoUpdate: true, allowActions: true, webSearch: false };
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
let activeComputerBubble = null;
let activeComputerLoader = null;
let activeComputerMainLabel = null;
let activeComputerFeed = null;
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
    !imageMode &&
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
  if (card.classList.contains('settings')) {
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
  await addFiles(files, false);
});

async function addFiles(files, asReferences = false) {
  for (const f of [...files]) {
    try {
      const attachment = await readAttachment(f);
      if (asReferences) {
        if (attachment.kind !== 'image') throw new Error('Les références doivent être des images.');
        if (references.length >= 1) throw new Error('Une seule référence principale est acceptée par modification pour préserver sa qualité.');
        references.push(attachment);
      } else {
        pending.push(attachment);
      }
    } catch (err) { flash(err.message); }
  }
  renderTray();
  renderReferences();
  keepOpen();
}

function renderReferences() {
  const wrap = $('referencePreviews');
  if (!wrap) return;
  wrap.replaceChildren();
  $('referenceCount').textContent = references.length
    ? references.length + ' référence' + (references.length > 1 ? 's' : '')
    : 'Aucune référence';
  references.forEach((ref, index) => {
    const img = document.createElement('img');
    img.src = ref.url;
    img.alt = ref.name;
    img.title = ref.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Retirer la référence';
    remove.addEventListener('click', () => { references.splice(index, 1); renderReferences(); });
    const item = document.createElement('div');
    item.className = 'reference-thumb';
    item.append(img, remove);
    wrap.appendChild(item);
  });
}

const referenceFiles = $('referenceFiles');
referenceFiles.addEventListener('change', async () => {
  const files = [...referenceFiles.files];
  referenceFiles.value = '';
  await addFiles(files, true);
});

async function handleDropFiles(files) {
  if (!files.length) return;
  const imageOnly = imageMode && files.every((f) => f.type.startsWith('image/'));
  await addFiles(files, imageOnly);
}
[card, chat].forEach((target) => {
  target.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    card.classList.add('file-drag-over');
    keepOpen();
  });
  target.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  target.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) { dragDepth = 0; card.classList.remove('file-drag-over'); }
  });
  target.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    card.classList.remove('file-drag-over');
    await handleDropFiles(e.dataTransfer.files);
  });
});
window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });

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
  const removeBgRequest = /(?:supprime|enl[eè]ve|retire|d[eé]tour(?:e|er)?|isole).{0,45}(?:fond|arri[eè]re[- ]plan)|(?:fond|arri[eè]re[- ]plan).{0,35}(?:transparent|supprim[eé])/i.test(text);
  if (removeBgRequest && lastGeneratedImagePath && !pending.length) {
    input.value = '';
    addBubble('user', text);
    messages.push({ role: 'user', content: text });
    removeBackgroundInChat(lastGeneratedImagePath);
    return;
  }
  const imagePrompt = !pending.length ? (imageMode ? text : extractImagePrompt(text)) : null;
  // Les demandes qui manipulent le PC passent par Computer Use.
  const lancer = text.match(LAUNCH_RE);
  const simpleLaunch = !!lancer &&
    !/\b(?:et|puis|ensuite|dossier|fichier|t[ée]l[ée]chargements?|downloads?|bureau|documents?|images?|png|jpe?g|trouve|cherche|supprime|efface|clique|d[ée]place|renomme|copie|colle)\b/i.test(lancer[2]);
  const startsComputerTask = /^(?:peux[- ]tu\s+)?(?:ouvre|ouvrir|lance|lancer|d[ée]marre|d[ée]marrer|trouve|chercher|cherche|recherche|supprime|supprimer|efface|effacer|clique|cliquer|d[ée]place|renomme|copie|colle)\b/i.test(text);
  if (startsComputerTask && !simpleLaunch && !pending.length && settings.allowActions) {
    input.value = '';
    addBubble('user', text);
    startComputerActivityBubble('Préparation du contrôle de l’ordinateur…');
    bridge.computerUseStart(text).then((result) => {
      if (!result.ok && activeComputerBubble) {
        if (activeComputerLoader) activeComputerLoader();
        activeComputerBubble.textContent = result.error || 'Démarrage impossible.';
        activeComputerBubble = null; activeComputerFeed = null; activeComputerLoader = null;
      }
    }).catch((error) => {
      if (activeComputerBubble) {
        if (activeComputerLoader) activeComputerLoader();
        activeComputerBubble.textContent = 'Computer Use : ' + error.message;
        activeComputerBubble = null; activeComputerFeed = null; activeComputerLoader = null;
      }
    });
    return;
  }

  // « ouvre X » seul : ouverture directe, sans passer par le modèle
  if (lancer && simpleLaunch && !pending.length) {
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
  if (imageMode || imagePrompt !== null) {
    const prompt = imagePrompt || text || 'Créer une image à partir des références fournies';
    const refs = [
      ...references.map((ref) => ref.url),
      ...atts.filter((a) => a.kind === 'image').map((a) => a.url),
    ];
    references = [];
    renderReferences();
    setImageMode(false);
    generateImageInChat(prompt, refs);
    return;
  }
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
  return { el: wrap, label: text, stop: () => clearInterval(tick) };
}

let stopLoader = null;

function startAI() {
  current = addBubble('ai', '');
  aiText = '';
  pendingSources = [];
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
    webSearch: settings.webSearch,
  });
}

// ---------- Mise en forme des réponses (markdown sûr, sans HTML brut) ----------
// Le texte est échappé avant transformation : seules nos balises sont injectées.
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\+\+([^+\n]+)\+\+/g, '<u>$1</u>');
  s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function renderMarkdown(text) {
  let html = '';
  let list = null;
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = line.match(/^\s*[-•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    if (bullet) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${renderInline(bullet[1])}</li>`;
    } else if (numbered) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${renderInline(numbered[1])}</li>`;
    } else {
      closeList();
      if (heading) html += `<div class="md-h">${renderInline(heading[1])}</div>`;
      else if (line.trim()) html += `<p>${renderInline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

// Sources repliées sous la réponse : un clic ouvre le détail, un lien ouvre la page.
function addSourcesBlock(bubble, sources) {
  if (!sources || !sources.length) return;
  const details = document.createElement('details');
  details.className = 'sources';
  const summary = document.createElement('summary');
  summary.textContent = `Sources (${sources.length})`;
  details.appendChild(summary);
  sources.forEach((s, i) => {
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = '#';
    link.title = s.title || s.url;
    link.textContent = `[${i + 1}] ${s.url.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '')}`;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      bridge.openLink(s.url);
    });
    details.appendChild(link);
  });
  bubble.appendChild(details);
}

let pendingSources = [];
bridge.onSources((list) => {
  pendingSources = Array.isArray(list) ? list : [];
});

bridge.onToken((t) => {
  if (!current) return;
  if (stopLoader) {
    stopLoader();
    stopLoader = null;
  }
  aiText += t;
  current.innerHTML = renderMarkdown(aiText);
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
    current.innerHTML = renderMarkdown(shown) || (m ? '' : '<p>(réponse vide)</p>');
    addSourcesBlock(current, pendingSources);
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
  references = [];
  renderReferences();
  chat.replaceChildren();
  chat.classList.remove('has');
  renderTray();
  input.focus();
});

// ---------- Dictée vocale ----------
mic.addEventListener('click', toggleMic);

// Convertit l'enregistrement (webm) en WAV mono 16 kHz 16 bits, format attendu par whisper.cpp.
async function toWav16k(blob) {
  const decodeContext = new AudioContext();
  const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer());
  await decodeContext.close();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  return encodeWav(samples, rate);
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

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
      const text = await bridge.transcribe(await toWav16k(blob));
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
  $('webSearch').checked = !!settings.webSearch;
  $('tavilyKey').value = settings.tavilyKey || '';
  refreshOllama();
  bridge.getVersion().then((v) => ($('version').textContent = v));
}

function openSettings() {
  card.classList.add('settings');
  keepOpen();
  fillPanel();
}

// ---------- Génération d’images directement dans le chat ----------
function extractImagePrompt(text) {
  const normalized = String(text || '').trim();
  const asksForImage = /(?:g[ée]n[èe]re|cr[ée]e|dessine|produis|fais)\b[\s\S]{0,100}\b(?:image|illustration|visuel|photo|dessin)\b/i.test(normalized);
  if (!asksForImage) return null;
  return normalized
    .replace(/^.*?\b(?:image|illustration|visuel|photo|dessin)\b\s*/i, '')
    .replace(/^(?:de|d['’]|du|des|sur|avec|représentant)\s*/i, '')
    .trim() || normalized;
}

function setImageMode(enabled) {
  imageMode = !!enabled;
  card.classList.toggle('image-mode', imageMode);
  imageModeBtn.classList.toggle('on', imageMode);
  imageModeBtn.setAttribute('aria-pressed', String(imageMode));
  imageModeBtn.textContent = imageMode ? 'Fermer les réglages' : 'Générer une image';
  input.placeholder = imageMode ? 'Décris l’image à générer…' : PLACEHOLDER;
  if (imageMode) {
    card.classList.remove('settings');
    keepOpen();
    input.focus();
  }
}

const imageFormat = $('imageFormat');
const imageWidth = $('imageWidth');
const imageHeight = $('imageHeight');
const imageStyle = $('imageStyle');
const imageSteps = $('imageSteps');
const imageDenoise = $('imageDenoise');
const imageSeed = $('imageSeed');
imageDenoise.addEventListener('input', () => { $('denoiseValue').textContent = imageDenoise.value + ' %'; });
imageFormat.addEventListener('change', () => {
  if (imageFormat.value === 'custom') return;
  const [w, h] = imageFormat.value.split('x').map(Number);
  imageWidth.value = String(w);
  imageHeight.value = String(h);
});
[imageWidth, imageHeight].forEach((field) => field.addEventListener('input', () => {
  imageFormat.value = 'custom';
  updateImageSettingSummaries();
}));
function updateImageSettingSummaries() {
  $('resolutionSummary').textContent = imageWidth.value + ' × ' + imageHeight.value;
  $('styleSummary').textContent = ({
    none: 'Aucun', photorealistic: 'Photo', cinematic: 'Cinéma', '3d': '3D',
    illustration: 'Illustration', anime: 'Anime', graphic: 'Graphique', pixel: 'Pixel'
  })[imageStyle.value] || 'Aucun';
  $('detailsSummary').textContent = ({20:'Rapide',25:'Équilibré',30:'Détaillé'})[imageSteps.value] || 'Équilibré';
}
[imageStyle, imageSteps].forEach((field) => field.addEventListener('change', updateImageSettingSummaries));
imageFormat.addEventListener('change', updateImageSettingSummaries);
// Les interactions restent dans leur pastille : le clic sur une liste native
// ne doit pas être interprété comme un clic extérieur qui referme le popover.
document.querySelectorAll('.image-setting-wrap, .image-popover').forEach((element) => {
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('click', (event) => event.stopPropagation());
});
document.querySelectorAll('[data-image-popover]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = $('popover-' + button.dataset.imagePopover);
    const shouldOpen = target.hidden;
    document.querySelectorAll('.image-popover').forEach((popover) => { popover.hidden = true; });
    target.hidden = !shouldOpen;
  });
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.image-setting-wrap')) {
    document.querySelectorAll('.image-popover').forEach((popover) => { popover.hidden = true; });
  }
});
$('addImageReference').addEventListener('click', () => referenceFiles.click());
updateImageSettingSummaries();
imageModeBtn.addEventListener('click', () => {
  document.querySelectorAll('.image-popover').forEach((popover) => { popover.hidden = true; });
  setImageMode(!imageMode);
});

// Affiche l’image générée avec une révélation en mosaïque de pixels.
function createImageReveal(image) {
  const wrap = document.createElement('div');
  wrap.className = 'image-reveal';
  image.classList.add('chat-generated-image');
  image.style.opacity = '0';
  wrap.appendChild(image);

  const reveal = () => {
    if (!image.naturalWidth || !image.naturalHeight) {
      image.style.opacity = '1';
      return;
    }

    const displayWidth = Math.min(470, image.naturalWidth);
    const displayHeight = Math.min(330, image.naturalHeight * (displayWidth / image.naturalWidth));
    const cellSize = 18;
    const cols = Math.max(1, Math.ceil(displayWidth / cellSize));
    const rows = Math.max(1, Math.ceil(displayHeight / cellSize));
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const grid = document.createElement('div');
    grid.className = 'image-pixel-grid';
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    try {
      ctx.drawImage(image, 0, 0, cols, rows);
      const pixels = ctx.getImageData(0, 0, cols, rows).data;
      for (let i = 0; i < cols * rows; i++) {
        const cell = document.createElement('span');
        const offset = i * 4;
        cell.style.backgroundColor = `rgba(${pixels[offset]}, ${pixels[offset + 1]}, ${pixels[offset + 2]}, ${pixels[offset + 3] / 255})`;
        cell.style.animationDelay = `${Math.random() * 420}ms`;
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      requestAnimationFrame(() => {
        image.style.opacity = '1';
        grid.classList.add('is-revealing');
        setTimeout(() => grid.remove(), 950);
      });
    } catch {
      image.style.opacity = '1';
    }
  };

  if (image.complete && image.naturalWidth) reveal();
  else {
    image.addEventListener('load', reveal, { once: true });
    image.addEventListener('error', () => {
      wrap.classList.add('image-load-error');
      wrap.textContent = 'Impossible d’afficher l’image générée.';
    }, { once: true });
  }
  return wrap;
}

async function generateImageInChat(prompt, referenceImages = []) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt || busy) return;
  busy = true;
  send.classList.add('busy');
  current = addBubble('ai', '');
  const loader = makeLoader('Génération de l’image');
  stopLoader = loader.stop;
  imageProgressLabel = loader.el.querySelector('.shimmer');
  current.replaceChildren(loader.el);

  try {
    const width = Math.round(Number(imageWidth.value));
    const height = Math.round(Number(imageHeight.value));
    if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < 512 || height < 512 || width > 1536 || height > 1536
      || width % 8 !== 0 || height % 8 !== 0
      || width * height > 1500000) {
      throw new Error('Résolution invalide. Utilise des dimensions entre 512 et 1536, multiples de 8, sans dépasser 1,5 mégapixel.');
    }
    const stylePrompts = {
      photorealistic: 'photorealistic, realistic materials, natural lighting, highly detailed photography',
      cinematic: 'cinematic composition, dramatic lighting, film still, atmospheric depth',
      '3d': 'high-end 3D render, physically based materials, studio lighting, detailed 3D composition',
      illustration: 'detailed digital illustration, expressive shapes, polished illustration',
      anime: 'anime illustration, clean line art, expressive colors, detailed anime shading',
      graphic: 'professional graphic design, strong visual hierarchy, clean composition, art direction',
      pixel: 'pixel art, crisp pixel clusters, limited color palette, retro game aesthetic',
    };
    const style = stylePrompts[imageStyle.value] || '';
    const hasReference = referenceImages.length > 0;
    // SDXL comprend mal le français : les mots-clés courants sont traduits et placés
    // en tête de prompt, là où CLIP les lit avant la limite de 77 tokens.
    const frenchKeywords = [
      [/\bneige\b|\bneigeux\b/i, 'snow, snowflakes, snowy ground'],
      [/\bhiver\b|\bhivernal\b/i, 'winter scene'],
      [/\bnuit\b/i, 'night scene'],
      [/\bpluie\b|\bpluvieux\b/i, 'rain'],
      [/\bdésert\b/i, 'desert'],
      [/\bplage\b/i, 'beach'],
      [/\bforêt\b/i, 'forest'],
      [/\bville\b/i, 'city street'],
    ];
    const extraKeywords = frenchKeywords.filter(([pattern]) => pattern.test(cleanPrompt)).map(([, english]) => english);
    const promptWithKeywords = extraKeywords.length ? extraKeywords.join(', ') + ', ' + cleanPrompt : cleanPrompt;
    // En modification, on ajoute des négatifs structurels pour éviter les doublons
    // ou les membres en trop sur un personnage déjà présent dans la référence.
    const negative = 'low quality, blurry, distorted, deformed, text, watermark'
      + (hasReference ? ', extra limbs, duplicate, multiple heads, cropped' : '');
    const generated = await bridge.generateImage({
      prompt: style ? promptWithKeywords + ', ' + style : promptWithKeywords,
      negative,
      width,
      height,
      steps: Number(imageSteps.value) || 25,
      denoise: Number(imageDenoise.value) / 100,
      seed: imageSeed.value.trim() === '' ? null : Math.round(Number(imageSeed.value)),
      referenceImages,
      edit: hasReference,
    });
    if (!generated?.dataUrl) throw new Error('ComfyUI n’a renvoyé aucune image.');
    if (stopLoader) { stopLoader(); stopLoader = null; }
    imageProgressLabel = null;
    const image = document.createElement('img');
    image.className = 'chat-generated-image';
    image.alt = 'Image générée : ' + cleanPrompt;
    image.src = generated.dataUrl;
    const imageReveal = createImageReveal(image);
    const generatedPath = generated.path || null;
    const generatedDataUrl = generated.dataUrl;
    lastGeneratedImagePath = generatedPath;
    lastGeneratedImageDataUrl = generatedDataUrl;
    const caption = document.createElement('div');
    caption.className = 'generated-caption';
    caption.textContent = 'Image générée avec SDXL · non enregistrée, utilise Enregistrer pour la télécharger';
    const actions = document.createElement('div');
    actions.className = 'generated-actions';
    const actionIcons = {
      download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 17v3h14v-3"/></svg>',
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
      edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.5-1 10.8-10.8a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z"/></svg>',
      removeBg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"/><path d="m4 4 16 16M12 4v16M4 12h16"/></svg>'
    };
    const makeAction = (label, icon, handler, disabled = false) => {
      const button = document.createElement('button');
      button.className = 'generated-action-btn';
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML = icon + '<span>' + label + '</span>';
      button.disabled = disabled;
      button.addEventListener('click', handler);
      actions.appendChild(button);
    };
    makeAction('Télécharger', actionIcons.download, async () => {
      const result = await bridge.saveGeneratedImage(generatedPath);
      if (!result?.ok && result?.message) flash(result.message);
    }, !generatedPath);
    makeAction('Copier', actionIcons.copy, async () => {
      const result = await bridge.copyGeneratedImage(generatedPath);
      flash(result?.ok ? 'Image copiée' : (result?.message || 'Copie impossible'));
    }, !generatedPath);
    makeAction('Modifier', actionIcons.edit, () => {
      references = [{ name: 'Image à modifier', kind: 'image', url: generatedDataUrl }];
      renderReferences();
      setImageMode(true);
      input.value = '';
      input.placeholder = 'Décris les modifications à apporter…';
      input.focus();
    });
    makeAction('Supprimer le fond', actionIcons.removeBg, () => {
      if (generatedPath) removeBackgroundInChat(generatedPath);
    }, !generatedPath);
    current.replaceChildren(imageReveal, caption, actions);
    messages.push({ role: 'assistant', content: 'Image générée avec succès.' });
  } catch (err) {
    if (stopLoader) { stopLoader(); stopLoader = null; }
    imageProgressLabel = null;
    current.classList.add('err');
    current.textContent = 'Impossible de générer l’image : ' + err.message;
  } finally {
    busy = false;
    send.classList.remove('busy');
    current = null;
    chat.scrollTop = chat.scrollHeight;
    scheduleClose();
  }
}

bridge.onImageProgress((message) => {
  if (imageProgressLabel) imageProgressLabel.textContent = message;
});

async function removeBackgroundInChat(imagePath) {
  if (busy || !imagePath) return;
  busy = true;
  send.classList.add('busy');
  const resultBubble = addBubble('ai', '');
  const loader = makeLoader('Détourage local · rembg (ISNet)');
  stopLoader = loader.stop;
  imageProgressLabel = loader.el.querySelector('.shimmer');
  resultBubble.replaceChildren(loader.el);
  try {
    const result = await bridge.removeBackground(imagePath);
    if (!result?.dataUrl) throw new Error(result?.message || 'Le modèle n’a renvoyé aucun résultat.');
    if (stopLoader) { stopLoader(); stopLoader = null; }
    imageProgressLabel = null;
    const image = document.createElement('img');
    image.className = 'chat-generated-image transparent-preview';
    image.alt = 'Image détourée avec fond transparent';
    image.src = result.dataUrl;
    const caption = document.createElement('div');
    caption.className = 'generated-caption';
    caption.textContent = 'Fond supprimé · PNG avec transparence · utilise Télécharger pour l’enregistrer';
    const cutoutPath = result.path || null;
    const actions = document.createElement('div');
    actions.className = 'generated-actions';
    const addCutoutAction = (label, icon, handler) => {
      const button = document.createElement('button');
      button.className = 'generated-action-btn';
      button.type = 'button';
      button.title = label;
      button.innerHTML = icon + '<span>' + label + '</span>';
      button.addEventListener('click', handler);
      actions.appendChild(button);
    };
    addCutoutAction('Télécharger', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 17v3h14v-3"/></svg>', async () => {
      const saved = await bridge.saveGeneratedImage(cutoutPath);
      if (!saved?.ok && saved?.message) flash(saved.message);
    });
    addCutoutAction('Copier', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>', async () => {
      const copied = await bridge.copyGeneratedImage(cutoutPath);
      flash(copied?.ok ? 'Image copiée' : (copied?.message || 'Copie impossible'));
    });
    resultBubble.replaceChildren(image, caption, actions);
    lastGeneratedImagePath = result.path || lastGeneratedImagePath;
    messages.push({ role: 'assistant', content: 'Arrière-plan supprimé. PNG transparent enregistré.' });
  } catch (err) {
    if (stopLoader) { stopLoader(); stopLoader = null; }
    imageProgressLabel = null;
    resultBubble.classList.add('err');
    resultBubble.textContent = 'Suppression du fond impossible : ' + err.message;
  } finally {
    busy = false;
    send.classList.remove('busy');
    chat.scrollTop = chat.scrollHeight;
    scheduleClose();
  }
}

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

// ---------- Agent visuel Computer Use ----------
const computerStart = $('computerStart');
const computerStop = $('computerStop');
const computerTask = $('computerTask');
const computerStatus = $('computerStatus');
const computerHistory = $('computerHistory');
function computerActivityLabel(item) {
  const type = String(item.type || 'info').toLowerCase();
  const detail = String(item.detail || '');
  if (type === 'observation') return 'Observe et lit les éléments visibles à l’écran';
  if (type === 'decision') {
    if (/(?:recherch|search).{0,24}(?:web|google|internet|site)|(?:web|google|internet|site).{0,24}(?:recherch|search)/i.test(detail)) return 'Recherche sur le site web';
    if (/source|article|page/i.test(detail)) return 'Examine le contenu affiché';
    return 'Analyse l’écran et prépare la prochaine action';
  }
  if (type === 'open_url') return 'Ouvre un site web';
  if (type === 'open_app') return /blender/i.test(detail) ? 'Ouvre ou réactive Blender' : 'Lance une application';
  if (type === 'hotkey') return 'Envoie un raccourci clavier';
  if (type === 'wait') return 'Attend le chargement de l’application';
  if (type === 'left_click' || type === 'double_click') return 'Active un élément à l’écran';
  if (type === 'type') return 'Saisit du texte';
  if (type === 'scroll') return 'Parcourt le contenu affiché';
  if (type === 'find_latest_file') return 'Recherche un fichier';
  if (type === 'open_file') return 'Ouvre un fichier';
  if (type === 'done') return 'Tâche terminée';
  if (type === 'error') return 'Échec de la tâche';
  if (type === 'replan') return 'Corrige son plan d’action';
  if (type === 'status') return detail;
  return detail || 'Activité en cours';
}
function appendComputerActivity(item) {
  if (!activeComputerFeed) return;
  const row = document.createElement('div');
  row.className = 'computer-live-item';
  const mark = document.createElement('span');
  mark.className = 'computer-live-mark';
  const body = document.createElement('div');
  body.className = 'computer-live-copy';
  const head = document.createElement('div');
  head.className = 'computer-live-head';
  const title = document.createElement('strong');
  title.textContent = computerActivityLabel(item);
  head.append(title);

  const detailText = String(item.detail || '').trim();
  const disclosure = document.createElement('button');
  disclosure.type = 'button';
  disclosure.className = 'computer-live-expand';
  disclosure.setAttribute('aria-expanded', 'false');
  disclosure.setAttribute('aria-label', 'Déplier les détails de cette activité');
  disclosure.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';

  const detail = document.createElement('div');
  detail.className = 'computer-live-expanded';
  detail.hidden = true;
  const detailLabel = document.createElement('span');
  detailLabel.className = 'computer-live-expanded-label';
  detailLabel.textContent = 'Détails de l’activité';
  const detailContent = document.createElement('p');
  detailContent.textContent = detailText || 'Aucun détail supplémentaire transmis pour cette étape.';
  detail.append(detailLabel, detailContent);

  disclosure.addEventListener('click', () => {
    const expanded = disclosure.getAttribute('aria-expanded') !== 'true';
    disclosure.setAttribute('aria-expanded', String(expanded));
    disclosure.setAttribute('aria-label', expanded ? 'Replier les détails de cette activité' : 'Déplier les détails de cette activité');
    detail.hidden = !expanded;
    row.classList.toggle('is-expanded', expanded);
  });
  head.append(disclosure);
  body.append(head, detail);
  row.append(mark, body);
  activeComputerFeed.prepend(row);
  while (activeComputerFeed.children.length > 8) activeComputerFeed.lastElementChild.remove();
}
function startComputerActivityBubble(label) {
  activeComputerBubble = addBubble('sys', '');
  const shell = document.createElement('div');
  shell.className = 'computer-live';
  const loader = makeLoader(label);
  activeComputerLoader = loader.stop;
  activeComputerMainLabel = loader.label;
  activeComputerFeed = document.createElement('div');
  activeComputerFeed.className = 'computer-live-feed';
  shell.append(loader.el, activeComputerFeed);
  activeComputerBubble.append(shell);
}
function addComputerHistory(item) {
  const line = document.createElement('div');
  line.className = 'computer-history-item';
  const time = new Date(item.time || Date.now()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = time + ' · ' + computerActivityLabel(item) + ' — ' + String(item.detail || '').slice(0, 300);
  computerHistory.prepend(line);
  while (computerHistory.children.length > 40) computerHistory.lastElementChild.remove();
}
computerStart.addEventListener('click', async () => {
  const task = computerTask.value.trim();
  if (!task) { computerStatus.textContent = 'Décris d’abord la tâche.'; return; }
  computerStart.disabled = true; computerStop.disabled = false; computerStatus.textContent = 'Démarrage…';
  const result = await bridge.computerUseStart(task);
  if (!result.ok) { computerStatus.textContent = result.error || 'Démarrage impossible.'; computerStart.disabled = false; computerStop.disabled = true; }
});
computerStop.addEventListener('click', async () => {
  computerStop.disabled = true; computerStatus.textContent = 'Arrêt demandé…'; await bridge.computerUseStop();
});
bridge.onComputerUseStatus((state) => {
  computerStatus.textContent = state.message || (state.active ? 'En cours…' : 'Agent inactif');
  computerStart.disabled = !!state.active; computerStop.disabled = !state.active;
  if (activeComputerBubble && state.message && state.message !== 'Agent inactif.') {
    appendComputerActivity({ type: 'status', detail: state.message });
  }
  if (!state.active) {
    if (activeComputerLoader) activeComputerLoader();
    activeComputerLoader = null; activeComputerMainLabel = null; activeComputerFeed = null; activeComputerBubble = null;
  }
});
bridge.onComputerUseHistory((item) => {
  addComputerHistory(item);
  appendComputerActivity(item);
  const type = String(item.type || '').toLowerCase();
  if (activeComputerMainLabel && type === 'done') activeComputerMainLabel.textContent = 'Tâche terminée';
  if (activeComputerMainLabel && type === 'error') activeComputerMainLabel.textContent = 'Tâche interrompue : erreur';
});
bridge.onComputerUseConfirmation(async (request) => {
  const approved = window.confirm('L’IA demande une validation avant cette action :\n\n' + request.reason + '\n\nAutoriser cette action ?');
  await bridge.computerUseApprove(approved);
  addComputerHistory({ type: approved ? 'approved' : 'rejected', detail: request.reason });
});
bridge.computerUseState().then((state) => {
  (state.history || []).forEach(addComputerHistory);
  if (state.active) { computerStatus.textContent = 'Agent déjà actif'; computerStart.disabled = true; computerStop.disabled = false; }
}).catch(() => {});

$('webSearch').addEventListener('change', (e) => {
  settings.webSearch = e.target.checked;
  bridge.setSettings({ webSearch: settings.webSearch });
});

$('tavilyKey').addEventListener('change', (e) => {
  settings.tavilyKey = e.target.value.trim();
  bridge.setSettings({ tavilyKey: settings.tavilyKey });
});

$('getTavilyKey').addEventListener('click', () => bridge.openTavilyKeys());

$('toggleTavilyKey').addEventListener('click', (e) => {
  const field = $('tavilyKey');
  const showing = field.type === 'text';
  field.type = showing ? 'password' : 'text';
  e.currentTarget.textContent = showing ? 'Afficher' : 'Masquer';
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
    if (!s.needsSetup) {
      box.remove();
      if (setupLine === prog) setupLine = null;
      return;
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
    if (s.needsSetup) showSetupPrompt(s);
  } catch (err) {
    // Une erreur temporaire de détection ne doit jamais proposer de retélécharger les modèles.
    console.error('Vérification des modèles locaux impossible :', err);
    $('ollamaStatus').textContent = 'État inconnu';
    $('sdxlStatus').textContent = 'Vérification de ComfyUI indisponible';
  }
})();

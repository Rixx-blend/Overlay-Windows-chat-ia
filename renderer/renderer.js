const card = document.getElementById('card');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const send = document.getElementById('send');
const mic = document.getElementById('mic');
const newchat = document.getElementById('newchat');
const attach = document.getElementById('attach');
const fileInput = document.getElementById('file');
const tray = document.getElementById('tray');
const modelBtn = document.getElementById('modelBtn');
const modelName = document.getElementById('modelName');
const menu = document.getElementById('menu');

const PLACEHOLDER = "Demander n'importe quoi...";
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_TEXT = 200 * 1024;
const TEXT_EXT = /\.(txt|md|json|csv|js|ts|jsx|tsx|py|html|css|xml|log|yml|yaml|ini|sql|java|c|cpp|cs|rs|go)$/i;

let messages = [];      // historique envoyé à l'API
let current = null;     // bulle de réponse en cours
let busy = false;
let model = 'gpt-4o-mini';
let recorder = null;
let transcribing = false;
let closeTimer = null;
let pending = [];       // pièces jointes en attente d'envoi

// ---------- Ouverture / fermeture ----------
function setOpen(v) {
  card.classList.toggle('open', v);
}

function canClose() {
  return !messages.length && !input.value && !pending.length && !recorder && !transcribing
    && !card.matches(':hover') && menu.hidden;
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (canClose()) setOpen(false);
  }, 300);
}

input.addEventListener('focus', () => {
  clearTimeout(closeTimer);
  setOpen(true);
});
input.addEventListener('blur', scheduleClose);
card.addEventListener('pointerenter', () => clearTimeout(closeTimer));
card.addEventListener('pointerleave', () => {
  if (!dragging) scheduleClose();
});

// ---------- Pièces jointes ----------
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function readAttachment(f) {
  const base = { name: f.name, size: f.size };
  if (f.type.startsWith('image/') && f.size <= MAX_IMAGE) {
    return { ...base, kind: 'image', url: await readAsDataURL(f) };
  }
  const isText = f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.test(f.name);
  if (isText && f.size <= MAX_TEXT) {
    return { ...base, kind: 'text', text: await f.text() };
  }
  return { ...base, kind: 'file' };
}

function formatSize(n) {
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
  return (n / (1024 * 1024)).toFixed(1) + ' Mo';
}

function renderTray() {
  tray.innerHTML = '';
  tray.hidden = !pending.length;
  pending.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = `chip ${a.kind}`;
    el.title = `${a.name} · ${formatSize(a.size)}`;

    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = '';
      el.appendChild(img);
    } else if (a.kind === 'text') {
      const snip = document.createElement('div');
      snip.className = 'snip';
      snip.textContent = a.text.slice(0, 160);
      el.appendChild(snip);
    } else {
      const ext = document.createElement('div');
      ext.className = 'fico';
      ext.textContent = (a.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      el.appendChild(ext);
    }

    const name = document.createElement('span');
    name.className = 'cname';
    name.textContent = a.name;
    el.appendChild(name);

    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Retirer';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      pending.splice(i, 1);
      renderTray();
    });
    el.appendChild(x);

    tray.appendChild(el);
  });
}

attach.addEventListener('click', () => {
  setOpen(true);
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  for (const f of fileInput.files) {
    try {
      pending.push(await readAttachment(f));
    } catch (err) {
      console.error('lecture impossible :', f.name, err);
    }
  }
  fileInput.value = '';
  renderTray();
  input.focus();
});

// ---------- Messages ----------
function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
  chat.appendChild(d);
  chat.classList.add('has');
  chat.scrollTop = chat.scrollHeight;
  return d;
}

// Construit le contenu envoyé : texte, fichiers texte inclus, images en pièces jointes
function buildContent(text) {
  let body = text;
  for (const a of pending.filter((x) => x.kind === 'text')) {
    body = `Fichier « ${a.name} » :\n\`\`\`\n${a.text.slice(0, 20000)}\n\`\`\`\n\n` + body;
  }
  const files = pending.filter((x) => x.kind === 'file');
  if (files.length) {
    body = `[Fichiers joints non lisibles directement : ${files.map((f) => f.name).join(', ')}]\n` + body;
  }
  const images = pending.filter((x) => x.kind === 'image');
  if (!images.length) return body;
  return [
    { type: 'text', text: body || 'Décris ces images.' },
    ...images.map((i) => ({ type: 'image_url', image_url: { url: i.url } })),
  ];
}

function submit() {
  const text = input.value.trim();
  if ((!text && !pending.length) || busy) return;

  const names = pending.map((a) => a.name);
  const content = buildContent(text);
  input.value = '';
  busy = true;
  setOpen(true);

  const bubble = addMsg('user', text || 'Pièces jointes');
  if (names.length) {
    const att = document.createElement('div');
    att.className = 'att';
    att.textContent = 'Pièces jointes : ' + names.join(', ');
    bubble.appendChild(att);
  }
  pending = [];
  renderTray();

  messages.push({ role: 'user', content });
  current = addMsg('ai', '');
  window.api.chat(messages, model);
}

function newConversation() {
  if (busy) return;
  messages = [];
  pending = [];
  renderTray();
  chat.innerHTML = '';
  chat.classList.remove('has');
  input.focus();
}

send.addEventListener('click', submit);
newchat.addEventListener('click', newConversation);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
  if (e.key === 'Escape') {
    if (!menu.hidden) menu.hidden = true;
    else window.api.hide();
  }
});

window.api.onToken((t) => {
  if (!current) return;
  current.textContent += t;
  chat.scrollTop = chat.scrollHeight;
});

window.api.onDone((err) => {
  if (current) {
    if (err) {
      current.textContent = `Erreur : ${err}`;
    } else {
      messages.push({ role: 'assistant', content: current.textContent });
    }
  }
  current = null;
  busy = false;
  input.focus();
});

window.api.onFocus(() => input.focus());

// ---------- Modèle ----------
function markModel() {
  menu.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === model));
  modelName.textContent = model;
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});

menu.querySelectorAll('button').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    model = b.dataset.m;
    markModel();
    menu.hidden = true;
    input.focus();
  });
});

document.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !e.target.closest('.menu-wrap')) menu.hidden = true;
});

markModel();

// ---------- Message vocal ----------
function flash(text) {
  input.placeholder = text;
  setTimeout(() => (input.placeholder = PLACEHOLDER), 2500);
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
  } catch (err) {
    flash('Micro indisponible');
    return;
  }

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    mic.classList.remove('rec');
    transcribing = true;
    mic.classList.add('busy');
    try {
      const buf = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer();
      const text = await window.api.transcribe(buf);
      if (text.trim()) {
        input.value = (input.value ? input.value + ' ' : '') + text.trim();
      }
    } catch (err) {
      flash('Transcription échouée');
    } finally {
      transcribing = false;
      mic.classList.remove('busy');
      input.focus();
    }
  };

  recorder = rec;
  rec.start();
  mic.classList.add('rec');
  mic.title = 'Arrêter';
  setOpen(true);
}

mic.addEventListener('click', toggleMic);

// ---------- Déplacement : glisser sur la carte (sauf texte, boutons, historique, pièces jointes) ----------
let dragging = false;
let dragQueued = false;

card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('input, button, .menu, .chat, .tray')) return;
  dragging = true;
  window.api.mouseIn();
  window.api.dragStart();
});

window.addEventListener('pointermove', () => {
  if (!dragging || dragQueued) return;
  dragQueued = true;
  requestAnimationFrame(() => {
    dragQueued = false;
    window.api.dragMove();
  });
});

window.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  window.api.dragEnd();
  if (!card.matches(':hover')) window.api.mouseOut();
});

card.addEventListener('pointerenter', () => window.api.mouseIn());
card.addEventListener('pointerleave', () => {
  if (!dragging) window.api.mouseOut();
});

input.focus();

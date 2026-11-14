const card = document.getElementById('card');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const send = document.getElementById('send');
const mic = document.getElementById('mic');
const newchat = document.getElementById('newchat');
const modelBtn = document.getElementById('modelBtn');
const modelName = document.getElementById('modelName');
const menu = document.getElementById('menu');

const PLACEHOLDER = "Demander n'importe quoi...";

let messages = [];      // historique envoyé à l'API
let current = null;     // bulle de réponse en cours
let busy = false;       // une réponse est en cours
let model = 'gpt-4o-mini';
let recorder = null;    // enregistrement vocal en cours
let transcribing = false;
let closeTimer = null;

// ---------- Ouverture / fermeture ----------
function setOpen(v) {
  card.classList.toggle('open', v);
}

function canClose() {
  return !messages.length && !input.value && !recorder && !transcribing
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

function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  busy = true;
  setOpen(true);
  addMsg('user', text);
  messages.push({ role: 'user', content: text });
  current = addMsg('ai', '');
  window.api.chat(messages, model);
}

function newConversation() {
  if (busy) return;
  messages = [];
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

// Un clic ailleurs ferme le menu
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

  // Deuxième clic : on arrête l'enregistrement
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

// ---------- Déplacement : glisser sur la carte (sauf texte, boutons et historique) ----------
let dragging = false;
let dragQueued = false;

card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('input, button, .menu, .chat')) return;
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

// La fenêtre laisse passer les clics hors de la carte (sauf pendant un glissement)
card.addEventListener('pointerenter', () => window.api.mouseIn());
card.addEventListener('pointerleave', () => {
  if (!dragging) window.api.mouseOut();
});

input.focus();

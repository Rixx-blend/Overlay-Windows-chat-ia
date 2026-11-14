const card = document.getElementById('card');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const send = document.getElementById('send');
const model = document.getElementById('model');

let messages = [];   // historique envoyé à l'API
let current = null;  // bulle de réponse en cours
let busy = false;
let blurTimer = null;

function setOpen(v) {
  card.classList.toggle('open', v);
}

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
  window.api.chat(messages, model.value);
}

// Ouverture au focus, fermeture quand on quitte sans rien avoir écrit ni échangé
input.addEventListener('focus', () => {
  clearTimeout(blurTimer);
  setOpen(true);
});
input.addEventListener('blur', () => {
  blurTimer = setTimeout(() => {
    if (!messages.length && !input.value) setOpen(false);
  }, 250);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submit();
  if (e.key === 'Escape') window.api.hide();
});
send.addEventListener('click', submit);

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

// Taille de la fenêtre = taille de la carte (+ marge du stage), en continu pendant l'animation
new ResizeObserver(() => {
  const r = card.getBoundingClientRect();
  window.api.resize(Math.ceil(r.width) + 24, Math.ceil(r.height) + 24);
}).observe(card);

// La fenêtre laisse passer les clics hors de la carte
card.addEventListener('pointerenter', () => window.api.mouseIn());
card.addEventListener('pointerleave', () => window.api.mouseOut());

input.focus();

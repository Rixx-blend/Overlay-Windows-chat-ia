const { promisify } = require('node:util');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createComputerUse({ desktopCapturer, screen, execFile, clipboard, getWindow, model = 'qwen2.5vl:3b' }) {
  const exec = promisify(execFile);
  let active = false;
  let stopped = false;
  let pendingApproval = null;
  let history = [];
  let runId = 0;

  function emit(channel, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
  function log(type, detail) {
    const item = { time: new Date().toISOString(), type, detail: String(detail || '').slice(0, 500) };
    history.push(item);
    if (history.length > 100) history = history.slice(-100);
    emit('computer-use-history', item);
  }
  async function screenshot() {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height },
    });
    const source = sources.find((item) => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Capture de l’écran indisponible.');
    return source.thumbnail.toJPEG(78).toString('base64');
  }
  async function input(action) {
    const type = action.type;
    if (!['move', 'click', 'type', 'press_key', 'wait', 'finish', 'confirm'].includes(type)) {
      throw new Error('Action non autorisée : ' + String(type));
    }
    if (type === 'wait') { await sleep(Math.max(250, Math.min(5000, Number(action.ms) || 1000))); return 'Attente terminée'; }
    if (type === 'finish') return 'Terminé';
    if (type === 'confirm') {
      const answer = await new Promise((resolve) => {
        pendingApproval = resolve;
        emit('computer-use-confirmation', { reason: String(action.reason || 'Action sensible demandée par l’IA').slice(0, 300) });
      });
      pendingApproval = null;
      if (!answer) throw new Error('Action refusée par l’utilisateur.');
      return 'Action approuvée';
    }
    if (type === 'type') {
      const value = String(action.text || '').slice(0, 2000);
      clipboard.writeText(value);
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], { timeout: 5000, windowsHide: true });
      return 'Texte saisi';
    }
    if (type === 'press_key') {
      const allowed = new Set(['ENTER','TAB','ESC','ESCAPE','BACKSPACE','DELETE','UP','DOWN','LEFT','RIGHT','HOME','END','PAGEUP','PAGEDOWN','CTRL+A','CTRL+C','CTRL+V','CTRL+X','CTRL+Z','CTRL+S','CTRL+L','ALT+TAB','WIN']);
      const key = String(action.key || '').toUpperCase();
      if (!allowed.has(key)) throw new Error('Raccourci clavier non autorisé : ' + key);
      const map = { ENTER:'{ENTER}', TAB:'{TAB}', ESC:'{ESC}', ESCAPE:'{ESC}', BACKSPACE:'{BACKSPACE}', DELETE:'{DELETE}', UP:'{UP}', DOWN:'{DOWN}', LEFT:'{LEFT}', RIGHT:'{RIGHT}', HOME:'{HOME}', END:'{END}', PAGEUP:'{PGUP}', PAGEDOWN:'{PGDN}', 'CTRL+A':'^a', 'CTRL+C':'^c', 'CTRL+V':'^v', 'CTRL+X':'^x', 'CTRL+Z':'^z', 'CTRL+S':'^s', 'CTRL+L':'^l', 'ALT+TAB':'%{TAB}', WIN:'^{ESC}' };
      const encoded = map[key].replace(/'/g, "''");
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + encoded + "')"], { timeout: 5000, windowsHide: true });
      return 'Touche envoyée : ' + key;
    }
    const x = Math.round(Number(action.x));
    const y = Math.round(Number(action.y));
    const display = screen.getPrimaryDisplay();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= display.size.width || y >= display.size.height) throw new Error('Coordonnées hors écran.');
    const command = type === 'click'
      ? "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CU { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [CU]::SetCursorPos(" + x + "," + y + "); Start-Sleep -Milliseconds 80; [CU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [CU]::mouse_event(4,0,0,0,[UIntPtr]::Zero)"
      : 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class CU { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); }"; [CU]::SetCursorPos(' + x + ',' + y + ')';
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 5000, windowsHide: true });
    return type === 'click' ? 'Clic effectué en ' + x + ',' + y : 'Curseur déplacé en ' + x + ',' + y;
  }
  async function start(task) {
    if (active) throw new Error('Un agent est déjà en cours.');
    if (!String(task || '').trim()) throw new Error('Décris la tâche à effectuer.');
    active = true; stopped = false; history = []; const id = ++runId;
    emit('computer-use-status', { active: true, message: 'Analyse de l’écran…' });
    log('start', task);
    try {
      const riskyTask = /supprim|effac|vider|formater|ecras|écras|remplac|envoy|publ|poster|acheter|payer|install|telecharg|télécharg|desinstall|désinstall|fermer.*session|deconnect|déconnect/i.test(String(task));
      if (riskyTask) {
        const approved = await new Promise((resolve) => {
          pendingApproval = resolve;
          emit('computer-use-confirmation', { reason: 'La tâche demandée peut modifier des données ou déclencher une action sensible : ' + String(task).slice(0, 220) });
        });
        pendingApproval = null;
        if (!approved) throw new Error('Tâche sensible refusée.');
      }
      const messages = [{ role: 'system', content: 'Tu es un agent de contrôle visuel d’ordinateur Windows. Tu observes la capture, choisis UNE action à la fois, puis vérifies le nouvel écran. Réponds uniquement en JSON valide avec {"type":"move|click|type|press_key|wait|confirm|finish","x":0,"y":0,"text":"","key":"ENTER","ms":700,"reason":""}. Coordonnées en pixels sur la capture. Ne prétends jamais avoir agi sans action. Pour supprimer, écraser, envoyer, publier, acheter, installer, télécharger un exécutable, modifier la sécurité ou fermer une session, demande d’abord une confirmation avec type=confirm et une raison claire. Ne demande jamais de mot de passe ni de code de connexion. Ne lance aucun terminal ni commande. Termine avec type=finish quand la tâche est achevée ou impossible.' }, { role: 'user', content: 'Tâche : ' + String(task).slice(0, 1000) }];
      let finished = false;
      for (let step = 0; step < 18 && !stopped && id === runId; step++) {
        emit('computer-use-status', { active: true, message: 'Observation ' + (step + 1) + '/18' });
        const image = await screenshot();
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({ model, stream: false, format: 'json', keep_alive: '3m', messages: [...messages, { role: 'user', content: 'Observe l’écran actuel et retourne la prochaine action JSON.', images: [image] }], options: { temperature: 0.1, num_predict: 300, num_ctx: 8192 } }),
        });
        if (!response.ok) throw new Error('Ollama HTTP ' + response.status);
        const data = await response.json();
        const raw = String(data.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
        if (stopped || id !== runId) break;
        let action;
        try { action = JSON.parse(raw); } catch { throw new Error('Réponse visuelle illisible : ' + raw.slice(0, 200)); }
        if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Action visuelle invalide.');
        const result = await input(action);
        log(action.type, result);
        emit('computer-use-status', { active: true, message: result });
        if (action.type === 'finish') { finished = true; log('done', 'Tâche terminée par le modèle.'); break; }
        messages.push({ role: 'assistant', content: JSON.stringify(action) }, { role: 'user', content: 'Résultat : ' + result + '. Observe maintenant l’écran mis à jour.' });
      }
      if (!finished && !stopped && id === runId) log('limit', 'Limite de 18 actions atteinte.');
    } catch (error) { log('error', error.message); emit('computer-use-status', { active: false, message: error.message, error: true }); }
    finally { active = false; pendingApproval = null; emit('computer-use-status', { active: false, message: stopped ? 'Arrêté.' : 'Agent inactif.' }); }
  }
  function stop() { stopped = true; runId++; if (pendingApproval) { pendingApproval(false); pendingApproval = null; } log('stop', 'Arrêt demandé.'); }
  function approve(value) { if (pendingApproval) pendingApproval(Boolean(value)); }
  return { start, stop, approve, getState: () => ({ active, history: history.slice(-100) }) };
}

module.exports = { createComputerUse };
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
    if (!['move', 'click', 'double_click', 'drag', 'scroll', 'type', 'press_key', 'wait', 'finish', 'confirm', 'open_app', 'find_latest_file', 'open_file'].includes(type)) {
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
    if (type === 'open_app') {
      const appName = String(action.app || '').trim().replace(/[^\\p{L}\\p{N} ._+-]/gu, '').slice(0, 80);
      if (!appName) throw new Error('Nom d’application manquant.');
      const escaped = appName.replace(/'/g, "''");
      const script = "$ErrorActionPreference='Stop'; $n='" + escaped + "'; $a=Get-StartApps | Where-Object { $_.Name -like ('*'+$n+'*') } | Sort-Object @{Expression={ if ($_.Name -ieq $n) {0} elseif ($_.Name -ilike ($n+'*')) {1} else {2} }} | Select-Object -First 1; if ($a) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$a.AppID); Write-Output ('Application lancée : '+$a.Name) } else { $cmd=Get-Command ($n+'.exe') -ErrorAction SilentlyContinue; if ($cmd) { Start-Process $cmd.Source; Write-Output ('Application lancée : '+$cmd.Source) } else { throw ('Application introuvable dans le menu Démarrer : '+$n) } }"; 
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true });
      return String(stdout || ('Lancement demandé : ' + appName)).trim();
    }
    if (type === 'find_latest_file') {
      const folder = String(action.folder || 'Downloads').trim().toLowerCase();
      const allowedFolders = { downloads: '$env:USERPROFILE\\Downloads', desktop: '$env:USERPROFILE\\Desktop', documents: '$env:USERPROFILE\\Documents', pictures: '$env:USERPROFILE\\Pictures' };
      if (!allowedFolders[folder]) throw new Error('Dossier non pris en charge : ' + folder);
      const ext = String(action.extension || '.png').trim().toLowerCase();
      if (!/^\\.[a-z0-9]{1,8}$/.test(ext)) throw new Error('Extension invalide.');
      const script = "$ErrorActionPreference='SilentlyContinue'; $p=" + allowedFolders[folder] + "; $f=Get-ChildItem -LiteralPath $p -File -Recurse -Filter '*" + ext + "' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { Write-Output ('Fichier le plus récent : '+$f.FullName); Write-Output ('Dernière modification : '+$f.LastWriteTime) } else { Write-Output ('Aucun fichier ' + '" + ext + "' trouvé dans ' + $p) }";
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, windowsHide: true });
      return String(stdout || 'Aucun fichier correspondant trouvé.').trim();
    }
    if (type === 'open_file') {
      const filePath = String(action.path || '').trim();
      if (!filePath || filePath.length > 1000 || /[\\r\\n]/.test(filePath)) throw new Error('Chemin de fichier invalide.');
      const escaped = filePath.replace(/'/g, "''");
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p='" + escaped + "'; if (Test-Path -LiteralPath $p -PathType Leaf) { Start-Process -FilePath $p; Write-Output ('Fichier ouvert : '+$p) } else { throw 'Fichier introuvable.' }"], { timeout: 15000, windowsHide: true });
      return String(stdout || 'Ouverture du fichier demandée.').trim();
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
    const x2 = Math.round(Number(action.x2));
    const y2 = Math.round(Number(action.y2));
    if (type === 'drag' && (!Number.isFinite(x2) || !Number.isFinite(y2) || x2 < 0 || y2 < 0 || x2 >= display.size.width || y2 >= display.size.height)) throw new Error('Coordonnées de destination hors écran.');
    const command = type === 'click' || type === 'double_click'
      ? "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CU { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [CU]::SetCursorPos(" + x + "," + y + "); Start-Sleep -Milliseconds 80; [CU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [CU]::mouse_event(4,0,0,0,[UIntPtr]::Zero); if (" + (type === 'double_click' ? '$true' : '$false') + ") { Start-Sleep -Milliseconds 90; [CU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [CU]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }"
      : type === 'drag'
        ? "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CU { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [CU]::SetCursorPos(" + x + "," + y + "); [CU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 120; [CU]::SetCursorPos(" + x2 + "," + y2 + "); Start-Sleep -Milliseconds 100; [CU]::mouse_event(4,0,0,0,[UIntPtr]::Zero)"
        : type === 'scroll'
          ? "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CU { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [CU]::SetCursorPos(" + x + "," + y + "); [CU]::mouse_event(0x0800,0,0," + Math.max(-1200, Math.min(1200, Number(action.delta) || -120)) + ",[UIntPtr]::Zero)"
          : "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CU { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x,int y); }'; [CU]::SetCursorPos(" + x + "," + y + ")";
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 5000, windowsHide: true });
    return type === 'click' || type === 'double_click' ? 'Clic effectué en ' + x + ',' + y : type === 'drag' ? 'Glissement effectué.' : type === 'scroll' ? 'Défilement effectué.' : 'Curseur déplacé en ' + x + ',' + y;
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
      const messages = [{ role: 'system', content: 'Tu es un agent autonome de contrôle visuel et système Windows. Tu peux choisir UNE action à la fois. ACTIONS SYSTÈME DISPONIBLES : open_app avec {\"type\":\"open_app\",\"app\":\"Blender\"} lance une application installée via le menu Démarrer Windows ; find_latest_file avec {\"type\":\"find_latest_file\",\"folder\":\"Downloads\",\"extension\":\".png\"} cherche le fichier correspondant le plus récent dans le dossier demandé ; open_file avec {\"type\":\"open_file\",\"path\":\"chemin complet\"} ouvre un fichier. RÈGLE PRIORITAIRE : dès qu’une tâche demande d’ouvrir une application nommée, utilise open_app. Ne cherche jamais le nom d’une application dans l’Explorateur ou « Ce PC ». Si la tâche demande de trouver le dernier PNG dans Téléchargements, utilise find_latest_file avec folder=Downloads et extension=.png, puis communique le chemin trouvé. Pour ouvrir le PNG dans Photoshop, utilise open_file sur le chemin trouvé après avoir lancé Photoshop. Pour Blender, utilise open_app avec app=Blender, attends le lancement, observe l’écran et supprime le cube par défaut uniquement après confirmation utilisateur déjà reçue ou demande une confirmation via type=confirm. Pour toute autre interaction, observe la capture, choisis une action, puis vérifie le nouvel écran. Réponds uniquement en JSON valide avec {"type":"move|click|double_click|drag|scroll|type|press_key|wait|confirm|finish","x":0,"y":0,"text":"","key":"ENTER","ms":700,"reason":""}. Coordonnées en pixels sur la capture. Pour drag, utilise x2 et y2. Pour scroll, delta négatif = bas et positif = haut. Ne prétends jamais avoir agi sans action. Pour supprimer, écraser, envoyer, publier, acheter, installer, télécharger un exécutable, modifier la sécurité ou fermer une session, demande d’abord une confirmation avec type=confirm et une raison claire. Ne demande jamais de mot de passe ni de code de connexion. Ne lance aucun terminal ni commande. Termine avec type=finish quand la tâche est achevée ou impossible.' }, { role: 'user', content: 'Tâche : ' + String(task).slice(0, 1000) }];
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
const { app, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function createComputerUse({ getWindow }) {
  let child = null;
  let active = false;
  let history = [];
  let outputBuffer = '';
  let runId = 0;

  function emit(channel, payload) {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function log(type, detail) {
    const item = { time: new Date().toISOString(), type, detail: String(detail || '').slice(0, 500) };
    history.push(item);
    history = history.slice(-100);
    emit('computer-use-history', item);
  }

  function pythonFiles() {
    if (app.isPackaged) {
      const root = path.join(path.dirname(app.getAppPath()), 'app.asar.unpacked', 'computer_use');
      return { script: path.join(root, 'agent.py'), requirements: path.join(root, 'requirements.txt'), cwd: root };
    }
    const root = path.join(__dirname, 'computer_use');
    return { script: path.join(root, 'agent.py'), requirements: path.join(root, 'requirements.txt'), cwd: root };
  }

  function testPython(command, prefixArgs = []) {
    const result = spawnSync(command, [...prefixArgs, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
    });
    if (result.error || result.status !== 0) return null;
    const version = String(result.stdout || '').trim().split('.').map(Number);
    if (version.length < 2 || version[0] < 3 || (version[0] === 3 && version[1] < 10)) return null;
    return { command, prefixArgs, version: version.join('.') };
  }

  function findPython() {
    const candidates = [];
    if (process.env.OVERLAYIA_PYTHON) candidates.push([process.env.OVERLAYIA_PYTHON, []]);
    const home = process.env.USERPROFILE || '';
    candidates.push(['py', ['-3']], ['python', []], ['python3', []]);
    for (const candidate of [
      path.join(home, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'),
      path.join(home, 'Downloads', 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'),
      path.join(home, 'Desktop', 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'),
    ]) {
      if (candidate && fs.existsSync(candidate)) candidates.push([candidate, []]);
    }
    for (const [command, args] of candidates) {
      const result = testPython(command, args);
      if (result) return result;
    }
    return null;
  }

  function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { windowsHide: true, ...options });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); if (stdout.length > 300000) stdout = stdout.slice(-300000); });
      proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 300000) stderr = stderr.slice(-300000); });
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || 'Processus terminé avec le code ' + code).slice(-3000))));
    });
  }

  async function ensureDependencies(python, requirements) {
    const check = spawnSync(python.command, [...python.prefixArgs, '-c', 'import openai, mss, PIL, pyautogui, pynput, pyperclip'], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    if (!check.error && check.status === 0) return;
    emit('computer-use-status', { active: true, message: 'Installation initiale des dépendances Python…' });
    try {
      await runProcess(python.command, [...python.prefixArgs, '-m', 'pip', '--version'], { cwd: path.dirname(requirements), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      await runProcess(python.command, [...python.prefixArgs, '-m', 'ensurepip', '--upgrade'], { cwd: path.dirname(requirements), stdio: ['ignore', 'pipe', 'pipe'] });
    }
    try {
      await runProcess(python.command, [...python.prefixArgs, '-m', 'pip', 'install', '--user', '--disable-pip-version-check', '-r', requirements], {
        cwd: path.dirname(requirements), stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (firstError) {
      await runProcess(python.command, [...python.prefixArgs, '-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], {
        cwd: path.dirname(requirements), stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  }

  function handleLine(line, id) {
    let message;
    try { message = JSON.parse(line); } catch { log('debug', line); return; }
    if (id !== runId) return;
    if (message.event === 'status') {
      // Keep controls locked until the Python child has actually exited.
      emit('computer-use-status', { ...message, active: true });
      return;
    }
    if (message.event === 'history') {
      if (message.item) {
        history.push(message.item);
        history = history.slice(-100);
        emit('computer-use-history', message.item);
      }
      return;
    }
    if (message.event === 'confirmation_required') {
      const win = getWindow && getWindow();
      const options = {
        type: 'warning',
        title: 'Computer Use — confirmation requise',
        message: 'L’IA demande une confirmation avant de continuer.',
        detail: String(message.reason || 'Action sensible'),
        buttons: ['Refuser', 'Autoriser'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      (win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then((result) => {
        if (child && id === runId && child.stdin.writable) {
          child.stdin.write(JSON.stringify({ type: 'approval', approved: result.response === 1 }) + '\n');
        }
      }).catch(() => {
        if (child && id === runId && child.stdin.writable) child.stdin.write('{"type":"approval","approved":false}\n');
      });
    }
  }

  async function start(task) {
    if (active) throw new Error('Un agent Computer Use est déjà actif.');
    if (!String(task || '').trim()) throw new Error('Décris la tâche à effectuer.');
    const id = ++runId;
    active = true;
    history = [];
    emit('computer-use-status', { active: true, message: 'Préparation du moteur Python…' });
    try {
      const files = pythonFiles();
      if (!fs.existsSync(files.script)) throw new Error('Moteur Python introuvable dans l’installation.');
      const python = findPython();
      if (!python) throw new Error('Python 3.10 ou supérieur est requis. Installe Python ou utilise le Python portable de ComfyUI.');
      emit('computer-use-status', { active: true, message: 'Vérification des modules Python (' + python.version + ')…' });
      await ensureDependencies(python, files.requirements);
      if (id !== runId) return;
      const logs = path.join(app.getPath('userData'), 'computer-use-logs');
      fs.mkdirSync(logs, { recursive: true });
      const args = [...python.prefixArgs, files.script, '--task', String(task).slice(0, 1500), '--model', process.env.OVERLAYIA_VISION_MODEL || 'qwen2.5vl:3b', '--logs', logs];
      child = spawn(python.command, args, {
        cwd: files.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1' },
      });
      outputBuffer = '';
      child.stdout.on('data', (chunk) => {
        outputBuffer += chunk.toString();
        let index;
        while ((index = outputBuffer.indexOf('\n')) >= 0) {
          const line = outputBuffer.slice(0, index).trim();
          outputBuffer = outputBuffer.slice(index + 1);
          if (line) handleLine(line, id);
        }
      });
      child.stderr.on('data', (chunk) => {
        const detail = chunk.toString().trim();
        if (detail) log('python-log', detail.slice(0, 400));
      });
      child.on('error', (error) => {
        if (id !== runId) return;
        active = false;
        child = null;
        emit('computer-use-status', { active: false, error: true, message: 'Démarrage Python impossible : ' + error.message });
      });
      child.on('close', (code) => {
        if (id !== runId) return;
        if (outputBuffer.trim()) handleLine(outputBuffer.trim(), id);
        child = null;
        active = false;
        if (code === 130) emit('computer-use-status', { active: false, message: 'Arrêt d’urgence effectué avec Échap.' });
        else if (code !== 0) emit('computer-use-status', { active: false, error: true, message: 'Le moteur Python s’est arrêté (code ' + code + '). Consulte les journaux.' });
        else emit('computer-use-status', { active: false, message: 'Agent inactif.' });
      });
    } catch (error) {
      active = false;
      emit('computer-use-status', { active: false, error: true, message: error.message });
      throw error;
    }
  }

  function stop() {
    runId++;
    if (!child) {
      active = false;
      emit('computer-use-status', { active: false, message: 'Arrêt demandé.' });
      return;
    }
    try { if (child.stdin.writable) child.stdin.write('{"type":"stop"}\n'); } catch {}
    child.kill();
    child = null;
    active = false;
    emit('computer-use-status', { active: false, message: 'Arrêt demandé.' });
    log('stop', 'Arrêt demandé depuis OverlayIA.');
  }

  function approve(value) {
    if (child && child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'approval', approved: Boolean(value) }) + '\n');
  }

  return { start, stop, approve, getState: () => ({ active, history: history.slice(-100) }) };
}

module.exports = { createComputerUse };

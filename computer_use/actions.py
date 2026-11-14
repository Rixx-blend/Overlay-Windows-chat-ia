import os
import subprocess
import time
from pathlib import Path

import pyautogui
import pyperclip


pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.12

ALLOWED_KEYS = {
    "ctrl", "shift", "alt", "tab", "enter", "esc", "space", "backspace",
    "delete", "up", "down", "left", "right", "home", "end", "pageup",
    "pagedown", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9",
    "f10", "f11", "f12", "a", "c", "v", "x", "z", "s", "w", "n", "o",
}


def normalized_point(action):
    x = float(action.get("x", -1))
    y = float(action.get("y", -1))
    if not (0 <= x <= 1000 and 0 <= y <= 1000):
        raise ValueError("Coordonnées normalisées hors limites.")
    width, height = pyautogui.size()
    return round(x * (width - 1) / 1000), round(y * (height - 1) / 1000)


def launch_app(name):
    name = str(name or "").strip()[:80]
    if not name:
        raise ValueError("Nom d'application manquant.")
    escaped = name.replace("'", "''")
    script = (
        "$ErrorActionPreference='Stop'; $n='" + escaped + "'; "
        "$a=Get-StartApps | Where-Object { $_.Name -like ('*'+$n+'*') } | "
        "Sort-Object @{Expression={if ($_.Name -ieq $n){0}elseif($_.Name -ilike ($n+'*')){1}else{2}}} | "
        "Select-Object -First 1; "
        "if ($a) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$a.AppID); "
        "Write-Output ('Application lancée : '+$a.Name) } "
        "else { $exe=$null; "
        "if ($n -match 'blender') { $exe=Get-ChildItem -Path ($env:ProgramFiles+'\\Blender Foundation') -Recurse -Filter blender.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }; "
        "if (-not $exe -and $n -match 'photoshop') { foreach ($root in @(($env:ProgramFiles+'\\Adobe'),($env:ProgramFiles(x86)+'\\Adobe'))) { $exe=Get-ChildItem -Path $root -Directory -Filter 'Adobe Photoshop*' -ErrorAction SilentlyContinue | ForEach-Object { Get-Item (Join-Path $_.FullName 'Photoshop.exe') -ErrorAction SilentlyContinue } | Select-Object -First 1; if ($exe) { break } } }; "
        "if ($exe) { Start-Process $exe.FullName; Write-Output ('Application lancée : '+$exe.FullName) } "
        "else { $c=Get-Command ($n+'.exe') -ErrorAction SilentlyContinue; if ($c) { Start-Process $c.Source; Write-Output ('Application lancée : '+$c.Source) } else { throw ('Application introuvable : '+$n) } } }"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Lancement impossible.").strip()[:500])
    return (result.stdout or "Lancement demandé.").strip()


def find_latest_file(folder, extension):
    roots = {
        "downloads": Path.home() / "Downloads",
        "desktop": Path.home() / "Desktop",
        "documents": Path.home() / "Documents",
        "pictures": Path.home() / "Pictures",
    }
    key = str(folder or "Downloads").strip().lower()
    root = roots.get(key)
    ext = str(extension or ".png").strip().lower()
    if root is None:
        raise ValueError("Dossier non autorisé.")
    if not ext.startswith(".") or len(ext) > 10 or not ext[1:].isalnum():
        raise ValueError("Extension invalide.")
    if not root.exists():
        raise FileNotFoundError("Dossier introuvable : " + str(root))
    newest = None
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d.lower() not in {"node_modules", ".git", "$recycle.bin"}]
        for filename in files:
            if filename.lower().endswith(ext):
                candidate = Path(current) / filename
                try:
                    modified = candidate.stat().st_mtime
                except OSError:
                    continue
                if newest is None or modified > newest[0]:
                    newest = (modified, candidate)
    if newest is None:
        raise FileNotFoundError("Aucun fichier " + ext + " trouvé dans " + str(root))
    return str(newest[1])


def execute(action, confirm):
    kind = action.get("action")
    if kind in {"left_click", "double_click", "right_click"}:
        x, y = normalized_point(action)
        pyautogui.moveTo(x, y, duration=0.16)
        if kind == "left_click":
            pyautogui.click(x, y)
        elif kind == "double_click":
            pyautogui.doubleClick(x, y, interval=0.12)
        else:
            pyautogui.rightClick(x, y)
        return "Clic effectué."
    if kind == "type":
        value = str(action.get("text") or "")[:2000]
        pyperclip.copy(value)
        pyautogui.hotkey("ctrl", "v")
        return "Texte saisi."
    if kind == "hotkey":
        keys = action.get("keys")
        if not isinstance(keys, list) or not keys:
            raise ValueError("Liste de touches invalide.")
        normalized = [str(k).lower() for k in keys]
        if any(k not in ALLOWED_KEYS for k in normalized):
            raise ValueError("Raccourci clavier non autorisé.")
        if "delete" in normalized or "backspace" in normalized:
            if not confirm("L'IA souhaite utiliser une touche de suppression dans l'application active. Autoriser ?"):
                return "Action refusée par l'utilisateur."
        pyautogui.hotkey(*normalized)
        return "Raccourci envoyé : " + "+".join(normalized)
    if kind == "scroll":
        x, y = normalized_point(action)
        amount = max(-12, min(12, int(action.get("amount", -3))))
        pyautogui.moveTo(x, y, duration=0.1)
        pyautogui.scroll(amount)
        return "Défilement effectué."
    if kind == "wait":
        seconds = max(0.2, min(5.0, float(action.get("seconds", 1))))
        time.sleep(seconds)
        return "Attente terminée."
    if kind == "open_app":
        return launch_app(action.get("app"))
    if kind == "find_latest_file":
        return find_latest_file(action.get("folder", "Downloads"), action.get("extension", ".png"))
    if kind == "open_file":
        file_path = Path(str(action.get("path") or "")).expanduser()
        if not file_path.is_file():
            raise FileNotFoundError("Fichier introuvable : " + str(file_path))
        os.startfile(str(file_path))
        return "Fichier ouvert : " + str(file_path)
    if kind == "done":
        return str(action.get("thought") or "Tâche terminée.")
    raise ValueError("Action inconnue ou interdite : " + str(kind))

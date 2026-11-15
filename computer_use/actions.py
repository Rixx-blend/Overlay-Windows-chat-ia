import os
import ctypes
import subprocess
import time
import unicodedata
import webbrowser
from urllib.parse import urlparse
from pathlib import Path

import pyautogui
import pyperclip
from pywinauto import Desktop


pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.12

ALLOWED_KEYS = {
    "ctrl", "shift", "alt", "tab", "enter", "esc", "space", "backspace",
    "delete", "up", "down", "left", "right", "home", "end", "pageup",
    "pagedown", "l", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9",
    "f10", "f11", "f12", "a", "c", "v", "x", "z", "s", "w", "n", "o",
}


def normalized_point(action):
    x = float(action.get("x", -1))
    y = float(action.get("y", -1))
    if not (0 <= x <= 1000 and 0 <= y <= 1000):
        raise ValueError("Coordonnées normalisées hors limites.")
    width, height = pyautogui.size()
    return round(x * (width - 1) / 1000), round(y * (height - 1) / 1000)


def _uia_element_at(x, y):
    try:
        element = Desktop(backend="uia").from_point(x, y)
    except Exception as exc:
        raise RuntimeError("Aucun contrôle Windows UI Automation détecté à cet emplacement : " + str(exc)[:180])
    if not element or not element.is_visible():
        raise RuntimeError("Aucun contrôle accessible à cet emplacement.")
    return element


def _uia_invoke(element):
    # Invoke/Toggle/Selection/ExpandCollapse utilisent les patterns UIA :
    # ils ne déplacent pas le curseur matériel.
    for pattern_name, method_name in (
        ("iface_invoke", "Invoke"),
        ("iface_toggle", "Toggle"),
        ("iface_selection_item", "Select"),
        ("iface_expand_collapse", "Expand"),
    ):
        try:
            pattern = getattr(element, pattern_name)
            getattr(pattern, method_name)()
            return
        except Exception:
            continue
    raise RuntimeError(
        "Ce contrôle ne fournit aucun pattern UI Automation cliquable. "
        "L'action est arrêtée plutôt que de déplacer ta souris physique."
    )


def _activate_existing_window(title_fragment):
    """Restore and focus an already-running app window."""
    user32 = ctypes.windll.user32
    matches = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def enum_callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        if title_fragment.casefold() in buffer.value.casefold():
            matches.append(hwnd)
        return True

    user32.EnumWindows(enum_callback, 0)
    if not matches:
        return False
    hwnd = matches[0]
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.4)
    return True


def launch_app(name):
    name = str(name or "").strip()[:80]
    if not name:
        raise ValueError("Nom d'application manquant.")
    if "blender" in name.casefold() and _activate_existing_window("Blender"):
        return "Fenêtre Blender existante réactivée."
    escaped = name.replace("'", "''")
    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; "
        "$ErrorActionPreference='Stop'; $n='" + escaped + "'; "
        "$a=Get-StartApps | Where-Object { $_.Name -like ('*'+$n+'*') } | "
        "Sort-Object @{Expression={if ($_.Name -ieq $n){0}elseif($_.Name -ilike ($n+'*')){1}else{2}}} | "
        "Select-Object -First 1; "
        "if ($a) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$a.AppID); "
        "Write-Output ('Application lancée : '+$a.Name) } "
        "else { $exe=$null; "
        "if ($n -match 'blender') { $exe=Get-ChildItem -Path ($env:ProgramFiles+'\\Blender Foundation') -Recurse -Filter blender.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }; "
        "if (-not $exe -and $n -match 'photoshop') { foreach ($root in @(($env:ProgramFiles+'\\Adobe'),(${env:ProgramFiles(x86)}+'\\Adobe'))) { $exe=Get-ChildItem -Path $root -Directory -Filter 'Adobe Photoshop*' -ErrorAction SilentlyContinue | ForEach-Object { Get-Item (Join-Path $_.FullName 'Photoshop.exe') -ErrorAction SilentlyContinue } | Select-Object -First 1; if ($exe) { break } } }; "
        "if ($exe) { Start-Process $exe.FullName; Write-Output ('Application lancée : '+$exe.FullName) } "
        "else { $c=Get-Command ($n+'.exe') -ErrorAction SilentlyContinue; if ($c) { Start-Process $c.Source; Write-Output ('Application lancée : '+$c.Source) } else { throw ('Application introuvable : '+$n) } } }"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Lancement impossible.").strip()[:500])
    return (result.stdout or "Lancement demandé.").strip()


def _normalize_folder_name(value):
    value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return " ".join(value.casefold().replace("_", " ").replace("-", " ").split())


def _windows_user_folder(registry_name, fallback_names):
    if os.name == "nt":
        try:
            import winreg
            key_path = r"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"
            registry_names = [registry_name]
            if registry_name == "Downloads":
                registry_names.append("{374DE290-123F-4565-9164-39C4925E467B}")
            for registry_value in registry_names:
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                        value, _ = winreg.QueryValueEx(key, registry_value)
                    value = os.path.expandvars(str(value))
                    candidate = Path(value).expanduser()
                    if candidate.exists():
                        return candidate
                except OSError:
                    continue
        except (OSError, ImportError):
            pass
    home = Path.home()
    candidates = [home / name for name in fallback_names]
    one_drive = os.environ.get("OneDrive") or os.environ.get("OneDriveConsumer")
    if one_drive:
        candidates.extend(Path(one_drive) / name for name in fallback_names)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def find_latest_file(folder, extension):
    aliases = {
        "downloads": ("Downloads", ("Downloads", "Téléchargements", "Telechargements")),
        "telechargements": ("Downloads", ("Downloads", "Téléchargements", "Telechargements")),
        "download": ("Downloads", ("Downloads", "Téléchargements", "Telechargements")),
        "telechargement": ("Downloads", ("Downloads", "Téléchargements", "Telechargements")),
        "desktop": ("Desktop", ("Desktop", "Bureau")),
        "bureau": ("Desktop", ("Desktop", "Bureau")),
        "documents": ("Personal", ("Documents",)),
        "document": ("Personal", ("Documents",)),
        "pictures": ("My Pictures", ("Pictures", "Images")),
        "images": ("My Pictures", ("Pictures", "Images")),
        "photos": ("My Pictures", ("Pictures", "Images")),
    }
    key = _normalize_folder_name(folder or "Downloads")
    selected = aliases.get(key)
    if selected is None:
        raise ValueError("Dossier non autorisé : " + str(folder))
    registry_name, fallback_names = selected
    root = _windows_user_folder(registry_name, fallback_names)
    ext = str(extension or ".png").strip().lower()
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



def _send_windows_hotkey(keys):
    """Send a key chord through Win32 virtual-key events (not pyautogui's key parser)."""
    user32 = ctypes.windll.user32
    modifiers = {
        "ctrl": 0x11, "shift": 0x10, "alt": 0x12,
    }
    special = {
        "tab": 0x09, "enter": 0x0D, "esc": 0x1B, "space": 0x20,
        "backspace": 0x08, "delete": 0x2E, "up": 0x26, "down": 0x28,
        "left": 0x25, "right": 0x27, "home": 0x24, "end": 0x23,
        "pageup": 0x21, "pagedown": 0x22,
        "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
        "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
        "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    }
    virtual_keys = []
    for key in keys:
        if key in modifiers:
            virtual_keys.append(modifiers[key])
        elif key in special:
            virtual_keys.append(special[key])
        elif len(key) == 1 and key.isalpha():
            virtual_keys.append(ord(key.upper()))
        elif len(key) == 1 and key.isdigit():
            virtual_keys.append(ord(key))
        else:
            raise ValueError("Touche non prise en charge : " + key)
    for vk in virtual_keys:
        user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.04)
    for vk in reversed(virtual_keys):
        user32.keybd_event(vk, 0, 2, 0)


def execute(action, confirm):
    kind = action.get("action")
    if kind == "open_url":
        url = str(action.get("url") or "").strip()[:2048]
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Adresse Web invalide : une URL http(s) complète est requise.")
        opened = webbrowser.open(url, new=2, autoraise=True)
        if not opened:
            raise RuntimeError("Windows n'a pas confirmé l'ouverture de l'adresse dans le navigateur par défaut.")
        return "Adresse Web ouverte dans le navigateur par défaut : " + parsed.netloc
    if kind in {"left_click", "double_click", "right_click"}:
        x, y = normalized_point(action)
        element = _uia_element_at(x, y)
        if kind == "right_click":
            raise RuntimeError("Le clic droit indépendant n'est pas pris en charge par UI Automation pour ce contrôle.")
        # UIA Invoke activates the target without generating a physical double-click.
        # Avoid invoking twice: toggle controls could otherwise open then immediately close.
        _uia_invoke(element)
        return "Action exécutée via Windows UI Automation, sans déplacer la souris physique."
    if kind == "type":
        value = str(action.get("text") or "")[:2000]
        try:
            element = Desktop(backend="uia").get_active().get_focus()
            element.iface_value.SetValue(value)
            return "Texte défini via UI Automation, sans utiliser le clavier global."
        except Exception:
            raise RuntimeError("Le champ actif ne prend pas en charge ValuePattern. Saisie clavier indépendante non disponible pour ce champ.")
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
        _send_windows_hotkey(normalized)
        return "Raccourci envoyé via Win32 : " + "+".join(normalized)
    if kind == "scroll":
        x, y = normalized_point(action)
        element = _uia_element_at(x, y)
        amount = max(-12, min(12, int(action.get("amount", -3))))
        try:
            element.iface_scroll.Scroll(2, 3 if amount > 0 else 1)
            return "Défilement demandé via UI Automation."
        except Exception:
            raise RuntimeError("Ce contrôle ne propose pas ScrollPattern. Aucun mouvement de souris physique n'a été effectué.")
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

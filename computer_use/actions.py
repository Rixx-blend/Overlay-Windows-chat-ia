import os
import ctypes
import subprocess
import time
import unicodedata
import uuid
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
    "multiply", "add", "subtract", "divide", "decimal",
} | set("0123456789")


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
    # Text areas and many custom controls are focusable but do not expose Invoke.
    # Set keyboard focus without moving or clicking the user's physical mouse.
    try:
        element.set_focus()
        return
    except Exception:
        pass
    raise RuntimeError(
        "Ce contrôle ne fournit aucun pattern UI Automation cliquable ou focalisable. "
        "L'action est arrêtée plutôt que de déplacer ta souris physique."
    )


def _find_window(title_fragment):
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
    return matches[0] if matches else None


def _activate_existing_window(title_fragment):
    """Restore and focus an already-running app window."""
    user32 = ctypes.windll.user32
    hwnd = _find_window(title_fragment)
    if not hwnd:
        return False
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.8)
    return user32.GetForegroundWindow() == hwnd

def _app_title_aliases(name):
    folded = str(name or "").casefold()
    if any(token in folded for token in ("bloc-notes", "bloc notes", "notepad")):
        return ("Bloc-notes", "Notepad")
    if any(token in folded for token in ("calculatrice", "calculator")):
        return ("Calculatrice", "Calculator")
    if "chrome" in folded:
        return ("Google Chrome",)
    if "edge" in folded:
        return ("Microsoft Edge",)
    return (str(name or "").strip(),)


def _activate_app_window(name, timeout=15):
    aliases = _app_title_aliases(name)
    deadline = time.monotonic() + timeout
    user32 = ctypes.windll.user32
    while time.monotonic() < deadline:
        for title in aliases:
            hwnd = _find_window(title)
            if not hwnd:
                continue
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.25)
            if user32.GetForegroundWindow() == hwnd:
                return title
        time.sleep(0.25)
    return None


def _foreground_title():
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return ""
    buffer = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value


def _require_expected_app(expected_app):
    if not expected_app:
        return
    title = _foreground_title().casefold()
    expected = expected_app if isinstance(expected_app, (list, tuple, set)) else (expected_app,)
    if not any(str(name).casefold() in title for name in expected):
        raise RuntimeError("Saisie bloquée : la fenêtre active n'est pas l'application demandée. Fenêtre active : " + (title or "inconnue"))


def _wait_for_blender_ready(timeout=90):
    """Wait for Blender's actual top-level window, focus it, then allow its UI to settle."""
    deadline = time.monotonic() + timeout
    user32 = ctypes.windll.user32
    while time.monotonic() < deadline:
        hwnd = _find_window("Blender")
        if hwnd:
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.8)
            if user32.GetForegroundWindow() == hwnd:
                # Blender may show its splash/loading screen before the viewport is usable.
                time.sleep(7.0)
                return True
        time.sleep(0.75)
    raise TimeoutError("Blender n'a pas affiché de fenêtre active après 90 secondes.")


def launch_app(name):
    name = str(name or "").strip()[:80]
    if not name:
        raise ValueError("Nom d'application manquant.")
    is_blender = "blender" in name.casefold()
    if not is_blender:
        already_active = _activate_app_window(name, timeout=1)
        if already_active:
            return "Fenêtre existante activée et focus vérifié : " + already_active
    if is_blender and _find_window("Blender"):
        _wait_for_blender_ready()
        return "Fenêtre Blender existante réactivée ; chargement de l'interface attendu et focus vérifié."
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
    launch_message = (result.stdout or "Lancement demandé.").strip()
    if is_blender:
        _wait_for_blender_ready()
        return launch_message + " ; fenêtre Blender détectée, chargement de l'interface terminé et focus vérifié."
    activated = _activate_app_window(name, timeout=15)
    if activated:
        return launch_message + " ; fenêtre activée et focus vérifié : " + activated
    aliases = ", ".join(_app_title_aliases(name))
    raise RuntimeError("Application lancée, mais impossible de confirmer sa fenêtre active (" + aliases + "). Saisie bloquée pour éviter d'écrire dans une autre application.")


def _normalize_folder_name(value):
    value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return " ".join(value.casefold().replace("_", " ").replace("-", " ").split())


def _windows_user_folder(registry_name, fallback_names):
    if os.name == "nt":
        # Resolve redirected/renamed Downloads using the Windows Known Folder API.
        if registry_name == "Downloads":
            class GUID(ctypes.Structure):
                _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                            ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]
            raw = uuid.UUID("374DE290-123F-4565-9164-39C4925E467B").bytes_le
            folder_id = GUID(int.from_bytes(raw[0:4], "little"),
                             int.from_bytes(raw[4:6], "little"),
                             int.from_bytes(raw[6:8], "little"),
                             (ctypes.c_ubyte * 8).from_buffer_copy(raw[8:16]))
            result = ctypes.c_wchar_p()
            try:
                hr = ctypes.windll.shell32.SHGetKnownFolderPath(
                    ctypes.byref(folder_id), 0, None, ctypes.byref(result))
                if hr == 0 and result.value and Path(result.value).exists():
                    return Path(result.value)
            except Exception:
                pass
            finally:
                if result:
                    try:
                        ctypes.windll.ole32.CoTaskMemFree(result)
                    except Exception:
                        pass
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
    ext = str(extension or "*").strip().lower()
    if ext != "*" and (not ext.startswith(".") or len(ext) > 10 or not ext[1:].isalnum()):
        raise ValueError("Extension invalide.")
    if not root.exists():
        raise FileNotFoundError("Dossier introuvable : " + str(root))
    roots = [root]
    if registry_name == "Downloads":
        home = Path.home()
        alternatives = [
            home / "Downloads", home / "Téléchargements", home / "Telechargements",
            home / "OneDrive" / "Downloads", home / "OneDrive" / "Téléchargements",
            home / "OneDrive" / "Telechargements",
        ]
        for env_name in ("OneDrive", "OneDriveConsumer"):
            one_drive = os.environ.get(env_name)
            if one_drive:
                alternatives.extend(Path(one_drive) / name for name in ("Downloads", "Téléchargements", "Telechargements"))
        roots.extend(path for path in alternatives if path.exists())
    unique_roots = []
    seen_roots = set()
    for candidate_root in roots:
        key_root = os.path.normcase(os.path.abspath(str(candidate_root)))
        if key_root not in seen_roots:
            seen_roots.add(key_root)
            unique_roots.append(candidate_root)
    # Open the actual folder in Explorer as requested, without using it as a source
    # of truth for the file listing.
    try:
        os.startfile(str(root))
    except Exception:
        pass
    newest = None
    for search_root in unique_roots:
        for current, dirs, files in os.walk(search_root):
            dirs[:] = [d for d in dirs if d.lower() not in {"node_modules", ".git", "$recycle.bin"}]
            for filename in files:
                if ext == "*" or filename.lower().endswith(ext):
                    candidate = Path(current) / filename
                    try:
                        modified = candidate.stat().st_mtime
                    except OSError:
                        continue
                    if newest is None or modified > newest[0]:
                        newest = (modified, candidate)
    if newest is None:
        searched = " ; ".join(str(item) for item in unique_roots)
        raise FileNotFoundError("Aucun fichier trouvé dans les dossiers Téléchargements vérifiés : " + searched)
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
        "multiply": 0x6A, "add": 0x6B, "subtract": 0x6D,
        "decimal": 0x6E, "divide": 0x6F,
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


def execute(action, confirm, expected_app=None):
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
        if not value:
            return "Aucun texte à saisir."
        # Send Unicode keystrokes to the currently focused application. This works
        # in standard edit controls, WinUI/UWP apps and custom fields that expose
        # no UIA ValuePattern. It does not move the user's physical mouse.
        _require_expected_app(expected_app)
        user32 = ctypes.windll.user32
        if not user32.GetForegroundWindow():
            raise RuntimeError("Aucune fenêtre active pour recevoir le texte.")
        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                ("dwExtraInfo", ctypes.c_size_t),
            ]
        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [
                ("dx", ctypes.c_long), ("dy", ctypes.c_long),
                ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.c_size_t),
            ]
        class HARDWAREINPUT(ctypes.Structure):
            _fields_ = [("uMsg", ctypes.c_ulong), ("wParamL", ctypes.c_ushort), ("wParamH", ctypes.c_ushort)]
        class INPUTUNION(ctypes.Union):
            # Preserve the native x64 INPUT union size/alignment required by SendInput.
            _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]
        class INPUT(ctypes.Structure):
            _fields_ = [("type", ctypes.c_ulong), ("union", INPUTUNION)]
        sent = 0
        for character in value:
            encoded = character.encode("utf-16-le")
            for index in range(0, len(encoded), 2):
                code_unit = int.from_bytes(encoded[index:index + 2], "little")
                for flags in (0x0004, 0x0004 | 0x0002):  # UNICODE down, then key up
                    packet = INPUT()
                    packet.type = 1  # INPUT_KEYBOARD
                    packet.union.ki = KEYBDINPUT(0, code_unit, flags, 0, 0)
                    if user32.SendInput(1, ctypes.byref(packet), ctypes.sizeof(INPUT)) != 1:
                        raise RuntimeError("Windows a refusé l'envoi d'une touche Unicode au champ actif.")
                    sent += 1
        return "Texte saisi par événements clavier Unicode Windows (" + str(len(value)) + " caractères)."
    if kind == "calculate":
        expression = str(action.get("expression") or "").strip()
        import re
        match = re.fullmatch(r"(\d{1,12})\s*([+×xX*÷/−-])\s*(\d{1,12})", expression)
        if not match:
            raise ValueError("Calcul refusé : expression arithmétique simple attendue.")
        _require_expected_app(("Calculatrice", "Calculator"))
        left, operator, right = match.groups()
        operator_keys = {"+": 0x6B, "×": 0x6A, "x": 0x6A, "X": 0x6A,
                         "*": 0x6A, "÷": 0x6F, "/": 0x6F, "−": 0x6D, "-": 0x6D}
        user32 = ctypes.windll.user32
        sequence = [0x60 + int(digit) for digit in left] + [operator_keys[operator]] + [0x60 + int(digit) for digit in right] + [0x0D]
        for vk in sequence:
            user32.keybd_event(vk, 0, 0, 0)
            time.sleep(0.025)
            user32.keybd_event(vk, 0, 0x0002, 0)
            time.sleep(0.035)
        return "Calcul envoyé à la Calculatrice : " + expression + " ; résultat à vérifier sur la capture suivante."
    if kind == "hotkey":
        keys = action.get("keys")
        if not isinstance(keys, list) or not keys:
            raise ValueError("Liste de touches invalide.")
        _require_expected_app(expected_app)
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

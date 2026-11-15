import os
import ctypes
from ctypes import wintypes
import difflib
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

# Déclare explicitement les signatures Win32 : sans restype HWND, ctypes tronque
# les handles 64 bits en entier 32 bits et les vérifications de focus deviennent fausses.
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetAncestor.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL
user32.SetActiveWindow.argtypes = [wintypes.HWND]
user32.SetActiveWindow.restype = wintypes.HWND
user32.SetFocus.argtypes = [wintypes.HWND]
user32.SetFocus.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.c_void_p]
user32.GetWindowRect.restype = wintypes.BOOL
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = wintypes.BOOL
user32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
user32.mouse_event.restype = None
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL


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
    # Coordonnées normalisées sur le bureau virtuel complet (tous les écrans).
    # pyautogui.size() ne renvoie que l'écran principal et décale les clics sur le secondaire.
    import mss
    with mss.mss() as capture:
        virtual = capture.monitors[0]
    return (
        virtual["left"] + round(x * (virtual["width"] - 1) / 1000),
        virtual["top"] + round(y * (virtual["height"] - 1) / 1000),
    )


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
    matches = []

    @EnumWindowsProc
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


def _find_explorer_window():
    """Find Explorer by its native window class, regardless of the current folder title."""
    matches = []

    @EnumWindowsProc
    def enum_callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        class_buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buffer, len(class_buffer))
        if class_buffer.value in {"CabinetWClass", "ExploreWClass"}:
            matches.append(hwnd)
        return True

    user32.EnumWindows(enum_callback, 0)
    return matches[0] if matches else None


def _activate_existing_window(title_fragment):
    """Restore and focus an already-running app window."""
    hwnd = _find_window(title_fragment)
    if not hwnd:
        return False
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.8)
    return user32.GetForegroundWindow() == hwnd

def _canonical_app_name(name):
    raw = str(name or "").strip()
    folded = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii").casefold()
    compact = " ".join(folded.replace("_", " ").replace("-", " ").split())
    if any(token in compact for token in ("parametres windows", "windows settings", "windows setting", "settings", "parametres")):
        return "Paramètres Windows"
    if any(token in compact for token in ("explorateur", "file explorer", "windows explorer", "explorer")):
        return "Explorateur de fichiers"
    if any(token in compact for token in ("gestionnaire des taches", "task manager")):
        return "Gestionnaire des tâches"
    if any(token in compact for token in ("bloc notes", "notepad", "bloge notes", "blog notes", "bloc note")):
        return "Bloc-notes"
    if any(token in compact for token in ("calculatrice", "calculator", "calculette")):
        return "Calculatrice"
    if "streamlabs" in compact:
        return "Streamlabs Desktop"
    if "chrome" in compact:
        return "Google Chrome"
    if "edge" in compact:
        return "Microsoft Edge"
    # Tolère les petites erreurs de transcription sans choisir une application
    # arbitraire parmi les noms installés.
    candidates = [("bloc notes", "Bloc-notes"), ("calculatrice", "Calculatrice")]
    for target, canonical in candidates:
        if difflib.SequenceMatcher(None, compact, target).ratio() >= 0.76:
            return canonical
    return raw


def _app_title_aliases(name):
    canonical = _canonical_app_name(name)
    folded = canonical.casefold()
    if folded == "paramètres windows":
        return ("Paramètres", "Settings", "SystemSettings")
    if folded == "explorateur de fichiers":
        return ("Explorateur de fichiers", "File Explorer", "Explorateur")
    if folded == "gestionnaire des tâches":
        return ("Gestionnaire des tâches", "Task Manager")
    if folded == "bloc-notes":
        return ("Bloc-notes", "Notepad")
    if folded == "calculatrice":
        return ("Calculatrice", "Calculator")
    if folded == "google chrome":
        return ("Google Chrome", "Chrome")
    if folded == "microsoft edge":
        return ("Microsoft Edge", "Edge")
    if folded == "streamlabs desktop":
        return ("Streamlabs", "Streamlabs Desktop", "Streamlabs OBS")
    return (canonical,)


def _is_foreground_window(hwnd):
    foreground = user32.GetForegroundWindow()
    if not foreground:
        return False
    if foreground == hwnd:
        return True
    # Certaines applications WinUI exposent une fenêtre enfant distincte de la
    # fenêtre racine réellement activée.
    return (user32.GetAncestor(foreground, 2) == hwnd
            or user32.GetAncestor(foreground, 3) == hwnd)


def _force_foreground(hwnd):
    """Restore, focus and verify the real top-level window handle."""
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    current_thread = kernel32.GetCurrentThreadId()
    attached = False
    try:
        if target_thread and target_thread != current_thread:
            attached = bool(user32.AttachThreadInput(current_thread, target_thread, True))
        user32.ShowWindow(hwnd, 9 if user32.IsIconic(hwnd) else 5)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        if attached:
            user32.SetActiveWindow(hwnd)
            user32.SetFocus(hwnd)
        time.sleep(0.25)
        if _is_foreground_window(hwnd):
            return True
        # UI Automation focus is a useful second path for WinUI/UWP windows.
        try:
            Desktop(backend="uia").window(handle=int(hwnd)).set_focus()
            time.sleep(0.25)
        except Exception:
            pass
        return _is_foreground_window(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(current_thread, target_thread, False)


def _activate_app_window(name, timeout=15):
    aliases = _app_title_aliases(name)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for title in aliases:
            hwnd = _find_window(title)
            if hwnd and _force_foreground(hwnd):
                return title
        time.sleep(0.25)
    return None


def get_app_window_center(name):
    """Return the center of the requested app window in physical screen pixels."""
    for title in _app_title_aliases(name):
        hwnd = _find_window(title)
        if hwnd:
            class RECT(ctypes.Structure):
                _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                            ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
            rect = RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return ((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)
    return None


def _foreground_title():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return ""
    buffer = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value


def _require_expected_app(expected_app):
    if not expected_app:
        return
    foreground = user32.GetForegroundWindow()
    title = _foreground_title().casefold()
    expected = expected_app if isinstance(expected_app, (list, tuple, set)) else (expected_app,)
    if not foreground or not any(str(name).casefold() in title for name in expected):
        raise RuntimeError("Saisie bloquée : la fenêtre active n'est pas l'application demandée. Fenêtre active : " + (title or "inconnue"))


def _wait_for_blender_ready(timeout=90):
    """Wait for Blender's actual top-level window, focus it, then allow its UI to settle."""
    deadline = time.monotonic() + timeout
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
    name = _canonical_app_name(str(name or "").strip()[:80])
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
    if name == "Gestionnaire des tâches":
        subprocess.Popen(["taskmgr.exe"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        activated = _activate_app_window(name, timeout=12)
        if activated:
            return "Gestionnaire des tâches ouvert et fenêtre activée : " + activated
        raise RuntimeError("taskmgr.exe a été lancé, mais sa fenêtre n'a pas pu être activée.")
    if name == "Paramètres Windows":
        # Ouvre directement la page À propos, qui contient édition, version et build.
        subprocess.Popen(["cmd.exe", "/c", "start", "", "ms-settings:about"],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        time.sleep(1.2)
        return "Paramètres Windows ouverts sur Système > Informations système."
    if name == "Explorateur de fichiers":
        hwnd = _find_explorer_window()
        if hwnd and _force_foreground(hwnd):
            return "Fenêtre Explorateur existante activée."
        subprocess.Popen(["explorer.exe"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            hwnd = _find_explorer_window()
            if hwnd and _force_foreground(hwnd):
                return "Explorateur Windows ouvert et fenêtre activée."
            time.sleep(0.25)
        raise RuntimeError("Explorateur lancé, mais aucune fenêtre CabinetWClass/ExploreWClass n'a pu être activée.")
    escaped = name.replace("'", "''")
    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; "
        "$ErrorActionPreference='Stop'; $n='" + escaped + "'; "
        "if ($n -match '^(bloc[- ]?notes|notepad)$') { Start-Process notepad.exe; Write-Output 'Bloc-notes lancé directement' } "
        "elseif ($n -match '^(calculatrice|calculator)$') { Start-Process calc.exe; Write-Output 'Calculatrice lancée directement' } "
        "elseif ($n -match '^streamlabs( desktop)?$') { $a=Get-StartApps | Where-Object { $_.Name -match '(?i)streamlabs' } | Select-Object -First 1; "
        "if ($a) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$a.AppID); Write-Output ('Streamlabs lancé : '+$a.Name) } "
        "else { $roots=@(($env:ProgramFiles+'\\Streamlabs Desktop'),($env:LOCALAPPDATA+'\\Programs\\Streamlabs Desktop'),($env:ProgramFiles+'\\Streamlabs OBS')); "
        "$exe=$null; foreach ($root in $roots) { $candidate=Join-Path $root 'Streamlabs Desktop.exe'; if (Test-Path $candidate) { $exe=Get-Item $candidate; break } }; "
        "if ($exe) { Start-Process $exe.FullName; Write-Output ('Streamlabs lancé : '+$exe.FullName) } else { throw 'Streamlabs Desktop introuvable dans les applications installées.' } } } "
        "else { $a=Get-StartApps | Where-Object { $_.Name -like ('*'+$n+'*') } | "
        "Sort-Object @{Expression={if ($_.Name -ieq $n){0}elseif($_.Name -ilike ($n+'*')){1}else{2}}} | "
        "Select-Object -First 1; "
        "if ($a) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$a.AppID); "
        "Write-Output ('Application lancée : '+$a.Name) } "
        "else { $exe=$null; "
        "if ($n -match 'blender') { $exe=Get-ChildItem -Path ($env:ProgramFiles+'\\Blender Foundation') -Recurse -Filter blender.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }; "
        "if (-not $exe -and $n -match 'photoshop') { foreach ($root in @(($env:ProgramFiles+'\\Adobe'),(${env:ProgramFiles(x86)}+'\\Adobe'))) { $exe=Get-ChildItem -Path $root -Directory -Filter 'Adobe Photoshop*' -ErrorAction SilentlyContinue | ForEach-Object { Get-Item (Join-Path $_.FullName 'Photoshop.exe') -ErrorAction SilentlyContinue } | Select-Object -First 1; if ($exe) { break } } }; "
        "if ($exe) { Start-Process $exe.FullName; Write-Output ('Application lancée : '+$exe.FullName) } "
        "else { $c=Get-Command ($n+'.exe') -ErrorAction SilentlyContinue; if ($c) { Start-Process $c.Source; Write-Output ('Application lancée : '+$c.Source) } else { throw ('Application introuvable : '+$n) } } } }"
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
    # Ne pas ouvrir Explorer ici : find_latest_file doit uniquement retourner
    # le chemin. L'agent décidera ensuite s'il faut réellement ouvrir le fichier.
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


def _open_images_large_icons():
    """Open the user's Pictures known folder in Explorer and select Large icons."""
    subprocess.Popen(
        ["explorer.exe", "shell:My Pictures"],
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    deadline = time.monotonic() + 12
    last_error = ""
    while time.monotonic() < deadline:
        hwnd = _find_explorer_window()
        if hwnd and _force_foreground(hwnd) and _is_foreground_window(hwnd):
            time.sleep(0.8)  # let Explorer finish navigating to the known folder
            _send_windows_hotkey(["ctrl", "shift", "2"])  # File Explorer: Large icons
            time.sleep(0.5)
            if _is_foreground_window(hwnd):
                return "Explorateur ouvert dans Images ; affichage Grandes icônes demandé par Ctrl+Maj+2."
        else:
            last_error = "aucune fenêtre Explorer active détectée"
        time.sleep(0.25)
    raise RuntimeError("Impossible d'activer l'Explorateur pour ouvrir Images. " + last_error)


def _get_top_memory_apps():
    """Return the three visible desktop applications with the largest working sets."""
    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; "
        "$ErrorActionPreference='Stop'; "
        "$rows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | "
        "Group-Object ProcessName | ForEach-Object { "
        "$g=$_.Group; $title=($g | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle; "
        "[pscustomobject]@{ Application=$_.Name; Window=$title; MemoryMB=[math]::Round((($g | Measure-Object WorkingSet64 -Sum).Sum / 1MB),1) } "
        "} | Sort-Object MemoryMB -Descending | Select-Object -First 3; "
        "$rows | ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Lecture mémoire impossible.").strip()[:400])
    raw = (result.stdout or "").strip()
    if not raw:
        raise RuntimeError("Windows n'a retourné aucune application avec une fenêtre visible.")
    import json
    data = json.loads(raw)
    rows = data if isinstance(data, list) else [data]
    rows = [row for row in rows if isinstance(row, dict) and row.get("Application")]
    if not rows:
        raise RuntimeError("Aucune application visible n'a pu être classée par mémoire.")
    lines = []
    for index, row in enumerate(rows[:3], 1):
        title = str(row.get("Window") or "").strip()
        suffix = (" — " + title[:90]) if title else ""
        lines.append(str(index) + ". " + str(row["Application"]) + " — " + str(row.get("MemoryMB", "?")) + " Mo" + suffix)
    if len(lines) < 3:
        raise RuntimeError("Seulement " + str(len(lines)) + " applications visibles trouvées ; impossible de confirmer un top 3.")
    return "Top 3 des applications visibles par mémoire utilisée (Working Set) :\\n" + "\\n".join(lines)


def _launch_epic_and_fortnite():
    """Launch Epic Games Launcher and verify Fortnite's process after its official URI is invoked."""
    script = r'''
$ErrorActionPreference = 'Stop'
$epic = Get-Process -Name 'EpicGamesLauncher' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $epic) {
    $app = Get-StartApps | Where-Object { $_.Name -match '(?i)Epic Games Launcher' } | Select-Object -First 1
    if ($app) { Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $app.AppID) }
    else {
        $paths = @(
            "$env:ProgramFiles(x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
            "$env:ProgramFiles\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
            "$env:LOCALAPPDATA\Programs\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"
        )
        $exe = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $exe) { throw 'Epic Games Launcher est introuvable dans les applications installées et les emplacements standards.' }
        Start-Process $exe
    }
    $deadline = (Get-Date).AddSeconds(45)
    do { Start-Sleep -Seconds 1; $epic = Get-Process -Name 'EpicGamesLauncher' -ErrorAction SilentlyContinue | Select-Object -First 1 } until ($epic -or (Get-Date) -ge $deadline)
    if (-not $epic) { throw 'Epic Games Launcher a été demandé, mais son processus ne démarre pas.' }
}
$game = Get-Process -Name 'FortniteClient-Win64-Shipping' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($game) { Write-Output 'Fortnite est déjà lancé et son processus est détecté.'; exit 0 }
Start-Process 'com.epicgames.launcher://apps/Fortnite?action=launch&silent=true'
$deadline = (Get-Date).AddSeconds(120)
do { Start-Sleep -Seconds 2; $game = Get-Process -Name 'FortniteClient-Win64-Shipping' -ErrorAction SilentlyContinue | Select-Object -First 1 } until ($game -or (Get-Date) -ge $deadline)
if (-not $game) { throw 'La demande de lancement a été envoyée à Epic Games Launcher, mais Fortnite n’a pas démarré dans les 120 secondes. Vérifier une éventuelle mise à jour, connexion ou fenêtre de confirmation dans Epic.' }
Write-Output 'Fortnite est lancé : processus FortniteClient-Win64-Shipping détecté.'
'''
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=175, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Échec du lancement d’Epic Games / Fortnite.").strip()[:700])
    return (result.stdout or "Epic Games Launcher et Fortnite ont été détectés.").strip()

def execute(action, confirm, expected_app=None):
    kind = action.get("action")
    if kind == "launch_epic_fortnite":
        return _launch_epic_and_fortnite()
    if kind == "open_images_large_icons":
        return _open_images_large_icons()
    if kind == "get_top_memory_apps":
        return _get_top_memory_apps()
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
        # Computer Use visuel : le modèle choisit un point sur la capture et
        # Windows reçoit un vrai clic à ces coordonnées du bureau virtuel.
        # Cela fonctionne aussi sur les écrans secondaires et les interfaces
        # personnalisées qui n'exposent aucun contrôle UI Automation.
        if not user32.SetCursorPos(int(x), int(y)):
            raise RuntimeError("Windows n'a pas pu déplacer le curseur vers le point visé.")
        if kind == "right_click":
            buttons = ((0x0008, 0x0010),)  # RIGHTDOWN, RIGHTUP
        elif kind == "double_click":
            buttons = ((0x0002, 0x0004), (0x0002, 0x0004))  # LEFTDOWN/UP x2
        else:
            buttons = ((0x0002, 0x0004),)  # LEFTDOWN, LEFTUP
        for index, (down_flag, up_flag) in enumerate(buttons):
            user32.mouse_event(down_flag, 0, 0, 0, 0)
            time.sleep(0.045)
            user32.mouse_event(up_flag, 0, 0, 0, 0)
            if index + 1 < len(buttons):
                time.sleep(0.09)
        return "Clic visuel envoyé à Windows aux coordonnées (" + str(x) + ", " + str(y) + ")."
    if kind == "type":
        value = str(action.get("text") or "")[:2000]
        if not value:
            return "Aucun texte à saisir."
        # Send Unicode keystrokes to the currently focused application. This works
        # in standard edit controls, WinUI/UWP apps and custom fields that expose
        # no UIA ValuePattern. It does not move the user's physical mouse.
        _require_expected_app(expected_app)
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
        # Tolère la ponctuation ajoutée par le modèle, sans accepter de calcul complexe.
        expression = expression.rstrip(" =")
        match = re.fullmatch(r"(\d{1,12})\s*([+×xX*÷/−-])\s*(\d{1,12})", expression)
        if not match:
            raise ValueError("Calcul refusé : expression arithmétique simple attendue.")
        _require_expected_app(("Calculatrice", "Calculator"))
        left, operator, right = match.groups()
        operator_keys = {"+": 0x6B, "×": 0x6A, "x": 0x6A, "X": 0x6A,
                         "*": 0x6A, "÷": 0x6F, "/": 0x6F, "−": 0x6D, "-": 0x6D}
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
        amount = max(-12, min(12, int(action.get("amount", -3))))
        if not user32.SetCursorPos(int(x), int(y)):
            raise RuntimeError("Windows n'a pas pu placer le curseur sur la zone à faire défiler.")
        # WM_MOUSEWHEEL : positif = haut, négatif = bas. Le défilement visuel
        # ne dépend pas de la présence d'un ScrollPattern UI Automation.
        user32.mouse_event(0x0800, 0, 0, int(amount * 120), 0)
        return "Défilement visuel envoyé à Windows à l'emplacement (" + str(x) + ", " + str(y) + ")."
    if kind == "get_windows_version":
        import winreg
        key_path = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as key:
            def read_value(name, default=""):
                try:
                    return str(winreg.QueryValueEx(key, name)[0])
                except OSError:
                    return default
            product = read_value("ProductName", "Windows")
            display_version = read_value("DisplayVersion", "")
            build = read_value("CurrentBuildNumber", read_value("CurrentBuild", ""))
            revision = read_value("UBR", "")
            edition = read_value("EditionID", "")
        try:
            if int(build) >= 22000 and "Windows 10" in product:
                product = product.replace("Windows 10", "Windows 11", 1)
        except ValueError:
            pass
        version_text = product
        if edition and edition.casefold() not in product.casefold():
            version_text += " (" + edition + ")"
        if display_version:
            version_text += " — version " + display_version
        if build:
            version_text += " — build " + build + (("." + revision) if revision else "")
        return "Version Windows détectée dans le Registre : " + version_text
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

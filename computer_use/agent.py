import argparse
import ctypes
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

from pynput import keyboard

from actions import execute
from brain import LocalVisionBrain
from capture import capture_screen, save_debug_capture


stop_event = threading.Event()
stdin_lock = threading.Lock()


def emit(event, **payload):
    message = {"event": event, **payload}
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_controls():
    for line in sys.stdin:
        try:
            data = json.loads(line)
        except Exception:
            continue
        if data.get("type") == "stop":
            stop_event.set()
        elif data.get("type") == "approval":
            with stdin_lock:
                pending = getattr(read_controls, "pending", None)
                if pending is not None:
                    pending["approved"] = bool(data.get("approved"))
                    pending["event"].set()


def confirm(reason):
    pending = {"event": threading.Event(), "approved": False}
    with stdin_lock:
        read_controls.pending = pending
    emit("confirmation_required", reason=str(reason)[:500])
    while not stop_event.is_set():
        if pending["event"].wait(0.2):
            with stdin_lock:
                read_controls.pending = None
            return pending["approved"]
    with stdin_lock:
        read_controls.pending = None
    return False


def emergency_key(key):
    if key == keyboard.Key.esc:
        stop_event.set()
        emit("status", active=False, message="Arrêt d'urgence demandé avec Échap.")
        os._exit(130)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--model", default=os.environ.get("OVERLAYIA_VISION_MODEL", "qwen2.5vl:3b"))
    parser.add_argument("--logs", required=True)
    args = parser.parse_args()

    threading.Thread(target=read_controls, daemon=True).start()
    listener = keyboard.Listener(on_press=emergency_key)
    listener.start()
    history = []
    screenshots = []
    log_dir = Path(args.logs)
    log_dir.mkdir(parents=True, exist_ok=True)
    emit("status", active=True, message="Initialisation du moteur Python…")
    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "start", "detail": args.task})

    try:
        brain = LocalVisionBrain(args.model)
        if re.search(r"\b(supprime|supprimer|efface|effacer|delete|remove|vider|formater)\b", args.task, re.IGNORECASE):
            if not confirm("La tâche demande une suppression ou une modification potentiellement destructive. Autoriser cette tâche ?"):
                emit("status", active=False, message="Tâche refusée : confirmation non accordée.")
                return
        emit("status", active=True, message="Connexion à Ollama…")
        step = 0
        while step < 30 and not stop_event.is_set():
            step += 1
            emit("status", active=True, message="Observation " + str(step) + "/30")
            shot = capture_screen(add_grid=os.environ.get("OVERLAYIA_COMPUTER_GRID") == "1")
            screenshots.append(shot["data_url"])
            screenshots = screenshots[-2:]
            decision = brain.decide(args.task, history, screenshots)
            action = decision.get("action")
            thought = str(decision.get("thought") or "").strip()[:400]
            emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "decision", "detail": thought or str(action)})
            if action == "done":
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "done", "detail": thought or "Tâche terminée."})
                emit("status", active=False, message=thought or "Tâche terminée.")
                break
            if stop_event.is_set():
                break
            try:
                result = execute(decision, confirm)
                save_debug_capture(shot["image"], log_dir, decision)
                history.append("Action " + str(step) + " : " + str(action) + " ; résultat : " + result)
                history = history[-24:]
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": str(action), "detail": result})
                emit("status", active=True, message=result)
                if result.startswith("Action refusée"):
                    stop_event.set()
            except Exception as exc:
                save_debug_capture(shot["image"], log_dir, decision)
                history.append("Action " + str(step) + " échouée : " + str(exc)[:300])
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "error", "detail": str(exc)[:500]})
                emit("status", active=True, message="Action impossible : " + str(exc)[:200])
                if "PyAutoGUI fail-safe" in str(exc):
                    stop_event.set()
        else:
            if not stop_event.is_set():
                emit("status", active=False, message="Limite de 30 actions atteinte.")
    except Exception as exc:
        emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "error", "detail": str(exc)[:500]})
        emit("status", active=False, message="Computer Use : " + str(exc)[:500], error=True)
    finally:
        stop_event.set()
        try:
            listener.stop()
        except Exception:
            pass
        emit("status", active=False, message="Agent inactif.")


if __name__ == "__main__":
    main()

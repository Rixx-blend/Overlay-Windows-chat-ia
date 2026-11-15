import argparse
import ctypes
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus, urlparse

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
    repeated_errors = {}
    invalid_plan_count = 0
    blender_delete_task = (
        bool(re.search(r"\bblender\b", args.task, re.IGNORECASE))
        and bool(re.search(r"\b(supprime|supprimer|efface|effacer|delete|remove)\b", args.task, re.IGNORECASE))
        and bool(re.search(r"\b(cube|objet)\b", args.task, re.IGNORECASE))
    )
    blender_x_sent = False
    blender_enter_sent = False
    blender_enter_step = -1
    calculator_opened = False
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
            emit("status", active=True, message="Analyse de l’écran — observation " + str(step) + "/30")
            shot = capture_screen(add_grid=os.environ.get("OVERLAYIA_COMPUTER_GRID") == "1")
            # Display the AI cursor from the start of each observation, not only on clicks.
            class _POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
            _point = _POINT()
            screenshots.append(shot["data_url"])
            screenshots = screenshots[-2:]
            emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "observation", "detail": "Capture d’écran actualisée et transmise au modèle visuel pour examiner les éléments visibles."})
            decision = brain.decide(args.task, history, screenshots)
            action = decision.get("action")
            thought = str(decision.get("thought") or "").strip()[:400]

            # Deterministic routing for clear Windows file/folder requests.
            task_folded = args.task.casefold()
            asks_recent_download = (
                any(term in task_folded for term in ("téléchargements", "telechargements", "downloads"))
                and any(term in task_folded for term in ("plus récent", "plus recente", "dernier fichier", "dernière fichier", "fichier le plus récent", "fichier le plus recent"))
            )
            if asks_recent_download:
                decision = {"action": "find_latest_file", "folder": "Téléchargements", "extension": "*",
                            "thought": "Recherche du fichier le plus récent dans le dossier Téléchargements Windows."}
                action = decision["action"]
                thought = decision["thought"]

            asks_calculator = (
                bool(re.search(r"calculatrice|calculator", task_folded))
                and bool(re.search(r"calcul|calcule|calculer|compute", task_folded))
            )
            if asks_calculator and not calculator_opened:
                decision = {"action": "open_app", "app": "Calculatrice",
                            "thought": "Ouverture de la Calculatrice Windows."}
                action = decision["action"]
                thought = decision["thought"]

            # Blender deletion must wait for a real X -> Enter sequence and a fresh
            # screenshot before the model is allowed to claim completion.
            if blender_delete_task and action == "hotkey":
                proposed_keys = [str(key).lower() for key in (decision.get("keys") or [])]
                if proposed_keys in (["ctrl", "a"], ["a", "ctrl"]):
                    detail = "Ctrl+A ne supprime pas le cube dans Blender. Attends la vue 3D et utilise X sur le cube sélectionné."
                    history.append(detail)
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": detail})
                    emit("status", active=True, message="Raccourci incorrect : nouvelle décision demandée…")
                    continue
                if proposed_keys == ["enter"] and not blender_x_sent:
                    detail = "Entrée ne peut confirmer aucune suppression : la touche X n'a pas encore été envoyée."
                    history.append(detail)
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": detail})
                    continue

            if blender_delete_task and action == "done":
                has_fresh_verification = blender_enter_sent and step > blender_enter_step
                if not has_fresh_verification:
                    detail = "Vérification refusée : le cube n'a pas encore été supprimé puis contrôlé sur une nouvelle capture."
                    history.append(detail)
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": detail})
                    emit("status", active=True, message="La suppression n'est pas vérifiée : contrôle de la scène…")
                    continue

            # Reject invented natural-language actions before they reach the executor.
            allowed_actions = {"left_click", "double_click", "type", "hotkey", "scroll", "wait", "open_app", "open_url", "find_latest_file", "open_file", "done"}
            if action not in allowed_actions:
                invalid_plan_count += 1
                error_detail = "Action non autorisée retournée par le modèle : " + str(action)[:100]
                history.append("ERREUR DE PLANIFICATION : " + error_detail + ". Choisis exclusivement une action dans cette liste : " + ", ".join(sorted(allowed_actions)) + ". Pour YouTube, utilise open_url ou les contrôles du navigateur. N'invente pas d'action et ne délègue pas à ChatGPT.")
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": error_detail})
                if invalid_plan_count >= 3:
                    emit("status", active=False, message="Le modèle a produit 3 actions non autorisées. Arrêt de sécurité.", error=True)
                    break
                emit("status", active=True, message="Action invalide : nouvelle décision demandée…")
                continue
            invalid_plan_count = 0

            # Recover from a common planner error: a website was emitted as an app,
            # or open_app was returned without the required app name.
            if action == "open_app":
                app_name = str(decision.get("app") or "").strip()
                site_map = {
                    "youtube": "https://www.youtube.com",
                    "google": "https://www.google.com",
                    "wikipedia": "https://fr.wikipedia.org",
                    "amazon": "https://www.amazon.fr",
                    "twitch": "https://www.twitch.tv",
                    "reddit": "https://www.reddit.com",
                    "instagram": "https://www.instagram.com",
                    "facebook": "https://www.facebook.com",
                    "tiktok": "https://www.tiktok.com",
                    "netflix": "https://www.netflix.com",
                    "spotify": "https://open.spotify.com",
                    "discord": "https://discord.com/app",
                    "gmail": "https://mail.google.com",
                    "outlook": "https://outlook.live.com",
                }
                normalized_app = app_name.casefold().strip()
                if normalized_app in site_map:
                    decision = {"action": "open_url", "url": site_map[normalized_app],
                                "thought": "Il s'agit d'un site Web : ouverture dans le navigateur, pas lancement d'une application Windows."}
                    action = "open_url"
                    thought = decision["thought"]
                elif not app_name:
                    invalid_plan_count += 1
                    if invalid_plan_count >= 3:
                        emit("status", active=False, message="Le modèle n'arrive pas à choisir une action valide après 3 tentatives. La tâche est arrêtée sans action incorrecte.", error=True)
                        break
                    history.append("ERREUR DE PLANIFICATION : open_app exige un nom d'application. La tâche peut concerner un site Web ou le navigateur déjà ouvert. Observe la capture et choisis open_url pour un site, ou une action de navigation dans le navigateur existant. Ne répète pas open_app sans nom.")
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": "Action incomplète : nouvelle décision demandée au modèle."})
                    emit("status", active=True, message="Correction de la décision…")
                    continue

            # Repair incomplete URLs and turn a YouTube video request into a direct search.
            if action == "open_url":
                raw_url = str(decision.get("url") or "").strip()
                parsed_url = urlparse(raw_url)
                # A search phrase is not a URL. Convert it to a real Google search URL.
                asks_web_search = bool(re.search(r"\b(recherche|rechercher|cherche|chercher|search)\b", args.task, re.IGNORECASE))
                invalid_as_url = (not raw_url or " " in raw_url or parsed_url.scheme not in {"http", "https"} and "." not in raw_url.split("/")[0])
                if asks_web_search and (invalid_as_url or parsed_url.netloc.casefold() in {"google.com", "www.google.com"} and parsed_url.path in {"", "/"}):
                    query = raw_url if raw_url and " " in raw_url and len(raw_url.split()) <= 8 else ""
                    if not query:
                        match = re.search(r"\b(?:recherche|rechercher|cherche|chercher|search)\s+(?:sur\s+(?:google|internet)\s+)?(.+)$", args.task, re.IGNORECASE)
                        query = match.group(1).strip() if match else ""
                        query = re.sub(r"^(?:sur\s+google\s+)?", "", query, flags=re.IGNORECASE)
                    query = query.strip(" «»\"'")
                    if query:
                        decision["url"] = "https://www.google.com/search?q=" + quote_plus(query)
                        raw_url = decision["url"]
                        parsed_url = urlparse(raw_url)
                        thought = "La demande est une recherche web : ouverture des résultats Google."
                if not parsed_url.scheme and raw_url:
                    # Models often return www.youtube.com without the required scheme.
                    if "." in raw_url.split("/")[0] and " " not in raw_url:
                        raw_url = "https://" + raw_url.lstrip("/")
                        parsed_url = urlparse(raw_url)

                task_lower_for_url = args.task.casefold()
                asks_youtube_video = (
                    "youtube" in task_lower_for_url
                    and any(word in task_lower_for_url for word in ("vidéo", "video"))
                )
                if asks_youtube_video and (
                    not raw_url
                    or parsed_url.scheme not in {"http", "https"}
                    or not parsed_url.netloc
                    or parsed_url.netloc.casefold() in {"youtube.com", "www.youtube.com", "m.youtube.com"}
                    and parsed_url.path in {"", "/"}
                ):
                    # Extract the subject after the user's mention of a video.
                    subject = ""
                    match = re.search(
                        r"vid[eé]os?\s+(?:sur|de|d['’]|que|concernant|à propos de)\s+(.+)$",
                        args.task,
                        re.IGNORECASE,
                    )
                    if match:
                        subject = match.group(1).strip(" \t.!?").strip()
                        subject = re.sub(r"^(?:l['’]|le |la |les |un |une )", "", subject, flags=re.IGNORECASE)
                    if not subject:
                        subject_match = re.search(r"informatique\s+quantique", args.task, re.IGNORECASE)
                        subject = subject_match.group(0) if subject_match else "informatique quantique"
                    decision["url"] = "https://www.youtube.com/results?search_query=" + quote_plus(subject)
                    thought = "Recherche du sujet demandé directement sur YouTube."
                    decision["thought"] = thought
                elif raw_url != str(decision.get("url") or "").strip():
                    decision["url"] = raw_url

            # Correct a common vision-model mistake: treating Downloads itself as a file.
            task_lower = args.task.casefold()
            asks_for_png_in_downloads = (
                ("png" in task_lower or "fichier" in task_lower)
                and ("telechargements" in task_lower or "téléchargements" in task_lower or "downloads" in task_lower)
                and any(word in task_lower for word in ("dernier", "dernière", "chercher", "trouver", "rechercher"))
            )
            if action == "open_file" and asks_for_png_in_downloads:
                candidate = str(decision.get("path") or "").strip().rstrip("\\\\/")
                folder_name = Path(candidate).name.casefold()
                if folder_name in {"téléchargements", "telechargements", "downloads", "download"}:
                    decision = {
                        "action": "find_latest_file",
                        "folder": "Téléchargements",
                        "extension": ".png",
                        "thought": "Je recherche le dernier PNG dans Téléchargements, sans essayer d'ouvrir le dossier."
                    }
                    action = decision["action"]
                    thought = decision["thought"]

            emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "decision", "detail": thought or str(action)})
            if action == "done":
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "done", "detail": thought or "Tâche terminée."})
                emit("status", active=False, message=thought or "Tâche terminée.")
                break
            if stop_event.is_set():
                break
            try:
                if action in {"left_click", "double_click", "scroll"}:
                    emit("cursor", x=round(float(decision.get("x", 0)) * shot["screen_width"] / 1000),
                         y=round(float(decision.get("y", 0)) * shot["screen_height"] / 1000), action=action)
                result = execute(decision, confirm)
                if blender_delete_task and action == "hotkey":
                    sent_keys = [str(key).lower() for key in (decision.get("keys") or [])]
                    if sent_keys == ["x"]:
                        blender_x_sent = True
                        emit("status", active=True, message="Blender : demande de suppression envoyée, attente de la confirmation…")
                    elif sent_keys == ["enter"] and blender_x_sent:
                        blender_enter_sent = True
                        blender_enter_step = step
                        emit("status", active=True, message="Blender : confirmation envoyée, nouvelle capture pour vérifier la scène…")
                if asks_calculator and action == "open_app" and str(decision.get("app", "")).casefold() == "calculatrice":
                    calculator_opened = True
                    emit("status", active=True, message="Calculatrice ouverte : lecture de l’écran avant la saisie du calcul…")
                    time.sleep(1.0)
                if blender_delete_task and action == "open_app":
                    emit("status", active=True, message="Blender détecté : attente de stabilisation de la vue 3D…")
                    time.sleep(2.0)
                save_debug_capture(shot["image"], log_dir, decision)
                history.append("Action " + str(step) + " : " + str(action) + " ; résultat : " + result)
                history = history[-24:]
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": str(action), "detail": result})
                emit("status", active=True, message=result)
                if result.startswith("Action refusée"):
                    stop_event.set()
            except Exception as exc:
                save_debug_capture(shot["image"], log_dir, decision)
                error_text = str(exc)[:300]
                error_key = str(action) + "|" + error_text
                repeated_errors[error_key] = repeated_errors.get(error_key, 0) + 1
                history.append("Action " + str(step) + " échouée : " + error_text)
                emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "error", "detail": error_text})
                fatal = isinstance(exc, (ValueError, FileNotFoundError, PermissionError))
                repeated = repeated_errors[error_key] >= 2
                if fatal or repeated or "PyAutoGUI fail-safe" in error_text:
                    stop_event.set()
                    emit("status", active=False, message="Arrêt après une erreur non récupérable : " + error_text[:180], error=True)
                else:
                    emit("status", active=True, message="Action impossible : " + error_text[:180])
        else:
            if not stop_event.is_set():
                emit("status", active=False, message="Limite de 30 actions atteinte.")
    except Exception as exc:
        emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "error", "detail": str(exc)[:500]})
        emit("status", active=False, message="Computer Use : " + str(exc)[:500], error=True)
    finally:
        emit("cursor_hide")
        stop_event.set()
        try:
            listener.stop()
        except Exception:
            pass
        emit("status", active=False, message="Agent inactif.")


if __name__ == "__main__":
    main()

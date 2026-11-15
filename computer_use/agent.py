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

from actions import execute, get_app_window_center
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
    calculator_sent = False
    recent_download_path = None
    recent_download_opened = False
    cursor_initialized = False
    asks_streamlabs_recording = bool(re.search(r"streamlabs", args.task, re.IGNORECASE) and re.search(r"enregistr|record|capture d[’']écran|capture écran", args.task, re.IGNORECASE))
    streamlabs_launch_requested = False
    asks_windows_version = bool(
        re.search(r"\b(version|build)\b", args.task, re.IGNORECASE)
        and re.search(r"\b(windows|param[eè]tres)\b", args.task, re.IGNORECASE)
    )
    windows_settings_opened = False
    windows_version_retrieved = False
    asks_images_large_icons = bool(
        re.search(r"\\b(images|image|pictures|photos)\\b", args.task, re.IGNORECASE)
        and re.search(r"grandes?\\s+ic[oô]nes|large\\s+icons", args.task, re.IGNORECASE)
        and re.search(r"explorateur|explorer|fichiers", args.task, re.IGNORECASE)
    )
    asks_top_memory = bool(
        re.search(r"gestionnaire des t[aâ]ches|task manager", args.task, re.IGNORECASE)
        and re.search(r"m[eé]moire|memory|ram", args.task, re.IGNORECASE)
        and re.search(r"trois|3|top", args.task, re.IGNORECASE)
    )
    images_view_completed = False
    task_manager_opened = False
    top_memory_reported = False
    last_open_app = ""
    repeated_open_app_count = 0

    # Plan explicite pour une demande simple d'ouverture puis d'alternance
    # entre Chrome et le Bloc-notes : le petit modèle ne doit pas rester bloqué
    # à répéter la première application observée.
    # Détecte les demandes d'alternance même si l'utilisateur ajoute
    # « puis », « ensuite » ou une formulation légèrement différente.
    asks_switch_apps = bool(re.search(
        r"(?:passe(?:r)?|bascul(?:e|er)|alterne(?:r)?)\b.{0,70}\b(?:entre|de)\b|switch\s+between",
        args.task, re.IGNORECASE
    ) or re.search(r"de\s+l['’]un\s+[àa]\s+l['’]autre", args.task, re.IGNORECASE))
    switch_sequence = (["Google Chrome", "Bloc-notes", "Google Chrome", "Bloc-notes"]
                       if asks_switch_apps and re.search(r"chrome", args.task, re.IGNORECASE)
                       and re.search(r"bloc[- ]notes|notepad", args.task, re.IGNORECASE) else [])
    switch_index = 0
    expected_app = None
    if asks_streamlabs_recording:
        expected_app = ("Streamlabs", "Streamlabs Desktop", "Streamlabs OBS")
    elif re.search(r"bloc[- ]notes|notepad", args.task, re.IGNORECASE):
        expected_app = ("Bloc-notes", "Notepad")
    elif re.search(r"calculatrice|calculator", args.task, re.IGNORECASE):
        expected_app = ("Calculatrice", "Calculator")
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
            screenshots.append(shot["data_url"])
            screenshots = screenshots[-2:]
            if not cursor_initialized:
                emit("cursor", x=shot.get("screen_left", 0) + shot["screen_width"] // 2,
                     y=shot.get("screen_top", 0) + shot["screen_height"] // 2, action="observe")
                cursor_initialized = True
            emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "observation", "detail": "Capture d’écran actualisée et transmise au modèle visuel pour examiner les éléments visibles."})
            decision = brain.decide(args.task, history, screenshots)
            action = decision.get("action")
            thought = str(decision.get("thought") or "").strip()[:400]
            # Route explicit Streamlabs recording requests to the desktop app first;
            # never let a small vision model reinterpret the product as a website.
            if asks_streamlabs_recording and not streamlabs_launch_requested:
                decision = {"action": "open_app", "app": "Streamlabs Desktop",
                            "thought": "Lancement de l’application Streamlabs Desktop avant de repérer le contrôle d’enregistrement local."}
                action = decision["action"]
                thought = decision["thought"]
            if asks_windows_version and not windows_settings_opened:
                decision = {"action": "open_app", "app": "Paramètres Windows",
                            "thought": "Ouverture directe de Paramètres Windows sur la page Informations système."}
                action = decision["action"]
                thought = decision["thought"]
            elif asks_windows_version and windows_settings_opened and not windows_version_retrieved:
                decision = {"action": "get_windows_version",
                            "thought": "Lecture de l’édition, de la version et du numéro de build exacts dans le Registre Windows."}
                action = decision["action"]
                thought = decision["thought"]
            if asks_images_large_icons and not images_view_completed:
                decision = {"action": "open_images_large_icons",
                            "thought": "Ouverture directe du dossier Images dans l’Explorateur et sélection de Grandes icônes."}
                action = decision["action"]
                thought = decision["thought"]
            if asks_top_memory and not top_memory_reported:
                if not task_manager_opened:
                    decision = {"action": "open_app", "app": "Gestionnaire des tâches",
                                "thought": "Ouverture du Gestionnaire des tâches avant la mesure des applications."}
                else:
                    decision = {"action": "get_top_memory_apps",
                                "thought": "Mesure et classement des trois applications visibles utilisant le plus de mémoire."}
                action = decision["action"]
                thought = decision["thought"]

            # Deterministic routing for clear Windows file/folder requests.
            task_folded = args.task.casefold()
            asks_recent_download = (
                any(term in task_folded for term in ("téléchargements", "telechargements", "downloads"))
                and any(term in task_folded for term in ("plus récent", "plus recente", "dernier fichier", "dernière fichier", "fichier le plus récent", "fichier le plus recent"))
            )
            asks_open_recent_download = asks_recent_download and bool(
                re.search(r"\b(ouvre|ouvrir|ouvrir-le|ouvre-le|affiche|afficher|open)\b", task_folded)
            )
            if asks_recent_download and (recent_download_path is None or not asks_open_recent_download):
                decision = {"action": "find_latest_file", "folder": "Téléchargements", "extension": "*",
                            "thought": "Recherche du fichier le plus récent dans le dossier Téléchargements Windows."}
                action = decision["action"]
                thought = decision["thought"]
            elif asks_open_recent_download and recent_download_path and not recent_download_opened:
                decision = {"action": "open_file", "path": recent_download_path,
                            "thought": "Ouverture du fichier le plus récent identifié dans Téléchargements."}
                action = decision["action"]
                thought = decision["thought"]

            if switch_sequence:
                if switch_index < len(switch_sequence):
                    decision = {"action": "open_app", "app": switch_sequence[switch_index],
                                "thought": "Activation de " + switch_sequence[switch_index] + " (" + str(switch_index + 1) + "/" + str(len(switch_sequence)) + ")."}
                else:
                    decision = {"action": "done", "thought": "Alternance terminée : Chrome et le Bloc-notes ont été activés successivement."}
                action = decision["action"]
                thought = decision["thought"]

            asks_calculator = (
                bool(re.search(r"calculatrice|calculator", task_folded))
                and bool(re.search(r"calcul|calcule|calculer|compute", task_folded))
            )
            calculator_match = re.search(r"(\d{1,12})\s*[×xX*]\s*(\d{1,12})", args.task)
            calculator_expression = (calculator_match.group(1) + "×" + calculator_match.group(2)) if calculator_match else ""
            if asks_calculator and not calculator_opened:
                decision = {"action": "open_app", "app": "Calculatrice",
                            "thought": "Ouverture et activation de la Calculatrice Windows."}
                action = decision["action"]
                thought = decision["thought"]
            elif asks_calculator and calculator_opened and calculator_expression and not calculator_sent:
                decision = {"action": "calculate", "expression": calculator_expression,
                            "thought": "Saisie du calcul dans la Calculatrice, touche par touche."}
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
            allowed_actions = {"left_click", "double_click", "type", "hotkey", "scroll", "wait", "open_app", "open_url", "find_latest_file", "open_file", "calculate", "get_windows_version", "open_images_large_icons", "get_top_memory_apps", "done"}
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
            # Ne réinitialise pas le compteur ici : open_app sans nom doit
            # réellement atteindre la limite de tentatives, au lieu de boucler à l'infini.

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

            # Une décision exploitable a été obtenue ; les erreurs suivantes
            # seront comptées séparément par leur signature.
            invalid_plan_count = 0

            # Repair incomplete URLs and turn a YouTube video request into a direct search.
            if action == "open_url":
                raw_url = str(decision.get("url") or "").strip()
                markdown_link = re.fullmatch(r"\\[([^\\]]+)\\]\\((https?://[^)]+)\\)", raw_url)
                if markdown_link:
                    raw_url = markdown_link.group(2).strip()
                raw_url = raw_url.replace("\\\\", "")
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
                final_url = urlparse(str(decision.get("url") or "").strip())
                if final_url.scheme not in {"http", "https"} or not final_url.netloc:
                    invalid_plan_count += 1
                    detail = "URL invalide rejetée avant exécution. Pour une application Windows, utilise open_app ; pour un site, fournis une URL http(s) complète."
                    history.append(detail)
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": detail})
                    if invalid_plan_count >= 3:
                        emit("status", active=False, message="Trois URL invalides proposées : tâche arrêtée sans ouvrir d'adresse incorrecte.", error=True)
                        break
                    emit("status", active=True, message="Adresse invalide : nouvelle décision demandée…")
                    continue

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
            # Empêche le modèle de relancer indéfiniment la même application.
            if action == "open_app":
                requested_app = str(decision.get("app") or "").strip().casefold()
                if requested_app == last_open_app:
                    repeated_open_app_count += 1
                else:
                    last_open_app = requested_app
                    repeated_open_app_count = 0
                if repeated_open_app_count >= 2:
                    detail = "Blocage de boucle : la même application a été demandée plusieurs fois sans progression. Nouvelle stratégie requise."
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "replan", "detail": detail})
                    emit("status", active=False, error=True, message=detail)
                    break

            try:
                # Déplacer le curseur AVANT l'action système. Le curseur suivait
                # auparavant uniquement certains clics, et les déplacements liés
                # à la saisie étaient envoyés après l'action : visuellement il
                # semblait donc figé pendant presque toute l'exécution.
                if decision.get("x") is not None and decision.get("y") is not None:
                    cursor_x = shot.get("screen_left", 0) + round(float(decision["x"]) * shot["screen_width"] / 1000)
                    cursor_y = shot.get("screen_top", 0) + round(float(decision["y"]) * shot["screen_height"] / 1000)
                    emit("cursor", x=cursor_x, y=cursor_y, action=action or "move")
                elif action in {"type", "hotkey", "calculate"}:
                    app_center = get_app_window_center("Calculatrice" if asks_calculator else ("Bloc-notes" if expected_app else "Google Chrome"))
                    if app_center:
                        emit("cursor", x=app_center[0], y=app_center[1], action="move")
                result = execute(decision, confirm, expected_app=expected_app)
                if action == "open_app" and asks_windows_version and str(decision.get("app", "")).casefold() == "paramètres windows":
                    windows_settings_opened = True
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "open_app", "detail": result})
                    emit("status", active=True, message=result + " Vérification de la version exacte…")
                    time.sleep(1.0)
                    continue
                if action == "get_windows_version":
                    windows_version_retrieved = True
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "get_windows_version", "detail": result})
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "done", "detail": result})
                    emit("status", active=False, message=result)
                    break
                if action == "open_images_large_icons":
                    images_view_completed = True
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "open_images_large_icons", "detail": result})
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "done", "detail": result})
                    emit("status", active=False, message=result)
                    break
                if action == "open_app" and asks_top_memory and str(decision.get("app", "")).casefold() == "gestionnaire des tâches":
                    task_manager_opened = True
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "open_app", "detail": result})
                    emit("status", active=True, message="Gestionnaire des tâches ouvert. Mesure des applications…")
                    time.sleep(1.0)
                    continue
                if action == "get_top_memory_apps":
                    top_memory_reported = True
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "get_top_memory_apps", "detail": result})
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "done", "detail": result})
                    emit("status", active=False, message=result)
                    break
                if action == "open_app" and asks_streamlabs_recording and str(decision.get("app", "")).casefold().startswith("streamlabs"):
                    streamlabs_launch_requested = True
                    emit("status", active=True, message="Streamlabs ouvert : attente de stabilisation avant de repérer le bouton d’enregistrement…")
                    time.sleep(3.0)
                    continue
                if action == "open_app":
                    app_center = get_app_window_center(decision.get("app", ""))
                    if app_center:
                        emit("cursor", x=app_center[0], y=app_center[1], action="move")
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
                    emit("status", active=True, message="Calculatrice ouverte et activée : préparation du calcul…")
                    time.sleep(1.0)
                if asks_calculator and action == "calculate":
                    calculator_sent = True
                    emit("status", active=True, message="Calcul saisi : vérification visuelle du résultat…")
                    time.sleep(0.8)
                if action == "find_latest_file":
                    recent_download_path = result
                    filename = Path(result).name
                    detail = "Fichier le plus récent trouvé dans Téléchargements : " + filename
                    history.append("Fichier trouvé : " + result)
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "find_latest_file", "detail": detail})
                    emit("status", active=True, message=detail)
                    if not asks_open_recent_download:
                        emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "done", "detail": detail})
                        emit("status", active=False, message=detail)
                        stop_event.set()
                        break
                    continue
                if action == "open_file":
                    recent_download_opened = True
                    detail = "Ouverture demandée pour le fichier : " + Path(str(decision.get("path") or "")).name
                    history.append("Fichier ouvert avec l'application par défaut ; vérifie maintenant la capture d'écran.")
                    emit("history", item={"time": datetime.now(timezone.utc).isoformat(), "type": "open_file", "detail": detail})
                    emit("status", active=True, message="Fichier ouvert : vérification visuelle en cours…")
                    time.sleep(1.0)
                    continue
                if action == "open_app" and switch_sequence:
                    switch_index += 1
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


if __name__ == "__main__":
    main()

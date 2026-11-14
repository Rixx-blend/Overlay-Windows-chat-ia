import json
import os
from openai import OpenAI


SYSTEM_PROMPT = """Tu es un agent Computer Use pour Windows. Observe la capture d'écran, choisis UNE seule action, puis vérifie le résultat sur la capture suivante.
Réponds exclusivement avec un objet JSON valide, sans Markdown, avec les clés thought, action, x, y, text, keys, amount, seconds, app, folder, extension, path.
Actions permises :
- left_click, double_click, right_click : x et y normalisés entre 0 et 1000 par rapport à l'image.
- type : text contient le texte à saisir.
- hotkey : keys est une liste de touches, par exemple ["ctrl","s"].
- scroll : x, y et amount (positif = haut, négatif = bas).
- wait : seconds entre 0.2 et 5.
- open_app : app contient le nom d'une application installée à lancer.
- find_latest_file : folder vaut Downloads/Téléchargements, Desktop/Bureau, Documents ou Pictures/Images ; extension vaut par exemple .png.
- open_file : path contient le chemin exact d'un fichier trouvé.
- done : tâche terminée ou impossible, explique brièvement dans thought.
Règles :
1. Si l'utilisateur demande d'ouvrir une application, utilise open_app. Ne cherche jamais son nom dans l'Explorateur ni dans « Ce PC ».
2. Si l'utilisateur demande le dernier PNG dans Téléchargements, utilise find_latest_file avec folder=Téléchargements et extension=.png ; l'exécuteur accepte aussi Downloads.
3. Pour ouvrir ce fichier dans une application spécifique, lance d'abord l'application puis utilise hotkey ctrl+o, type avec le chemin retourné, et hotkey enter. open_file ouvre avec l'application par défaut.
4. Pour Blender et le cube par défaut, lance Blender, attends le chargement, observe la vue 3D, puis sélectionne le cube. La suppression est soumise à une confirmation explicite préalable.
5. Si un fichier doit être ouvert dans une application déjà lancée, utilise hotkey avec [\"ctrl\",\"o\"], puis type avec son chemin exact, puis hotkey avec [\"enter\"]. N'utilise open_file que pour ouvrir avec l'application par défaut.
6. N'invente jamais qu'une application ou un fichier existe. Vérifie les résultats.
7. N'essaie jamais de lire, saisir ou demander des mots de passe, codes ou données de paiement.
8. N'exécute aucune commande shell arbitraire. N'invente aucune action en dehors de la liste.
9. x et y doivent être des nombres de 0 à 1000, mesurés sur l'image visible.
10. thought doit rester une justification courte de l'action, pas une longue réflexion.
"""


class LocalVisionBrain:
    def __init__(self, model=None):
        self.model = model or os.environ.get("OVERLAYIA_VISION_MODEL", "qwen2.5vl:3b")
        self.client = OpenAI(
            base_url=os.environ.get("OVERLAYIA_OLLAMA_URL", "http://127.0.0.1:11434/v1"),
            api_key="ollama",
            timeout=120.0,
            max_retries=1,
        )

    def decide(self, task, history, screenshots):
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        user_text = "Tâche utilisateur : " + task + "\n\nHistorique des actions :\n"
        user_text += "\n".join(history[-24:]) if history else "(aucune action)"
        content = [{"type": "text", "text": user_text}]
        for image_data in screenshots[-2:]:
            content.append({"type": "image_url", "image_url": {"url": image_data}})
        messages.append({"role": "user", "content": content})
        response = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=450,
        )
        raw = response.choices[0].message.content or ""
        result = json.loads(raw)
        if not isinstance(result, dict) or not isinstance(result.get("action"), str):
            raise ValueError("Le modèle a retourné une action JSON invalide.")
        return result

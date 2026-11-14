# Overlay Windows chat IA

Overlay de chat IA en verre liquide pour Windows. Sans cadre, toujours au premier plan. La barre s'agrandit en carte quand vous écrivez.

## Installer

Téléchargez `OverlayIA-Setup-<version>.exe` dans la page **Releases** du dépôt et lancez-le.
L'installateur n'est pas signé : Windows SmartScreen affichera un avertissement (« Informations complémentaires » puis « Exécuter quand même »).

À chaque démarrage, l'application vérifie les deux modèles locaux : **qwen2.5vl:3b** (Ollama, chat et analyse d'images) et **SDXL 1.0** (ComfyUI, génération d'images). Si l'un manque, une fenêtre de préparation propose son téléchargement avec une progression. Le checkpoint SDXL pèse environ **6,94 Go** et doit être enregistré dans `ComfyUI/models/checkpoints`. ComfyUI reste un moteur séparé qui doit être installé et démarré pour générer des images.

## Mises à jour automatiques

Chaque push sur `main` déclenche le workflow **Release** : il incrémente la version, construit l'installateur et le publie dans les Releases GitHub. L'application vérifie les nouvelles versions au démarrage puis toutes les 6 heures, les télécharge, et propose de redémarrer pour les installer. Désactivable dans les paramètres.

## Paramètres (icône engrenage)

- **Moteur de chat** : OpenAI (`gpt-4o-mini`, `gpt-4o`) ou IA locale (`qwen2.5vl:3b`).
- **Niveau de réflexion** : Bas (réponses courtes), Haut (détaillées), Max (analyse approfondie). Pour les modèles de raisonnement OpenAI, il règle aussi `reasoning_effort`.
- **Actions sur le PC** : si activé, l'IA peut proposer une commande PowerShell. Rien n'est exécuté sans votre clic sur **Exécuter**.

## Génération d'images locale (Stable Diffusion XL 1.0)

L'onglet image de l'overlay utilise **ComfyUI en local** sur `http://127.0.0.1:8188`. Aucun prompt ni aucune image n'est envoyé à un service de génération distant.

Prérequis :
1. Installer ComfyUI pour Windows et le démarrer avec son serveur local actif.
2. Télécharger le checkpoint officiel `sd_xl_base_1.0.safetensors` depuis [Stability AI sur Hugging Face](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) et le placer dans `ComfyUI/models/checkpoints`.
3. Ouvrir l'onglet image dans OverlayIA puis cliquer sur **Actualiser**.

Le générateur propose les prompts positif et négatif, les dimensions 512/768/1024, 20 à 40 étapes, l'aperçu et la sauvegarde automatique dans `Images/OverlayIA`. Le moteur doit rester lancé pendant la génération. Les performances dépendent du GPU et de sa mémoire vidéo.

Téléchargements : [ComfyUI](https://github.com/comfyanonymous/ComfyUI) · [Checkpoint SDXL 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)

## Pièces jointes

Images (analysées par le modèle), fichiers texte (inclus dans la conversation), autres fichiers (nom et type seulement). La dictée vocale utilise Whisper.

## Raccourcis

| Raccourci | Action |
|---|---|
| `Ctrl+Alt+Espace` | Affiche ou masque l'overlay |
| `Ctrl+Alt+L` | Alterne verre live / fond figé |
| `Ctrl+Alt+P` | Capture d'écran du bureau avec l'overlay visible (enregistrée dans Images) |
| `Win+Maj+S` ou `Impr écran` | L'overlay devient visible pendant la capture, puis revient en live |
| `Ctrl+Alt+F` | Affiche le compteur d'images par seconde |
| `Échap` | Ferme les paramètres ou le menu, ou masque le focus du champ |

## Principe

Inspiré de [WPF-Liquid-Glass-Effect](https://github.com/dragosniamtu/WPF-Liquid-Glass-Effect) :

1. Le bureau situé derrière la fenêtre est capturé en continu (flux à 960×540, 20 à 30 images par seconde).
2. Un shader WebGL déforme ce fond : lentille sur les bords, dispersion chromatique, flou, reflets.
3. Le texte est affiché par-dessus.

En mode live, l'overlay est masqué des captures et des partages d'écran, car un verre live ne peut pas se refléter lui-même. Pour qu'il apparaisse dans une capture, utilisez `Ctrl+Alt+L` (fond figé) ou les raccourcis de capture ci-dessus.

## Lancer en développement

```
npm install
set OPENAI_API_KEY=votre_clé
npm start
```

## Notes

- Nécessite Windows 10 (version 2004 ou plus récente) pour exclure la fenêtre de sa propre capture.
- La clé API n'est jamais incluse dans l'installateur : elle est lue depuis la variable d'environnement `OPENAI_API_KEY`.
- Les actions PC passent par PowerShell. L'IA locale de petite taille peut se tromper dans les commandes : relisez-les avant de les exécuter.

# Overlay Windows chat IA

Overlay de chat IA en verre liquide pour Windows. Sans cadre, toujours au premier plan. La barre s'agrandit en carte quand vous écrivez.

## Installer

Téléchargez `OverlayIA-Setup-<version>.exe` dans la page **Releases** du dépôt et lancez-le.
L'installateur n'est pas signé : Windows SmartScreen affichera un avertissement (« Informations complémentaires » puis « Exécuter quand même »).

À la première ouverture, l'application installe automatiquement **Ollama** et le modèle **qwen2.5vl:3b** (IA locale, avec analyse d'images). Vous pouvez relancer cette installation depuis les paramètres.

## Mises à jour automatiques

Chaque push sur `main` déclenche le workflow **Release** : il incrémente la version, construit l'installateur et le publie dans les Releases GitHub. L'application vérifie les nouvelles versions au démarrage puis toutes les 6 heures, les télécharge, et propose de redémarrer pour les installer. Désactivable dans les paramètres.

## Paramètres (icône engrenage)

- **Moteur de chat** : OpenAI (`gpt-4o-mini`, `gpt-4o`) ou IA locale (`qwen2.5vl:3b`).
- **Niveau de réflexion** : Bas (réponses courtes), Haut (détaillées), Max (analyse approfondie). Pour les modèles de raisonnement OpenAI, il règle aussi `reasoning_effort`.
- **Actions sur le PC** : si activé, l'IA peut proposer une commande PowerShell. Rien n'est exécuté sans votre clic sur **Exécuter**.

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

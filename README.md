# Overlay Windows chat IA

Overlay de chat IA en verre liquide pour Windows. Sans cadre, toujours au premier plan. La barre s'agrandit en carte quand vous écrivez.

## Principe

Inspiré de [WPF-Liquid-Glass-Effect](https://github.com/dragosniamtu/WPF-Liquid-Glass-Effect) :

1. Le bureau situé derrière la fenêtre est capturé (la fenêtre elle-même est exclue de la capture).
2. Un shader WebGL déforme ce fond : lentille sur les bords, dispersion chromatique, flou, reflets.
3. Le texte est affiché par-dessus.

## Lancer en développement

```
npm install
set OPENAI_API_KEY=votre_clé
npm start
```

Raccourci global : `Ctrl+Alt+Espace` affiche ou masque l'overlay. `Échap` le masque quand le champ a le focus.

## Télécharger le .exe

Le `.exe` est construit par GitHub Actions à chaque push : onglet **Actions**, dernier run « Build EXE », puis artefact **OverlayIA**.

## Notes

- La capture du bureau est rafraîchie toutes les 800 ms et à chaque déplacement. Le fond animé derrière la fenêtre peut donc avoir un léger retard.
- Nécessite Windows 10 (version 2004 ou plus récente) pour exclure la fenêtre de sa propre capture.
- La clé API n'est jamais incluse dans le `.exe` : elle est lue depuis la variable d'environnement `OPENAI_API_KEY`.

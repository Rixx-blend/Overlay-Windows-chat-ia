# Overlay Windows chat IA

Overlay de chat IA en verre liquide pour Windows, sans cadre et toujours au premier plan. La barre s'agrandit en carte quand vous écrivez.

## Lancer en développement

```
npm install
set OPENAI_API_KEY=votre_clé
npm start
```

Raccourci global : `Ctrl+Alt+Espace` affiche ou masque l'overlay. `Échap` le masque quand le champ a le focus.

## Télécharger le .exe

Le `.exe` est construit par GitHub Actions à chaque push. Onglet **Actions**, dernier run « Build EXE », puis téléchargez l'artefact **OverlayIA**.

## Notes

- Le flou du bureau (acrylique natif) demande Windows 11. Sur Windows 10, l'overlay reste fonctionnel avec un verre simulé, sans flou réel du fond.
- La clé API n'est jamais incluse dans le `.exe` : elle est lue depuis la variable d'environnement `OPENAI_API_KEY`.

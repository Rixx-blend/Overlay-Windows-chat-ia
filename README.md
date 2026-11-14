# Overlay Windows chat IA

Overlay sans cadre, toujours au premier plan, avec effet verre Windows. La barre s'agrandit au focus, puis en carte quand vous écrivez.

## Lancer le script

```
pip install PySide6 requests keyboard
set OPENAI_API_KEY=votre_clé
python overlay_ia.py
```

Raccourci global : `Ctrl+Alt+Espace` affiche ou masque l'overlay. `Échap` le masque quand le champ a le focus.

## Télécharger le .exe

Le `.exe` est construit automatiquement par GitHub Actions à chaque push. Allez dans l'onglet **Actions**, ouvrez le dernier run « Build EXE » et téléchargez l'artefact **OverlayIA**.

La clé API n'est jamais incluse dans le `.exe` : elle est lue depuis la variable d'environnement `OPENAI_API_KEY`.

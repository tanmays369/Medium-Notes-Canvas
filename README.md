# Medium Notes Canvas

Firefox extension for Medium and Towards Data Science articles. It extracts article text, generates thorough Markdown study notes, lets the user edit the notebook, and saves notes only when `Save Notes` is clicked.

## Features

- Works on `medium.com`, `*.medium.com`, `towardsdatascience.com`, and `*.towardsdatascience.com` pages.
- Extracts title, author, date, excerpt, URL, and article text from the current article.
- Provides generation controls for focus question, note depth, and manual highlights.
- Runs note generation in the background so reopening the popup can reconnect to the current article's in-progress or completed unsaved result.
- Keeps notes editable before saving.
- Saves notes manually per canonical article URL only after the user clicks `Save Notes`.
- Shows a saved-notes list inside the popup.
- Shows LLM logs with prompt, response or error, status, model, and timestamps.
- Uses a flat project structure.

## Install In Firefox

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on...`.
3. Select `manifest.json` from this `assignmen3_canvas` folder.
4. Open a Medium or Towards Data Science article and click the extension icon.

## Files

```text
manifest.json
background.js
content.js
popup.html
popup.css
popup.js
README.md
```

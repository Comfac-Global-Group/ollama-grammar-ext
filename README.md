# Ollama Grammar Check

A Chrome extension that runs grammar and spelling correction through your local [Ollama](https://ollama.ai) instance. No cloud, no subscriptions, no data leaving your machine.

Select text on any webpage → right-click → **✦ Check with Ollama** → review corrections in a side panel with a full diff breakdown.

---

## Features

- **Right-click trigger** on any selected text across any webpage
- **Side panel UI** with corrected text, change summary, and a diff table showing every edit with its reason
- **Editable prompt** — default is "Fix grammar and spelling" but you can type any instruction before running
- **Local-only** — all inference runs on your Ollama instance, nothing sent to external servers
- **Model dropdown** — Settings auto-loads all models available in your Ollama instance; pick any one without typing
- **Run statistics** — each result shows the model alias used, the underlying base model, tokens generated, tokens/sec, and total inference time
- **Configurable** — set your Ollama URL, model, and default prompt via the Settings panel
- **Dedicated Modelfile** — optimized `llama3.2:3b` configuration tuned for conservative, voice-preserving corrections

---

## Requirements

- Chrome 114+ (Side Panel API)
- [Ollama](https://ollama.ai) installed and running locally
- `llama3.2:3b` pulled: `ollama pull llama3.2:3b`

---

## Installation

### 1. Pull the base model

```bash
ollama pull llama3.2:3b
```

### 2. Create the grammar model

From inside the repo folder:

```bash
ollama create grammar-check -f Modelfile
```

Verify it works:

```bash
ollama run grammar-check
```

### 3. Enable CORS for browser access

Ollama blocks cross-origin requests by default. You need to allow the Chrome extension to reach it.

**One-time for a terminal session:**
```bash
OLLAMA_ORIGINS="*" ollama serve
```

**Permanently (recommended) — add to your shell profile (`~/.bashrc` or `~/.zshrc`):**
```bash
export OLLAMA_ORIGINS="*"
```

**If running Ollama as a systemd service:**
```bash
sudo systemctl edit ollama
```
Add:
```ini
[Service]
Environment="OLLAMA_ORIGINS=*"
```
Then `sudo systemctl restart ollama`.

### 4. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select this repo folder

The extension icon will appear in your toolbar. The context menu item is added automatically.

---

## Updating the Extension After Code Changes

When you pull new changes or edit the extension files locally, Chrome does not reload them automatically.

**To apply updates:**

1. Go to `chrome://extensions`
2. Find **Ollama Grammar Check**
3. Click the **↺ refresh icon** (circular arrow) on the extension card

If the side panel is already open, close it and reopen it — the panel itself also needs to reload to pick up JS changes.

> **Tip:** If you don't see the refresh icon, make sure **Developer mode** is toggled on (top-right of the extensions page).

---

## Usage

1. Select any text on a webpage
2. Right-click → **✦ Check with Ollama**
3. The side panel opens showing your selected text
4. Optionally edit the prompt (e.g. "Make this more formal")
5. Click **Run**
6. Review:
   - **Corrected Text** — the full corrected output with a Copy button
   - **Run stats** — model alias, base model, tokens generated, speed, and total time
   - **Summary** — one-sentence description of what changed
   - **Changes table** — every edit: original phrase → fixed phrase → reason
7. Copy the corrected text and paste it wherever you need it

---

## Custom Prompts

The prompt field accepts any plain-English instruction. Examples:

| Prompt | Effect |
|---|---|
| `Fix grammar and spelling` | Default — minimal corrections only |
| `Make this more formal` | Elevates register and tone |
| `Simplify for a general audience` | Reduces jargon and complexity |
| `Convert to active voice` | Restructures passive constructions |
| `Fix for Philippine English conventions` | Adapts idiom and spelling variants |
| `Tighten this — remove redundant words` | Conciseness pass |

---

## Settings

Click **⚙ Settings** in the side panel header.

| Setting | Default | Description |
|---|---|---|
| Ollama URL | `http://localhost:11434` | Your Ollama server address |
| Model | `grammar-check` | Dropdown of all models currently in your Ollama instance |
| Default Prompt | `Fix grammar and spelling` | Pre-filled text in the prompt field |

The model dropdown auto-loads when you open Settings. Use the **↻** button to refresh the list after pulling a new model. Settings persist across browser sessions via `chrome.storage.sync`.

---

## Run Statistics

After each correction, a stats bar appears below the corrected text:

| Field | Description |
|---|---|
| `model` | The model alias that was called (e.g. `grammar-check`) |
| `base` | The underlying model it was built from (e.g. `llama3.2:3b`) |
| `tokens` | Output tokens generated and speed in tokens/sec |
| `prompt` | Tokens consumed by the input prompt |
| `time` | Total wall-clock time for the request in seconds |

---

## File Structure

```
ollama-grammar-ext/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — context menu, messaging, API calls
├── Modelfile              # Ollama model definition (llama3.2:3b base)
├── sidepanel/
│   ├── sidepanel.html     # Side panel UI and styles
│   └── sidepanel.js       # Side panel logic and state
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
└── how-this-works.md
```

---

## Troubleshooting

**"Error connecting to Ollama"**
- Is Ollama running? Run `ollama serve` or check `systemctl status ollama`
- Is `OLLAMA_ORIGINS="*"` set? (See Step 3 above)
- Is the model created? Run `ollama list` and confirm `grammar-check` appears

**Model dropdown is empty or shows an error**
- Check that Ollama is running and your URL in Settings is correct
- Click **↻** to retry after Ollama starts
- Run `ollama list` in terminal to confirm at least one model exists

**Side panel doesn't open**
- Chrome must be version 114 or later
- Try disabling and re-enabling the extension at `chrome://extensions`
- Check the service worker console: `chrome://extensions` → Details → "Inspect views: service worker"

**JSON parse errors / garbled output**
- The model may be producing non-JSON output. Run `ollama run grammar-check` in terminal and test manually
- Try recreating the model: `ollama rm grammar-check` then `ollama create grammar-check -f Modelfile`

**Context menu item missing**
- Reload the extension at `chrome://extensions`
- The item only appears when text is selected — right-click on highlighted text

---

## Roadmap / Contribution Ideas

- [ ] Streaming response support for long texts
- [ ] History panel — keep last N corrections in the session
- [ ] Keyboard shortcut to trigger without right-click
- [ ] Auto-replace mode (replace selected text directly without copy-paste)
- [ ] Export corrections as Markdown or CSV
- [ ] Per-site prompt presets

---

## License

MIT. Do what you want with it.

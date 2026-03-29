# How This Works

A technical walkthrough of the extension's architecture, data flow, and design decisions. Written as a reference for contributors and for Claude Code optimization sessions.

---

## Architecture Overview

This is a Chrome Manifest V3 extension with three execution contexts that communicate via message passing:

```
[ Webpage ]
     │  user selects text + right-clicks
     ▼
[ Background Service Worker ]  (background.js)
     │  captures selection, opens side panel,
     │  makes the Ollama API calls
     ▼
[ Side Panel ]  (sidepanel.html + sidepanel.js)
     │  renders UI, manages state,
     │  displays results and run statistics
     ▼
[ Ollama HTTP API ]  (localhost:11434)
     │  runs selected model (e.g. grammar-check → llama3.2:3b)
     └─ returns structured JSON + inference statistics
```

The background service worker is the hub. It holds all Ollama API logic because service workers have unrestricted `fetch()` access — side panels inherit the extension's CSP but can have connectivity issues in some Chrome versions, so keeping all API calls in the background is safer and more consistent.

---

## File-by-File Breakdown

### `manifest.json`

Declares the extension using **Manifest V3** (MV3), which replaced V2 in Chrome 88+ and became required in 2024. Key differences from V2 that affect this codebase:

- Background scripts are now **service workers** — they don't persist, they spin up on demand and go idle. No long-running background processes.
- `host_permissions` is separate from `permissions` — the `http://localhost:11434/*` entry is what allows fetch calls to Ollama.
- `side_panel` key registers the side panel with its default HTML path.

Permissions used:
- `contextMenus` — to register the right-click menu item
- `sidePanel` — to open and control the Chrome Side Panel
- `storage` — for `chrome.storage.sync` (persists settings across devices if logged in to Chrome)
- `activeTab` — to open the side panel scoped to the current tab
- `scripting` — declared for future use (auto-replace feature would need this)

### `background.js`

The service worker. Four responsibilities:

**1. Extension initialization (`onInstalled`)**

Runs once when the extension is installed or updated. Creates the context menu item scoped to `"selection"` context (only appears when text is highlighted). Also seeds default settings into `chrome.storage.sync` if they haven't been set yet — this is a guard so settings always have valid fallbacks.

```js
chrome.contextMenus.create({
  id: "ollama-grammar",
  title: "✦ Check with Ollama",
  contexts: ["selection"]
});
```

**2. Context menu click handler (`contextMenus.onClicked`)**

When the user clicks the menu item:
1. Captures `info.selectionText` — Chrome passes the selected text through this event
2. Calls `chrome.sidePanel.open({ tabId })` — opens the panel scoped to the current tab
3. Waits 400ms then sends a `SELECTED_TEXT` message to the side panel

The 400ms delay is a **known workaround**: the side panel's JS listener isn't guaranteed to be ready immediately after `sidePanel.open()` resolves. If the message arrives before the listener is registered, it's silently dropped. See Known Issues for a cleaner fix.

**3. `GET_MODELS` handler**

The side panel sends this message (with the configured `ollamaUrl`) when the Settings panel opens or the user clicks the refresh button. The background calls `GET /api/tags`, extracts model names from the response, and returns the list. The side panel uses this to populate the model dropdown.

**4. Message listener — Ollama API proxy (`RUN_GRAMMAR_CHECK`)**

The side panel delegates the actual API call to the background worker. The side panel sends `RUN_GRAMMAR_CHECK` with the text, prompt, and settings. The background calls `runGrammarCheck()` and returns the result including stats.

The `return true` at the end of each message listener branch is **critical** — it keeps the message channel open for the async response. Without it, the channel closes before the fetch resolves and the response is never received.

**`runGrammarCheck()` — the Ollama call**

Calls `POST /api/chat` (the chat completions endpoint). Uses a two-part prompt:

- **System prompt** (baked in here, not from the Modelfile): Instructs the model to return only a JSON object in a specific schema. This is intentional — the system prompt in the Modelfile is the behavioral baseline, but the JSON schema instruction lives in the code so it can be modified without recreating the model.
- **User message**: Wraps the selected text with the user's prompt instruction.

The response schema:
```json
{
  "corrected": "the full corrected text",
  "changes": [
    { "original": "...", "fixed": "...", "reason": "..." }
  ],
  "summary": "one-sentence description of changes"
}
```

After the fetch, the response body is cleaned of any stray markdown fences (```` ```json ```` etc.) before `JSON.parse()`. Small models sometimes wrap their output in fences even when instructed not to.

**Run statistics extraction**

The Ollama `/api/chat` response with `stream: false` includes inference metadata alongside the message content:

```json
{
  "eval_count": 298,
  "eval_duration": 4799921000,
  "prompt_eval_count": 26,
  "prompt_eval_duration": 130079000,
  "total_duration": 5191566416
}
```

All durations are in nanoseconds. `background.js` extracts these and computes `tokensPerSec = eval_count / (eval_duration / 1e9)`. These are attached to the result as a `_meta` object and rendered by the side panel.

**`fetchBaseModel()` — resolving the underlying model**

When using a custom model (e.g. `grammar-check` built from `llama3.2:3b`), the user-facing model name is an alias. To show the actual model being run, `background.js` calls `POST /api/show` with the model name after the grammar check completes.

The `/api/show` response includes a `details` object with a `parent_model` field. If that's empty (e.g. the model is a base model, not a derived one), the code falls back to parsing the `FROM` line out of the `modelfile` string in the response. This handles both native Ollama models and custom Modelfile-derived ones.

```js
const fromLine = (data.modelfile || '').split('\n')
  .find(l => l.trim().toUpperCase().startsWith('FROM'));
return fromLine ? fromLine.replace(/^FROM\s+/i, '').trim() : null;
```

### `sidepanel/sidepanel.html`

The side panel UI. All CSS is inline in a `<style>` block — no external stylesheets, which keeps the extension self-contained and avoids CSP issues.

**Design system**: Uses CSS custom properties (`--bg`, `--accent`, `--del`, `--add`, etc.) for theming. The palette is dark terminal-style: near-black background, green accent (`#7fff7f`), red for deletions, green for additions. IBM Plex Mono + IBM Plex Sans loaded from Google Fonts (requires internet on first load; fonts cache after that).

**UI states** (rendered by injecting into `#mainContent`):
1. **Idle** — shown on load, no text selected yet
2. **Preview** — selected text displayed, Run button enabled
3. **Loading** — spinner while waiting for Ollama
4. **Results** — corrected text + run stats + summary + diff table
5. **Error** — shown if fetch fails or JSON parse fails

All state transitions happen by replacing `innerHTML` on `#mainContent`. This is simple but has a trade-off: event listeners attached to dynamically created elements (like the Copy button) must be re-attached after each render. The current code does this inline after each `innerHTML` assignment.

**Model select**: The Settings panel contains a `<select>` element for model choice rather than a free-text input. A `↻` refresh button next to it triggers a fresh `GET_MODELS` call. The select is populated dynamically — it starts empty and is filled when Settings opens or when the user clicks refresh.

**Settings panel**: An absolutely-positioned overlay that slides over the main panel when `open` class is added. Keeps settings out of the main flow without needing a routing system.

### `sidepanel/sidepanel.js`

Manages state and UI transitions for the panel.

**State**: Two module-level variables:
- `currentText` — the selected text passed from background
- `settings` — the active configuration object

**Init**: On load, reads from `chrome.storage.sync` and populates the `settings` object, the URL input, and the prompt input. The model select is intentionally not set here — it requires a `GET_MODELS` round-trip that only happens when Settings opens.

**Message listener**: Listens for `SELECTED_TEXT` from the background, stores it in `currentText`, triggers `showSelectedPreview()`, and enables the Run button.

**Run flow**:
1. Read prompt from input (fall back to `settings.defaultPrompt` if empty)
2. Call `showLoading()` — replaces content, disables Run button
3. Send `RUN_GRAMMAR_CHECK` to background via `chrome.runtime.sendMessage`
4. On response: call `showResults()` or `showError()`

**`loadModelList()`**: Called when Settings opens and when the refresh button is clicked. Sends `GET_MODELS` to the background, then rebuilds the `<select>` options. Restores the currently saved model as the selected value if it's still in the list; otherwise defaults to the first model returned.

**`buildMetaHtml()`**: Renders the stats bar below the corrected text box. Only renders fields that are present — if Ollama doesn't return stats (e.g. older version), the bar is omitted entirely. The `base` field is only shown if it differs from the model alias (i.e. the selected model is a derived model, not a base one).

**`escapeHtml()`**: All user-provided text and model output is escaped before being injected into innerHTML. This prevents XSS if the model produces HTML-like output or if the selected text contains markup. The `String(text)` cast guards against non-string values in the `_meta` fields.

### `Modelfile`

Defines the `grammar-check` model as a layer on top of `llama3.2:3b`.

**Parameter choices and rationale:**

| Parameter | Value | Reason |
|---|---|---|
| `temperature` | `0.1` | Near-deterministic. Grammar correction has right answers — creativity is unwanted. |
| `top_p` | `0.85` | Nucleus sampling. Cuts off the long tail of improbable tokens. |
| `top_k` | `20` | Only considers top 20 tokens at each step. Keeps output tight. |
| `repeat_penalty` | `1.1` | Mild penalty against repeating phrases — prevents the model from echoing the input verbatim as a "correction." |
| `num_predict` | `2048` | Max output tokens. JSON output for a few paragraphs of text is well within this. |
| `num_ctx` | `4096` | Context window. Handles the system prompt + ~1500 words of input text comfortably. |

The **system prompt in the Modelfile** establishes behavioral defaults: preserve voice, don't add content, maintain formality level. The JSON schema enforcement lives in `background.js` instead (see above) so the model behavior and output format can be tuned independently.

---

## Data Flow: End-to-End

```
1.  User selects text on any webpage
2.  User right-clicks → Chrome triggers contextMenus.onClicked in background.js
3.  background.js captures selectionText from the event info object
4.  background.js calls chrome.sidePanel.open() → Chrome opens the side panel
5.  background.js waits 400ms, then sends SELECTED_TEXT message
6.  sidepanel.js receives SELECTED_TEXT → stores text, renders preview, enables Run
7.  User opens Settings → sidepanel.js sends GET_MODELS to background.js
8.  background.js calls GET /api/tags → returns model list → dropdown is populated
9.  User selects a model, saves settings, optionally edits prompt, clicks Run
10. sidepanel.js sends RUN_GRAMMAR_CHECK to background.js with {text, prompt, settings}
11. background.js calls POST http://localhost:11434/api/chat
12. Ollama runs inference on selected model
13. background.js receives response, strips markdown fences, parses JSON
14. background.js calls POST /api/show to resolve the underlying base model name
15. background.js extracts eval_count, eval_duration, total_duration from response
16. background.js sends {success: true, result} back to sidepanel.js
    result includes: corrected text, changes[], summary, _meta (model, base, stats)
17. sidepanel.js renders corrected text + run stats bar + diff table
18. User clicks Copy, pastes corrected text wherever needed
```

---

## Known Issues and Optimization Targets

These are the rough edges identified — good candidates for Claude Code sessions:

**1. The 400ms timing hack (background.js)**
The delay before sending `SELECTED_TEXT` is a race condition workaround. A cleaner solution: have the side panel send a `PANEL_READY` message to the background on init, and have the background queue the text until it receives that signal. This eliminates the race entirely.

**2. `innerHTML` mutation for all state transitions (sidepanel.js)**
Replacing the entire `#mainContent` innerHTML on every state change is simple but causes re-attachment of event listeners and full DOM reconstruction. A proper approach would use a lightweight state machine with targeted DOM updates, or switch to a minimal reactive framework like Preact.

**3. No streaming support (background.js)**
The Ollama call uses `stream: false`. For longer texts, this means the user waits with a spinner until the full response arrives. Streaming (`stream: true` + reading the response as an NDJSON stream) would let the corrected text appear progressively. Requires refactoring the message passing to support chunked updates.

**4. JSON parse fragility (background.js)**
If the model returns malformed JSON (common with small quantized models under load), the extension throws an unhandled error that surfaces as a generic "Error connecting to Ollama" message. Should add a JSON validation step with a graceful fallback — e.g., return the raw model output if JSON parse fails, with a warning.

**5. Settings sent on every request (sidepanel.js)**
The full settings object is serialized into every `RUN_GRAMMAR_CHECK` message. The background should read from `chrome.storage.sync` directly rather than relying on the side panel to pass settings. This also means settings changes take effect immediately without requiring a panel reload.

**6. No model availability check**
There's no pre-flight check to verify the Ollama server is reachable and the selected model exists before the user tries to run a check. A health check on panel open (`GET /api/tags`) would let the extension warn early with a better error message.

**7. Icons are placeholder circles**
The icons were generated programmatically as green circles. A real SVG-based icon set would be appropriate for a public repo.

---

## Extension Permissions Explained

For anyone auditing the manifest:

- `contextMenus` — required to add the right-click menu item
- `sidePanel` — required to open and use Chrome's native side panel
- `storage` — reads/writes user settings to `chrome.storage.sync`; no sensitive data stored
- `activeTab` — scopes the side panel open call to the active tab; does not grant access to page content
- `scripting` — declared but not currently used; reserved for a future auto-replace feature
- `host_permissions: http://localhost:11434/*` — allows fetch to your local Ollama server only; no external network calls are made

---

## Suggested Claude Code Session Prompts

When working on this repo with Claude Code, these scoped prompts work well:

```
Fix the race condition in background.js where SELECTED_TEXT is sent with a
setTimeout. Implement a PANEL_READY handshake instead.
```

```
Refactor sidepanel.js to use a state machine pattern instead of replacing
innerHTML on every state transition. States: idle, preview, loading, results, error.
```

```
Add streaming support to the Ollama API call in background.js. Use the Ollama
streaming NDJSON format and send progressive updates to the side panel.
```

```
Add a pre-flight health check when the side panel opens: call GET /api/tags on
the configured Ollama URL and verify the selected model exists. Show a
clear setup error if it doesn't.
```

```
Harden the JSON parsing in runGrammarCheck(). If JSON.parse fails, attempt to
extract JSON from the response with a regex, and if that fails too, return the
raw model text with a warning flag instead of throwing.
```

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ollama-grammar",
    title: "✦ Check with Ollama",
    contexts: ["selection"]
  });

  // Set default settings
  chrome.storage.sync.get(['ollamaUrl', 'modelName', 'defaultPrompt'], (result) => {
    if (!result.ollamaUrl) {
      chrome.storage.sync.set({ ollamaUrl: 'http://localhost:11434' });
    }
    if (!result.modelName) {
      chrome.storage.sync.set({ modelName: 'grammar-check' });
    }
    if (!result.defaultPrompt) {
      chrome.storage.sync.set({ defaultPrompt: 'Fix grammar and spelling' });
    }
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "ollama-grammar") {
    const selectedText = info.selectionText;

    // Open side panel
    await chrome.sidePanel.open({ tabId: tab.id });

    // Small delay to let the panel load, then send the text
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SELECTED_TEXT',
        text: selectedText,
        tabId: tab.id
      });
    }, 400);
  }
});

// Listen for API calls from side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_GRAMMAR_CHECK') {
    runGrammarCheck(message.text, message.prompt, message.settings)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async
  }

  if (message.type === 'GET_MODELS') {
    fetchModels(message.ollamaUrl)
      .then(models => sendResponse({ success: true, models }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchModels(ollamaUrl) {
  const response = await fetch(`${ollamaUrl}/api/tags`);
  if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
  const data = await response.json();
  return (data.models || []).map(m => m.name);
}

async function fetchBaseModel(ollamaUrl, modelName) {
  try {
    const response = await fetch(`${ollamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    });
    if (!response.ok) return null;
    const data = await response.json();
    // Try details.parent_model first, then parse FROM line in modelfile
    if (data.details && data.details.parent_model) return data.details.parent_model;
    const fromLine = (data.modelfile || '').split('\n').find(l => l.trim().toUpperCase().startsWith('FROM'));
    return fromLine ? fromLine.replace(/^FROM\s+/i, '').trim() : null;
  } catch {
    return null;
  }
}

function parseModelJson(raw) {
  // Stage 1: strip markdown fences and try directly
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}

  // Stage 2: extract the first {...} block and try again
  const block = cleaned.match(/\{[\s\S]*\}/);
  if (block) {
    try { return JSON.parse(block[0]); } catch {}
  }

  // Stage 3: fix invalid escape sequences (\' \, \. etc.) and retry
  const target = block ? block[0] : cleaned;
  const sanitized = target.replace(/\\([^"\\\/bfnrtu0-9\n])/g, '$1');
  try { return JSON.parse(sanitized); } catch {}

  // Stage 4: character-by-character scan — replace literal newlines/tabs
  // inside JSON string values with their escape equivalents.
  // More reliable than regex for long multi-paragraph strings.
  let relined = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i];
    if (esc) { relined += ch; esc = false; }
    else if (ch === '\\' && inStr) { relined += ch; esc = true; }
    else if (ch === '"') { inStr = !inStr; relined += ch; }
    else if (inStr && ch === '\n') { relined += '\\n'; }
    else if (inStr && ch === '\r') { relined += '\\r'; }
    else if (inStr && ch === '\t') { relined += '\\t'; }
    else { relined += ch; }
  }
  try { return JSON.parse(relined); } catch {}

  // Stage 5: give up — return raw output as the corrected text with a warning
  return {
    corrected: raw,
    changes: [],
    summary: 'Model returned unstructured output — showing raw response.'
  };
}

async function runGrammarCheck(text, prompt, settings) {
  const { ollamaUrl, modelName } = settings;

  const systemPrompt = `You are a grammar and spelling correction assistant.
Correct the text according to the instruction. Preserve the author's voice, paragraph breaks, and formatting.

You MUST respond with ONLY this JSON structure and nothing else:
{"corrected":"...","changes":[{"original":"...","fixed":"...","reason":"..."}],"summary":"..."}

Rules:
- "corrected" contains ONLY the corrected text. Nothing else. No original text. No explanations. No "instead of". No "but". No notes.
- "changes" lists each individual edit made.
- "summary" is one sentence describing what was changed overall.
- If nothing needs changing, copy the text into "corrected" unchanged and use an empty changes array.`;

  const userMessage = `Instruction: ${prompt}

INPUT TEXT (correct this and return as JSON):
${text}`;

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      stream: false,
      options: { num_predict: 8192 }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.message?.content || data.response || '';

  // Parse JSON response with multi-stage fallback
  const parsed = parseModelJson(content);

  // Gather run statistics from the Ollama response
  const evalCount = data.eval_count || 0;
  const evalDuration = data.eval_duration || 0; // nanoseconds
  const promptEvalCount = data.prompt_eval_count || 0;
  const totalDuration = data.total_duration || 0;
  const tokensPerSec = evalDuration > 0
    ? (evalCount / (evalDuration / 1e9)).toFixed(1)
    : null;
  const totalSec = totalDuration > 0
    ? (totalDuration / 1e9).toFixed(1)
    : null;

  // Fetch base model info in parallel-ish (after parse, minimal extra latency)
  const baseModel = await fetchBaseModel(ollamaUrl, modelName);

  parsed._meta = {
    modelName,
    baseModel,
    evalCount,
    promptEvalCount,
    tokensPerSec,
    totalSec
  };

  return parsed;
}

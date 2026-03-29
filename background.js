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

  // Stage 4: replace literal newlines inside strings with \n and retry
  const relined = sanitized.replace(/("(?:[^"\\]|\\.)*")/g, m =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  );
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

  const systemPrompt = `You are a precise grammar and spelling correction assistant.
Your job is to correct text as instructed while preserving the author's voice, style, and intent.
Respond ONLY with a JSON object in this exact format, no markdown, no extra text:
{
  "corrected": "<the fully corrected text>",
  "changes": [
    { "original": "<original phrase>", "fixed": "<corrected phrase>", "reason": "<brief reason>" }
  ],
  "summary": "<one sentence summary of changes made>"
}
If no changes are needed, return an empty changes array and say so in the summary.`;

  const userMessage = `Instruction: ${prompt}

Text to process:
"""
${text}
"""`;

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      stream: false
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

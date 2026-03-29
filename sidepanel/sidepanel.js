let currentText = '';
let settings = {
  ollamaUrl: 'http://localhost:11434',
  modelName: 'grammar-check',
  defaultPrompt: 'Fix grammar and spelling'
};

// Load settings on init
chrome.storage.sync.get(['ollamaUrl', 'modelName', 'defaultPrompt'], (result) => {
  if (result.ollamaUrl) settings.ollamaUrl = result.ollamaUrl;
  if (result.modelName) settings.modelName = result.modelName;
  if (result.defaultPrompt) settings.defaultPrompt = result.defaultPrompt;

  document.getElementById('promptInput').placeholder = settings.defaultPrompt;

  // Populate settings form fields (URL and prompt only; model select populated on panel open)
  document.getElementById('ollamaUrl').value = settings.ollamaUrl;
  document.getElementById('defaultPrompt').value = settings.defaultPrompt;
});

// Listen for selected text from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SELECTED_TEXT') {
    currentText = message.text;
    showSelectedPreview(currentText);
    document.getElementById('runBtn').disabled = false;
  }
});

function showSelectedPreview(text) {
  const content = document.getElementById('mainContent');
  content.innerHTML = `
    <div class="selected-preview">
      <div class="section-label">Selected Text</div>
      <div class="preview-text">${escapeHtml(text)}</div>
    </div>
    <div class="idle-state" style="flex:1;">
      <div class="idle-icon" style="font-size:20px; opacity:0.3;">↑</div>
      <p>Click Run to check with Ollama</p>
    </div>
  `;
}

// Run button
document.getElementById('runBtn').addEventListener('click', async () => {
  if (!currentText) return;

  const promptInput = document.getElementById('promptInput');
  const prompt = promptInput.value.trim() || settings.defaultPrompt;

  showLoading();

  chrome.runtime.sendMessage({
    type: 'RUN_GRAMMAR_CHECK',
    text: currentText,
    prompt: prompt,
    settings: settings
  }, (response) => {
    if (response.success) {
      showResults(response.result, currentText);
    } else {
      showError(response.error);
    }
  });
});

function showLoading() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Running model...</p>
    </div>
  `;
  document.getElementById('runBtn').disabled = true;
}

function showResults(result, originalText) {
  const content = document.getElementById('mainContent');
  document.getElementById('runBtn').disabled = false;

  const changesHtml = result.changes && result.changes.length > 0
    ? `<table class="diff-table">
        <tr>
          <th>Original</th>
          <th>Fixed</th>
          <th>Reason</th>
        </tr>
        ${result.changes.map(c => `
          <tr>
            <td class="td-original">${escapeHtml(c.original)}</td>
            <td class="td-fixed">${escapeHtml(c.fixed)}</td>
            <td class="td-reason">${escapeHtml(c.reason)}</td>
          </tr>
        `).join('')}
      </table>`
    : `<div class="no-changes">✓ No changes needed</div>`;

  const meta = result._meta || {};
  const metaHtml = buildMetaHtml(meta);

  content.innerHTML = `
    <div class="results">
      <div class="result-section">
        <div class="section-label">Corrected Text</div>
        <div class="corrected-box" id="correctedText">${escapeHtml((result.corrected || originalText).replace(/\\n/g, '\n'))}</div>
        <button class="copy-btn" id="copyBtn">Copy Corrected Text</button>
        ${metaHtml}
      </div>

      <div class="result-section">
        <div class="section-label">Summary</div>
        <div class="summary-box">${escapeHtml(result.summary || 'No summary available.')}</div>
      </div>

      <div class="result-section">
        <div class="section-label">Changes (${result.changes ? result.changes.length : 0})</div>
        ${changesHtml}
      </div>
    </div>
  `;

  document.getElementById('copyBtn').addEventListener('click', () => {
    const text = (result.corrected || originalText).replace(/\\n/g, '\n');
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copyBtn');
      btn.textContent = '✓ Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy Corrected Text';
        btn.classList.remove('copied');
      }, 2000);
    });
  });
}

function buildMetaHtml(meta) {
  if (!meta.modelName && !meta.evalCount) return '';

  const parts = [];

  if (meta.modelName) {
    parts.push(`<span class="meta-item"><span class="meta-label">model</span><span class="meta-value">${escapeHtml(meta.modelName)}</span></span>`);
  }

  if (meta.baseModel && meta.baseModel !== meta.modelName) {
    parts.push(`<span class="meta-item"><span class="meta-label">base</span><span class="meta-value base-model">${escapeHtml(meta.baseModel)}</span></span>`);
  }

  if (meta.evalCount) {
    const tokenStr = meta.tokensPerSec
      ? `${meta.evalCount} @ ${meta.tokensPerSec} tok/s`
      : `${meta.evalCount}`;
    parts.push(`<span class="meta-item"><span class="meta-label">tokens</span><span class="meta-value">${tokenStr}</span></span>`);
  }

  if (meta.promptEvalCount) {
    parts.push(`<span class="meta-item"><span class="meta-label">prompt</span><span class="meta-value">${meta.promptEvalCount} tok</span></span>`);
  }

  if (meta.totalSec) {
    parts.push(`<span class="meta-item"><span class="meta-label">time</span><span class="meta-value">${meta.totalSec}s</span></span>`);
  }

  if (parts.length === 0) return '';
  return `<div class="run-meta">${parts.join('')}</div>`;
}

function showError(errorMsg) {
  const content = document.getElementById('mainContent');
  document.getElementById('runBtn').disabled = false;

  content.innerHTML = `
    <div class="error-box">
      <strong>Error connecting to Ollama</strong><br><br>
      ${escapeHtml(errorMsg)}<br><br>
      Make sure Ollama is running and the model exists.<br>
      Check Settings for your URL and model name.
    </div>
  `;
}

// ── Settings panel ───────────────────────────────────────────────────────────

document.getElementById('openSettings').addEventListener('click', () => {
  document.getElementById('settingsPanel').classList.add('open');
  loadModelList();
});

document.getElementById('closeSettings').addEventListener('click', () => {
  document.getElementById('settingsPanel').classList.remove('open');
});

document.getElementById('refreshModels').addEventListener('click', () => {
  loadModelList();
});

document.getElementById('saveSettings').addEventListener('click', () => {
  const newSettings = {
    ollamaUrl: document.getElementById('ollamaUrl').value.trim() || 'http://localhost:11434',
    modelName: document.getElementById('modelName').value || settings.modelName,
    defaultPrompt: document.getElementById('defaultPrompt').value.trim() || 'Fix grammar and spelling'
  };

  chrome.storage.sync.set(newSettings, () => {
    settings = newSettings;
    document.getElementById('promptInput').placeholder = settings.defaultPrompt;
    document.getElementById('settingsPanel').classList.remove('open');
  });
});

function loadModelList() {
  const select = document.getElementById('modelName');
  const hint = document.getElementById('modelHint');
  const refreshBtn = document.getElementById('refreshModels');
  const url = document.getElementById('ollamaUrl').value.trim() || settings.ollamaUrl;

  refreshBtn.classList.add('spinning');
  hint.textContent = 'Loading models…';

  chrome.runtime.sendMessage({ type: 'GET_MODELS', ollamaUrl: url }, (response) => {
    refreshBtn.classList.remove('spinning');

    if (!response || !response.success) {
      hint.textContent = 'Could not reach Ollama — check your URL above.';
      return;
    }

    const models = response.models;
    if (models.length === 0) {
      hint.textContent = 'No models found. Run: ollama pull llama3.2:3b';
      return;
    }

    // Rebuild options
    select.innerHTML = '';
    models.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });

    // Select the currently saved model, or first in list
    const saved = settings.modelName;
    select.value = models.includes(saved) ? saved : models[0];

    hint.textContent = `${models.length} model${models.length !== 1 ? 's' : ''} available.`;
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Electron main process — Nano Banana Pro Studio.
// Hosts the window, builds the genai client, and mediates IPC for generation.
// Config and contents are built renderer-side in SDK shape; this process is a
// thin pass-through with auth, error mapping, and stream cancel.

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { app, BrowserWindow, Menu, MenuItem, ipcMain, dialog } = require('electron');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Each model has its own option set, defaults, and pricing. Adding a new
// image model = one new entry in this map; everything else (UI, cost calc,
// per-turn pinning) is driven from this spec.
const MODEL_SPECS = {
  'gemini-3-pro-image-preview': {
    displayName: 'Nano Banana Pro',
    aspectRatios: ['auto', '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '4:5', '5:4'],
    imageSizes: ['1K', '2K', '4K'],
    personGeneration: ['ALLOW_ALL', 'ALLOW_ADULT', 'ALLOW_NONE'],
    prominentPeople: ['ALLOW_PROMINENT_PEOPLE', 'BLOCK_PROMINENT_PEOPLE'],
    responseModalities: ['TEXT', 'IMAGE'],
    harmCategories: [
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_CIVIC_INTEGRITY',
      'HARM_CATEGORY_IMAGE_HATE',
      'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT',
      'HARM_CATEGORY_IMAGE_HARASSMENT',
      'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT',
    ],
    supportsGoogleSearch: true,
    supportsSystemInstruction: true,
    samplingDefaults: { temperature: 1.0, topP: 0.95 },
    // Vertex AI standard pricing, May 2026
    // (cloud.google.com/vertex-ai/generative-ai/pricing)
    pricing: { inputPerToken: 2 / 1_000_000, outputPerToken: 120 / 1_000_000 },
  },
};
const DEFAULT_MODEL = 'gemini-3-pro-image-preview';

// ---------------------------------------------------------------------------
// genai client
// ---------------------------------------------------------------------------
function authMode() {
  if (process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY) return 'api_key';
  if (process.env.GOOGLE_CLOUD_PROJECT) return 'adc';
  return 'missing';
}

// Lazy + memoized: building a GenAI client does auth/network setup we shouldn't
// repeat on every IPC call. Env doesn't change at runtime, so a single instance
// is safe.
let _client = null;
function buildClient() {
  if (_client) return _client;

  const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;
  if (apiKey) {
    _client = new GoogleGenAI({ vertexai: true, apiKey });
    return _client;
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
  if (project) {
    _client = new GoogleGenAI({ vertexai: true, project, location });
    return _client;
  }

  throw new Error(
    'No credentials. Set GOOGLE_CLOUD_API_KEY, or GOOGLE_CLOUD_PROJECT (+ GOOGLE_CLOUD_LOCATION) in .env.'
  );
}

// ---------------------------------------------------------------------------
// Friendly error mapping
// ---------------------------------------------------------------------------
const ERROR_RULES = [
  [l => l.includes('api key') && (l.includes('invalid') || l.includes('not valid')),
    'Invalid API key. Check GOOGLE_CLOUD_API_KEY in .env.', false],
  [l => l.includes('permission') || l.includes('403'),
    'Permission denied — make sure the Vertex AI API is enabled and your principal has roles/aiplatform.user.', true],
  [l => l.includes('quota') || l.includes('429') || l.includes('rate'),
    'Quota or rate limit hit. Try a lower image_size or request a quota increase.', true],
  [l => l.includes('not found') && l.includes('model'),
    'Model not found — confirm the model ID is enabled in your region. Pro is only served at location=global.', true],
  [l => l.includes('billing'),
    'Billing not configured. Link a billing account to your GCP project.', true],
  [l => l.includes('safety') || l.includes('blocked'),
    'Output blocked by safety filters. Loosen safety_settings or rephrase.', true],
];

function friendlyError(e) {
  const msg = e?.message || String(e);
  const low = msg.toLowerCase();
  for (const [pred, hint, append] of ERROR_RULES) {
    if (pred(low)) return append ? `${hint} (${msg})` : hint;
  }
  return `${e?.name || 'Error'}: ${msg}`;
}

// ---------------------------------------------------------------------------
// SDK response normalization
// ---------------------------------------------------------------------------
function* iterParts(chunk) {
  for (const cand of (chunk?.candidates || [])) {
    for (const part of (cand?.content?.parts || [])) {
      if (part.inlineData?.data) {
        yield {
          type: 'image',
          mimeType: part.inlineData.mimeType || 'image/png',
          data: part.inlineData.data,  // base64 string
        };
      } else if (part.text) {
        yield { type: 'text', value: part.text };
      }
    }
    for (const gc of (cand?.groundingMetadata?.groundingChunks || [])) {
      if (gc.web) yield { type: 'grounding', uri: gc.web.uri, title: gc.web.title };
    }
  }
}

function metaOf(chunk) {
  let finishReason = null;
  for (const cand of (chunk?.candidates || [])) {
    if (cand.finishReason) finishReason = String(cand.finishReason);
  }
  const u = chunk?.usageMetadata;
  const usage = u ? {
    promptTokenCount: u.promptTokenCount ?? null,
    candidatesTokenCount: u.candidatesTokenCount ?? null,
    totalTokenCount: u.totalTokenCount ?? null,
    thoughtsTokenCount: u.thoughtsTokenCount ?? null,
  } : null;
  return { finishReason, usage };
}

function collectResponse(resp) {
  const images = [];
  const textChunks = [];
  const grounding = [];
  for (const ev of iterParts(resp)) {
    if (ev.type === 'image') images.push({ mimeType: ev.mimeType, data: ev.data });
    else if (ev.type === 'text') textChunks.push(ev.value);
    else if (ev.type === 'grounding') grounding.push({ uri: ev.uri, title: ev.title });
  }
  return { images, text: textChunks.join(''), grounding, ...metaOf(resp) };
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
const inFlight = new Map();  // streamId -> AbortController

ipcMain.handle('get-options', () => ({
  models: Object.keys(MODEL_SPECS),
  modelSpecs: MODEL_SPECS,
  authMode: authMode(),
}));

ipcMain.handle('generate', async (_event, { model, contents, config }) => {
  if (!contents?.length) return { error: 'Empty prompt and no references.' };
  let client;
  try { client = buildClient(); }
  catch (e) { return { error: friendlyError(e) }; }
  try {
    const resp = await client.models.generateContent({
      model: model || DEFAULT_MODEL, contents, config,
    });
    return collectResponse(resp);
  } catch (e) {
    return { error: friendlyError(e) };
  }
});

ipcMain.handle('generate-stream', async (event, { model, contents, config, streamId }) => {
  const send = (payload) => event.sender.send('generate-stream-event', { streamId, ...payload });
  const fail = (message) => { send({ type: 'error', message }); send({ type: 'done' }); };

  if (!contents?.length) return fail('Empty prompt and no references.');

  let client;
  try { client = buildClient(); }
  catch (e) { return fail(friendlyError(e)); }

  const ac = new AbortController();
  inFlight.set(streamId, ac);
  try {
    const stream = await client.models.generateContentStream({
      model: model || DEFAULT_MODEL, contents, config,
    });
    for await (const chunk of stream) {
      if (ac.signal.aborted) break;
      for (const ev of iterParts(chunk)) send(ev);
      const m = metaOf(chunk);
      if (m.finishReason || m.usage) send({ type: 'meta', ...m });
    }
  } catch (e) {
    send({ type: 'error', message: friendlyError(e) });
  } finally {
    inFlight.delete(streamId);
    send({ type: 'done' });
  }
});

ipcMain.handle('cancel-generation', (_event, { streamId }) => {
  inFlight.get(streamId)?.abort();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Chat persistence — single JSON file in userData. Single-app, single-user, so
// no concurrency concerns. Atomic-ish write via tmp-rename.
// ---------------------------------------------------------------------------
function chatsPath() { return path.join(app.getPath('userData'), 'chats.json'); }

ipcMain.handle('chats-load', async () => {
  try {
    const txt = await fs.readFile(chatsPath(), 'utf8');
    return { data: JSON.parse(txt) };
  } catch (e) {
    if (e.code === 'ENOENT') return { data: null };
    return { error: e.message };
  }
});

ipcMain.handle('chats-save', async (_event, payload) => {
  try {
    const file = chatsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, file);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ---------------------------------------------------------------------------
// Bug-report markdown — system info + sanitized snapshot + event timeline
// ---------------------------------------------------------------------------
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function generateMarkdown(payload) {
  const {
    description,
    appState,    // { authMode, model, config, refs:[{name,mime,w,h,bytes}], historyDepth, historyHasImages, lastPrompt, sessionTokens, sessionCount, currentlyStreaming }
    lastError,   // { message, ts } | null
    eventLogs,   // string[]
  } = payload || {};

  const sys = {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    appVersion: app.getVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
    timestamp: new Date().toISOString(),
  };

  const refs = appState?.refs || [];
  const cfg = appState?.config || {};
  const ic = cfg.imageConfig || {};

  // Reference table (no base64 data — counts/metadata only).
  let refMd = '';
  if (refs.length) {
    const rows = refs.map((r, i) =>
      `| ${i} | \`${(r.name || '—').replace(/\|/g, '\\|')}\` | ${r.mime || '—'} | ${r.w && r.h ? `${r.w}×${r.h}` : '—'} | ${fmtBytes(r.bytes)} |`
    ).join('\n');
    refMd = `
## Reference Images (${refs.length} / 14)
| # | Name | MIME | Dimensions | Approx. size |
|---|---|---|---|---|
${rows}
`;
  }

  // Last error (most recent generation/SDK failure).
  let lastErrMd = '';
  if (lastError) {
    lastErrMd = `
## Last Error
- When: ${lastError.ts || 'unknown'}
- Message: \`${(lastError.message || '').replace(/`/g, '\\`')}\`
`;
  }

  // Effective config — already sanitized (renderer never sends image bytes here).
  const cfgSummary = {
    model: appState?.model,
    responseModalities: cfg.responseModalities,
    imageConfig: Object.keys(ic).length ? ic : undefined,
    sampling: {
      temperature: cfg.temperature,
      topP: cfg.topP,
      topK: cfg.topK,
      seed: cfg.seed,
      candidateCount: cfg.candidateCount,
      maxOutputTokens: cfg.maxOutputTokens,
      presencePenalty: cfg.presencePenalty,
      frequencyPenalty: cfg.frequencyPenalty,
      stopSequences: cfg.stopSequences,
      responseLogprobs: cfg.responseLogprobs,
      logprobs: cfg.logprobs,
    },
    systemInstruction: cfg.systemInstruction,
    mediaResolution: cfg.mediaResolution,
    tools: cfg.tools,
    safetySettings: cfg.safetySettings,
  };

  const head = `First assess if this bug report has all the data you need to debug this. If not, improve the bug reporting feature. Then, fix the following bug:

# Bug Report — Nano Banana Pro Studio

## Issue Description
${description || '(none provided)'}

## Snapshot
- Auth mode: \`${appState?.authMode || 'unknown'}\`
- Model: \`${appState?.model || 'unknown'}\`
- References: ${refs.length} / 14
- History turns: ${appState?.historyDepth ?? 0}${appState?.historyHasImages ? ' (contains images)' : ''}
- Currently streaming: ${appState?.currentlyStreaming ? 'yes' : 'no'}
- Session: ${appState?.sessionCount ?? 0} generations · ${appState?.sessionTokens ?? 0} tokens${typeof appState?.sessionCost === 'number' ? ` · ~$${appState.sessionCost.toFixed(4)} (Vertex AI rates)` : ''}
- Last prompt: \`${(appState?.lastPrompt || '').replace(/`/g, '\\`').slice(0, 500)}${(appState?.lastPrompt || '').length > 500 ? '…' : ''}\`
- Viewport: ${appState?.viewport?.innerWidth ?? '?'} × ${appState?.viewport?.innerHeight ?? '?'} px @ ${appState?.viewport?.devicePixelRatio ?? '?'}× DPR${appState?.viewport?.openPopup ? ` · open popup: \`${appState.viewport.openPopup}\`` : ''}${appState?.diceFace ? ` · dice face: ${appState.diceFace} dots` : ''}

## System
- Platform: ${sys.platform} ${sys.arch} (Darwin ${sys.osRelease})
- App version: ${sys.appVersion}
- Electron: ${sys.electronVersion} · Node: ${sys.nodeVersion}
- Memory: ${sys.freeMemMB} MB free / ${sys.totalMemMB} MB total
- Timestamp: ${sys.timestamp}
${lastErrMd}${refMd}
## Effective Config
\`\`\`json
${JSON.stringify(cfgSummary, null, 2)}
\`\`\`

## Event History
`;

  // Trim event log to fit a 5 MB total budget — newest first, then re-reverse.
  const BUDGET = 5 * 1024 * 1024;
  const headBytes = Buffer.byteLength(head, 'utf8');
  let eventsMd;
  const events = Array.isArray(eventLogs) ? eventLogs : [];
  if (!events.length) {
    eventsMd = '*(No events recorded)*\n';
  } else {
    let used = Buffer.byteLength('```text\n\n```\n', 'utf8');
    const remaining = BUDGET - headBytes;
    const kept = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const line = events[i] + '\n';
      const lb = Buffer.byteLength(line, 'utf8');
      if (used + lb > remaining) break;
      used += lb;
      kept.push(line);
    }
    kept.reverse();
    eventsMd = '```text\n' + kept.join('') + '```\n';
  }

  return head + eventsMd;
}

ipcMain.handle('export-bug-report', async (_event, payload) => {
  try {
    const markdown = generateMarkdown(payload);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save Bug Report',
      defaultPath: path.join(app.getPath('desktop'), `nano-banana-bug-report-${Date.now()}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.writeFile(filePath, markdown, 'utf8');
    return { filePath };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
});

ipcMain.handle('generate-bug-report-markdown', (_event, payload) => {
  try { return { markdown: generateMarkdown(payload) }; }
  catch (e) { return { error: e?.message || String(e) }; }
});

// ---------------------------------------------------------------------------
// Window / app lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    title: 'Nano Banana Pro Studio',
  });
  win.setMenuBarVisibility(false);

  // Electron has spellcheck on by default, but no built-in context menu — so
  // right-clicking a misspelled word does nothing unless we provide one.
  // We show dictionary suggestions for misspellings, then standard edit
  // actions (cut/copy/paste/select-all) when the click is on editable text.
  win.webContents.on('context-menu', (_e, params) => {
    const menu = new Menu();
    for (const suggestion of params.dictionarySuggestions || []) {
      menu.append(new MenuItem({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      }));
    }
    if (params.misspelledWord) {
      menu.append(new MenuItem({
        label: 'Add to dictionary',
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.mediaType === 'image' && params.srcURL) {
      menu.append(new MenuItem({
        label: 'Copy Image',
        click: () => win.webContents.copyImageAt(params.x, params.y),
      }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut', enabled: !!params.selectionText }));
      menu.append(new MenuItem({ role: 'copy', enabled: !!params.selectionText }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }
    if (menu.items.length) menu.popup({ window: win });
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

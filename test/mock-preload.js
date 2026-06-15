// Test preload: exposes a mock `window.api` that mirrors the real preload's
// contract but is fully offline (no IPC, no Vertex AI). Lets the real renderer
// (index.html + app.js) run end-to-end against canned responses so we can
// exercise generation, streaming, settings, and chat logic with zero cost.
const { contextBridge } = require('electron');
const { MODEL_SPECS } = require('../model-specs');

// 1×1 PNG — enough for the renderer to decode dimensions and render.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 100, totalTokenCount: 110, thoughtsTokenCount: 0 };

// Records every call so assertions can verify the renderer talked to the API.
const calls = { generate: 0, generateStream: 0, cancel: 0, save: 0 };
const streamHandlers = new Map();

contextBridge.exposeInMainWorld('api', {
  getOptions: async () => ({
    models: Object.keys(MODEL_SPECS),
    modelSpecs: MODEL_SPECS,
    authMode: 'adc',
  }),

  generate: async (_args) => {
    calls.generate++;
    return {
      images: [{ mimeType: 'image/png', data: PNG_1x1 }],
      text: 'mock caption',
      grounding: [],
      finishReason: 'STOP',
      usage: USAGE,
    };
  },

  generateStream: (_args) => {
    calls.generateStream++;
    return `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  },

  subscribeStream: (streamId, cb) => {
    streamHandlers.set(streamId, cb);
    // Emit a canned sequence once the renderer has subscribed.
    setTimeout(() => {
      const fire = (ev) => { if (streamHandlers.has(streamId)) cb(ev); };
      fire({ streamId, type: 'text', value: 'mock ' });
      fire({ streamId, type: 'text', value: 'caption' });
      fire({ streamId, type: 'image', mimeType: 'image/png', data: PNG_1x1 });
      fire({ streamId, type: 'meta', finishReason: 'STOP', usage: USAGE });
      fire({ streamId, type: 'done' });
    }, 5);
    return () => streamHandlers.delete(streamId);
  },

  cancelGeneration: async (_streamId) => { calls.cancel++; return { ok: true }; },

  exportBugReport: async (_payload) => ({ filePath: '/tmp/mock-report.md' }),
  generateBugReportMarkdown: async (_payload) => ({ markdown: '# mock report' }),

  loadChats: async () => ({ data: null }),
  saveChats: async (_payload) => { calls.save++; return { ok: true }; },

  // Test-only hook so assertions can read the call counters.
  __calls: () => ({ ...calls }),
});

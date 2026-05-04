// Bridge between the sandboxed renderer and the privileged main process.
const { contextBridge, ipcRenderer } = require('electron');

const streamHandlers = new Map();  // streamId -> callback

ipcRenderer.on('generate-stream-event', (_e, payload) => {
  const cb = streamHandlers.get(payload.streamId);
  if (cb) cb(payload);
});

contextBridge.exposeInMainWorld('api', {
  getOptions: () => ipcRenderer.invoke('get-options'),

  generate: (args) => ipcRenderer.invoke('generate', args),

  // Returns a stream id; caller subscribes via subscribeStream(id, cb).
  generateStream: (args) => {
    const streamId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    ipcRenderer.invoke('generate-stream', { ...args, streamId });
    return streamId;
  },

  subscribeStream: (streamId, callback) => {
    streamHandlers.set(streamId, callback);
    return () => streamHandlers.delete(streamId);
  },

  cancelGeneration: (streamId) => ipcRenderer.invoke('cancel-generation', { streamId }),

  exportBugReport: (payload) => ipcRenderer.invoke('export-bug-report', payload),
  generateBugReportMarkdown: (payload) => ipcRenderer.invoke('generate-bug-report-markdown', payload),

  loadChats: () => ipcRenderer.invoke('chats-load'),
  saveChats: (payload) => ipcRenderer.invoke('chats-save', payload),
});

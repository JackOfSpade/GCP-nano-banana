// Per-model specifications — the single source of truth for which options,
// defaults, and pricing each image model exposes. main.js ships this to the
// renderer over IPC (get-options); the renderer drives its entire UI, cost
// calculation, and per-turn pinning from it. Adding a new image model is one
// new entry here — nothing else needs to change.
//
// Kept as a standalone, dependency-free CommonJS module so it can be required
// from both the Electron main process and the test harness without pulling in
// any Electron internals.

const HARM_CATEGORIES = [
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
  'HARM_CATEGORY_IMAGE_HATE',
  'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT',
  'HARM_CATEGORY_IMAGE_HARASSMENT',
  'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT',
];

const ASPECT_RATIOS = ['auto', '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '4:5', '5:4', '1:8', '8:1', '1:4', '4:1'];
const IMAGE_SIZES = ['512', '1K', '2K', '4K'];

const MODEL_SPECS = {
  'gemini-3-pro-image': {
    displayName: 'Nano Banana Pro',
    aspectRatios: ASPECT_RATIOS,
    imageSizes: IMAGE_SIZES,
    personGeneration: ['ALLOW_ALL', 'ALLOW_ADULT', 'ALLOW_NONE'],
    prominentPeople: ['ALLOW_PROMINENT_PEOPLE', 'BLOCK_PROMINENT_PEOPLE'],
    responseModalities: ['TEXT', 'IMAGE'],
    harmCategories: HARM_CATEGORIES,
    supportsGoogleSearch: true,
    supportsSystemInstruction: true,
    // gemini-3-pro-image rejects thinking_level (400 INVALID_ARGUMENT).
    supportsThinking: false,
    samplingDefaults: { temperature: 1.0, topP: 0.95 },
    // Vertex AI standard pricing, May 2026
    // (cloud.google.com/vertex-ai/generative-ai/pricing)
    pricing: { inputPerToken: 2 / 1_000_000, outputPerToken: 120 / 1_000_000 },
  },
  'gemini-3.1-flash-image': {
    displayName: 'Nano Banana 2 (Flash)',
    aspectRatios: ASPECT_RATIOS,
    imageSizes: IMAGE_SIZES,
    personGeneration: ['ALLOW_ALL', 'ALLOW_ADULT', 'ALLOW_NONE'],
    prominentPeople: ['ALLOW_PROMINENT_PEOPLE', 'BLOCK_PROMINENT_PEOPLE'],
    responseModalities: ['TEXT', 'IMAGE'],
    harmCategories: HARM_CATEGORIES,
    supportsGoogleSearch: true,
    supportsSystemInstruction: true,
    supportsThinking: true,
    samplingDefaults: { temperature: 1.0, topP: 0.95 },
    // Vertex AI standard pricing, May 2026
    // (cloud.google.com/vertex-ai/generative-ai/pricing)
    pricing: { inputPerToken: 0.5 / 1_000_000, outputPerToken: 3.0 / 1_000_000 },
  },
};

const DEFAULT_MODEL = 'gemini-3-pro-image';

module.exports = { MODEL_SPECS, DEFAULT_MODEL };

require('dotenv').config({ path: '.env' });
const { GoogleGenAI } = require('@google/genai');

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;

const client = apiKey
  ? new GoogleGenAI({ vertexai: true, apiKey })
  : new GoogleGenAI({ vertexai: true, project, location });

const MODEL = 'gemini-3-pro-image';

// 64x64 solid red PNG as a reference image.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

function baseConfig() {
  return {
    temperature: 1.0,
    topP: 0.95,
    mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: {
      imageSize: '2K',
      outputMimeType: 'image/png',
      personGeneration: 'ALLOW_ALL',
    },
    safetySettings: [
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_CIVIC_INTEGRITY',
      'HARM_CATEGORY_IMAGE_HATE',
      'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT',
      'HARM_CATEGORY_IMAGE_HARASSMENT',
      'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT',
    ].map(category => ({ category, threshold: 'OFF' })),
  };
}

const baseContents = () => ([
  { role: 'user', parts: [{ text: 'A tiny rubber duck on a desk, studio lighting.' }] },
]);

async function tryCase(name, { contents = baseContents(), config = baseConfig() } = {}) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const resp = await client.models.generateContent({ model: MODEL, contents, config });
    const parts = resp?.candidates?.[0]?.content?.parts || [];
    const imgs = parts.filter(p => p.inlineData).length;
    const txt = parts.filter(p => p.text).map(p => p.text).join('').slice(0, 80);
    console.log(`OK — ${imgs} image part(s), finishReason=${resp?.candidates?.[0]?.finishReason}, text="${txt}"`);
  } catch (e) {
    console.log(`FAIL: ${e?.name || 'Error'}: ${(e?.message || String(e)).slice(0, 300)}`);
  }
}

(async () => {
  console.log(`auth: ${apiKey ? 'apiKey' : `adc project=${project} location=${location}`}`);

  // A) Google Search tool enabled
  {
    const cfg = baseConfig();
    cfg.tools = [{ googleSearch: {} }];
    await tryCase('A) tools=googleSearch', { config: cfg });
  }

  // B) aspectRatio set
  {
    const cfg = baseConfig();
    cfg.imageConfig.aspectRatio = '16:9';
    await tryCase('B) imageConfig.aspectRatio=16:9', { config: cfg });
  }

  // C) prominentPeople set
  {
    const cfg = baseConfig();
    cfg.imageConfig.prominentPeople = 'BLOCK_PROMINENT_PEOPLE';
    await tryCase('C) imageConfig.prominentPeople=BLOCK_PROMINENT_PEOPLE', { config: cfg });
  }

  // D) systemInstruction set
  {
    const cfg = baseConfig();
    cfg.systemInstruction = 'You are a helpful image generator.';
    await tryCase('D) systemInstruction set', { config: cfg });
  }

  // E) seed set
  {
    const cfg = baseConfig();
    cfg.seed = 42;
    await tryCase('E) seed=42', { config: cfg });
  }

  // F) Reference image input
  {
    const contents = [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
        { text: 'Make this duck blue.' },
      ],
    }];
    await tryCase('F) reference image + text', { contents });
  }

  // G) Multi-turn with prior model image
  {
    const contents = [
      { role: 'user', parts: [{ text: 'A red apple.' }] },
      {
        role: 'model', parts: [
          { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
          { text: 'Here is your red apple.' },
        ]
      },
      { role: 'user', parts: [{ text: 'Now make it green.' }] },
    ];
    await tryCase('G) multi-turn w/ prior model image', { contents });
  }

  // H) responseModalities = IMAGE only
  {
    const cfg = baseConfig();
    cfg.responseModalities = ['IMAGE'];
    await tryCase('H) responseModalities=[IMAGE] only', { config: cfg });
  }

  // I) responseModalities = TEXT only
  {
    const cfg = baseConfig();
    cfg.responseModalities = ['TEXT'];
    await tryCase('I) responseModalities=[TEXT] only', { config: cfg });
  }

  // J) imageSize=4K
  {
    const cfg = baseConfig();
    cfg.imageConfig.imageSize = '4K';
    await tryCase('J) imageSize=4K', { config: cfg });
  }

  // K) googleSearch + reference image
  {
    const cfg = baseConfig();
    cfg.tools = [{ googleSearch: {} }];
    const contents = [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
        { text: 'What is in this image?' },
      ],
    }];
    await tryCase('K) googleSearch + reference image', { contents, config: cfg });
  }

  // L) Everything on at once
  {
    const cfg = baseConfig();
    cfg.tools = [{ googleSearch: {} }];
    cfg.imageConfig.aspectRatio = '16:9';
    cfg.imageConfig.prominentPeople = 'BLOCK_PROMINENT_PEOPLE';
    cfg.systemInstruction = 'You are a helpful image generator.';
    cfg.seed = 42;
    const contents = [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
        { text: 'Make this duck blue, in 16:9.' },
      ],
    }];
    await tryCase('L) EVERYTHING on', { contents, config: cfg });
  }
})().catch(e => { console.error(e); process.exit(1); });

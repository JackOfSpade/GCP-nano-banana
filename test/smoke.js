// Offline smoke + logic test. Boots the REAL renderer (index.html + app.js +
// style.css) inside a hidden Electron window with a mock window.api, then runs
// test/page-assertions.js in the page context. No network, no Vertex AI, no
// cost. Exit code 0 = all pass, 1 = failures, 2 = harness error.
//
// Run: npm test   (electron test/smoke.js)

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

// Isolate localStorage / userData so the test never touches the real app's
// chats, presets, or settings.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nbp-smoke-')));

const ROOT = path.join(__dirname, '..');
const fail = (code, msg) => { console.error(msg); app.exit(code); };

// Hard timeout so a hang can't wedge CI.
const watchdog = setTimeout(() => fail(2, '✗ harness timeout (30s)'), 30000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'mock-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // allow the mock preload to require ../model-specs
    },
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    // level 3 = error
    if (level >= 3) pageErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, details) =>
    fail(2, `✗ renderer crashed: ${JSON.stringify(details)}`));

  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

    // Wait for the async init() to finish wiring up the UI.
    await win.webContents.executeJavaScript(`new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        try {
          if (typeof state !== 'undefined' && state.options && document.querySelector('#model-list button')) {
            clearInterval(iv); res(true);
          } else if (Date.now() - t0 > 8000) {
            clearInterval(iv); rej(new Error('init() did not complete within 8s'));
          }
        } catch (e) { clearInterval(iv); rej(e); }
      }, 25);
    })`);

    const assertions = fs.readFileSync(path.join(__dirname, 'page-assertions.js'), 'utf8');
    const results = await win.webContents.executeJavaScript(assertions, true);

    let passed = 0, failed = 0;
    for (const r of results) {
      if (r.pass) { passed++; console.log(`  ✓ ${r.name}`); }
      else { failed++; console.log(`  ✗ ${r.name}\n      ${r.detail}`); }
    }

    console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} assertions passed`);

    if (pageErrors.length) {
      console.log(`\n⚠ ${pageErrors.length} renderer console error(s):`);
      for (const e of pageErrors) console.log(`    ${e}`);
    }

    clearTimeout(watchdog);
    app.exit(failed || pageErrors.length ? 1 : 0);
  } catch (e) {
    clearTimeout(watchdog);
    fail(2, `✗ harness error: ${(e && e.stack) || e}`);
  }
});

app.on('window-all-closed', () => {}); // keep alive until we explicitly exit

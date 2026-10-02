// Production-boot integration test. Unlike smoke.js (which mocks the API), this
// require()s the REAL main.js so the actual IPC handlers, preload, window
// creation, disk persistence, and bug-report markdown generator all run. It
// never calls generate(), so there is no network traffic or Vertex AI cost.
//
// Run: npm run test:boot
// Exit code 0 = pass, 1 = assertion failure, 2 = harness error.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

// Isolate userData so the real chats-save/chats-load handlers hit a temp dir.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nbp-boot-')));

// Keep the production window hidden while the assertions run so the test
// doesn't flash a window. It is briefly shown for capturePage below: Chromium
// can only capture a view after it has a composited display surface (notably
// under Xvfb on hosted Linux runners).
app.on('browser-window-created', (_e, win) => win.hide());

// Boot the actual app (registers all ipcMain handlers + schedules createWindow).
require('..');

const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });
const fail = (code, msg) => { console.error(msg); app.exit(code); };
const watchdog = setTimeout(() => fail(2, '✗ harness timeout (30s)'), 30000);

app.whenReady().then(async () => {
  // main.js's own whenReady handler already ran createWindow by now.
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return fail(2, '✗ no BrowserWindow created by main.js');
  win.hide();

  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) pageErrors.push(message); });

  try {
    if (win.webContents.isLoadingMainFrame()) {
      await new Promise(res => win.webContents.once('did-finish-load', res));
    }

    await win.webContents.executeJavaScript(`new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (typeof state !== 'undefined' && state.options && document.querySelector('#model-list button')) { clearInterval(iv); res(true); }
        else if (Date.now() - t0 > 8000) { clearInterval(iv); rej(new Error('init timeout')); }
      }, 25);
    })`);

    // Options came from the REAL get-options handler (authMode + MODEL_SPECS).
    const opts = await win.webContents.executeJavaScript('JSON.parse(JSON.stringify(state.options))');
    ok('real get-options: authMode present', opts.authMode === 'adc' || opts.authMode === 'api_key' || opts.authMode === 'missing', opts.authMode);
    ok('real get-options: 2 models', opts.models.length === 2, JSON.stringify(opts.models));
    ok('real get-options: pro displayName', opts.modelSpecs['gemini-3-pro-image'].displayName === 'Nano Banana Pro');
    ok('real renderer: model popup built', await win.webContents.executeJavaScript("document.querySelectorAll('#model-list button').length") === 2);
    ok('real renderer: auth pill rendered', !!(await win.webContents.executeJavaScript("$('auth-mode').textContent")));

    // Chats disk round-trip via the REAL chats-save / chats-load handlers.
    const roundTrip = await win.webContents.executeJavaScript(`(async () => {
      const chat = { id: 'boot-x', title: 'boot test', turns: [], createdAt: 1, updatedAt: 2 };
      const s = await window.api.saveChats({ chats: [chat], currentChatId: 'boot-x' });
      const l = await window.api.loadChats();
      return { saved: s, loaded: l };
    })()`);
    ok('real chats-save: ok', roundTrip.saved && roundTrip.saved.ok === true, JSON.stringify(roundTrip.saved));
    ok('real chats-load: round-trips data', roundTrip.loaded && roundTrip.loaded.data && roundTrip.loaded.data.chats[0].id === 'boot-x', JSON.stringify(roundTrip.loaded));

    // Bug-report markdown via the REAL generateMarkdown in main.js.
    const report = await win.webContents.executeJavaScript(`(async () => {
      const res = await window.api.generateBugReportMarkdown(buildReportPayload('boot integration test'));
      return res;
    })()`);
    ok('real bug-report: returns markdown', report && typeof report.markdown === 'string' && report.markdown.length > 0);
    ok('real bug-report: has heading', report.markdown.includes('Bug Report — Nano Banana Pro Studio'), '');
    ok('real bug-report: authMode not "unknown"', /Auth mode: `(adc|api_key|missing)`/.test(report.markdown), report.markdown.split('\n').find(l => l.includes('Auth mode')) || '');
    ok('real bug-report: includes description', report.markdown.includes('boot integration test'));

    // Visual artifact. A hidden BrowserWindow has no display surface on some
    // Chromium platforms, so expose the real app briefly and wait for two
    // compositor frames before capturing it. This preserves a real rendered
    // screenshot rather than masking a capture failure in CI.
    win.show();
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'real-boot-screenshot.png'), img.toPNG());

    let passed = 0, failed = 0;
    for (const r of results) {
      if (r.pass) { passed++; console.log(`  ✓ ${r.name}`); }
      else { failed++; console.log(`  ✗ ${r.name}\n      ${r.detail}`); }
    }
    console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} assertions passed (screenshot: test/real-boot-screenshot.png)`);
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

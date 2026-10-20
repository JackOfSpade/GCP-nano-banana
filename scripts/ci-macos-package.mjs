// Credential-free CI packaging smoke. The normal signed release command is unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
assert.equal(process.platform, 'darwin', 'This smoke must verify a real macOS bundle');
const REQUIRED_ENTRIES = ['/main.js', '/preload.js', '/model-specs.js', '/renderer/index.html'];
const output = mkdtempSync(path.join(tmpdir(), 'ci-macos-package-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed (${result.status})`);
}
try {
  // Override only this invocation: GitHub has no local signing certificate.
  // Do not weaken the project's normal forceCodeSigning/release identity policy.
  run(process.execPath, ['node_modules/electron-builder/cli.js', '--mac', 'dir', '--arm64',
    '--config.mac.identity=null', '--config.mac.forceCodeSigning=false',
    `--config.directories.output=${output}`], {
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    });
  const apps = readdirSync(output, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
    .flatMap(entry => readdirSync(path.join(output, entry.name))
      .filter(name => name.endsWith('.app')).map(name => path.join(output, entry.name, name)));
  assert.equal(apps.length, 1, 'Expected exactly one freshly built arm64 app');
  const app = apps[0];
  const archive = path.join(app, 'Contents/Resources/app.asar');
  assert.ok(existsSync(archive) && statSync(archive).size > 0, 'Packaged application archive is missing');
  const entries = asar.listPackage(archive);
  for (const entry of REQUIRED_ENTRIES) assert.ok(entries.includes(entry), `Missing packaged file: ${entry}`);
  assert.ok(!entries.includes('/.env'), 'CI packages must never contain a credential .env file');
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.ok(entries.includes(`/${pkg.main}`), 'The packaged main entry must resolve');
  const plist = path.join(app, 'Contents/Info.plist');
  const executable = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { encoding: 'utf8' });
  assert.equal(executable.status, 0, 'The application must have a valid bundle executable');
  assert.ok(existsSync(path.join(app, 'Contents/MacOS', executable.stdout.trim())));
  // Ad-hoc sealing tests nested bundle integrity, with no certificate or Apple account.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/macos-package.json', JSON.stringify({
    platform: process.platform, arch: 'arm64', signing: 'ad-hoc CI only',
    packageName: pkg.name, main: pkg.main, requiredEntries: REQUIRED_ENTRIES,
    archiveBytes: statSync(archive).size, verified: true,
  }, null, 2) + '\n');
} finally {
  rmSync(output, { recursive: true, force: true });
}

/**
 * Unit checks for the parts of serve.js that need no `coa` binary:
 *
 *   node test/serve.unit.test.js
 *
 * The fixtures below are real output captured from the Coalesce Desktop shim,
 * which serves an unreleased CLI build with no downloadable UI bundle.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// DESKTOP_DIR is derived from the home directory at require time, so point the
// module at a scratch home before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coalesce-serve-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const serve = require('../serve');

const desktop = path.join(home, '.coalesce', 'desktop');
const app = path.join(home, 'Coalesce.app', 'Contents', 'Resources', 'coa');
const shim = serve.desktopShimPath();

function installDesktop({ withUi }) {
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(desktop, 'agent.json'), JSON.stringify({ coa: { coaEntry: path.join(app, 'coa.js') } }));
  if (withUi) {
    fs.mkdirSync(path.join(app, 'web-ui'), { recursive: true });
    fs.writeFileSync(path.join(app, 'web-ui', 'index.html'), '<!DOCTYPE html>');
  }
}

const UI_404 =
  '|2026-09-09T07:23:52.463Z|[CLI]|info:[UiBundle] Downloading Coalesce UI (first run for this version)\n' +
  '  ✖ Serve failed: The Coalesce UI bundle was not found at ' +
  'https://storage.googleapis.com/coalesce-coa/ui/coa-ui-0.0.0-ci.zip (HTTP 404). This CLI version may be newer ' +
  'or older than the published UI, or the bundle has not been published yet.\n' +
  '|2026-09-09T07:23:52.723Z|[CLI_INTERNAL]|warn:Unexpected active resources during graceful CLI shutdown\n';

// ------------------------------------------------------------- lastCliError

assert.ok(serve.lastCliError(UI_404).startsWith('The Coalesce UI bundle was not found'), 'reads the ✖ line');
assert.strictEqual(
  serve.lastCliError('|2026-01-01T00:00:00.000Z|[CLI]|error:[ServeCommand] Failed to start: port in use'),
  'Failed to start: port in use',
  'falls back to a logged error line',
);
assert.strictEqual(serve.lastCliError('|[CLI]|info:[WatchServer] Starting server\n'), null, 'no error, no detail');

// --------------------------------------------------------------- explainExit

assert.strictEqual(
  serve.explainExit({ output: UI_404, code: 1, signal: null, coa: shim }),
  'Coalesce Desktop may be interfering with the `coa` CLI. Try quitting Coalesce Desktop and starting again.',
  'points at Desktop without the technical detail',
);
assert.strictEqual(
  serve.explainExit({ output: UI_404, code: 1, signal: null, coa: 'coa' }),
  'This `coa` has no Coalesce UI to serve.',
  'does not blame Desktop for a PATH `coa`',
);

assert.strictEqual(
  serve.explainExit({ output: '|[CLI]|info:[WatchServer] Starting server\n', code: 3, signal: null, coa: 'coa' }),
  '`coa serve` exited before it was ready (code 3, signal null)',
  'unrecognised failures keep the exit code',
);
assert.strictEqual(
  serve.explainExit({ output: '\x1b[31m  ✖ Serve failed: bad profile\x1b[0m\n', code: 1, coa: 'coa' }),
  '`coa serve` exited before it was ready: bad profile',
  'strips ANSI and surfaces the CLI reason',
);

// -------------------------------------------------- desktopUiPath / serveEnv

assert.strictEqual(serve.desktopUiPath('coa'), null, 'a PATH `coa` never gets the override');
assert.strictEqual(serve.desktopUiPath(shim), null, 'no override before Desktop is installed');

installDesktop({ withUi: false });
assert.strictEqual(serve.desktopUiPath(shim), null, 'no override when the app has no bundled UI');

installDesktop({ withUi: true });
assert.strictEqual(serve.desktopUiPath(shim), path.join(app, 'web-ui'), 'finds the UI beside the app CLI entry');

assert.strictEqual(serve.serveEnv(shim, {})[serve.UI_PATH_ENV], path.join(app, 'web-ui'), 'shim gets the override');
assert.strictEqual(serve.serveEnv('coa', {})[serve.UI_PATH_ENV], undefined, 'PATH `coa` is left alone');
assert.strictEqual(
  serve.serveEnv(shim, { [serve.UI_PATH_ENV]: '/my/ui' })[serve.UI_PATH_ENV],
  '/my/ui',
  'an existing override is respected',
);

// ------------------------------------------------- where Coalesce Desktop lives
// Both branches are asserted on every host: `platform` is a parameter precisely
// so a Mac catches a regression in the Windows layout.

const winPaths = serve
  .desktopAppCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } })
  .map((c) => c.exe);
assert.deepStrictEqual(
  winPaths,
  ['C:\\Users\\me\\AppData\\Local\\Programs\\Coalesce\\Coalesce.exe'],
  'the per-user NSIS install is where electron-builder puts it by default',
);
assert.deepStrictEqual(
  serve.desktopAppCandidates({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' } })[0],
  { exe: 'C:\\Program Files\\Coalesce\\Coalesce.exe', resources: 'C:\\Program Files\\Coalesce\\resources' },
  'an install-for-everyone is found too',
);
assert.deepStrictEqual(
  serve.desktopAppCandidates({ platform: 'darwin', home: '/Users/me' }).map((c) => c.exe),
  ['/Applications/Coalesce.app/Contents/MacOS/Coalesce', '/Users/me/Applications/Coalesce.app/Contents/MacOS/Coalesce'],
  'macOS looks in both Applications folders',
);
assert.deepStrictEqual(serve.desktopAppCandidates({ platform: 'linux' }), [], 'Desktop does not ship for Linux');

// --------------------------------------------------- the app's own copy of coa
// The shim only exists while Desktop runs, so this is the path that makes the
// app usable by someone who never installed the CLI.

// `roots` keeps this off whatever is really installed on the test machine.
const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coaapp-'));
const bundle = path.join(appRoot, 'Coalesce.app', 'Contents');
const asMac = { platform: 'darwin', roots: [appRoot] };

assert.strictEqual(serve.desktopAppLauncher(asMac), null, 'no app, no launcher');

fs.mkdirSync(path.join(bundle, 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(bundle, 'Resources', 'coa', 'web-ui'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'MacOS', 'Coalesce'), '', { mode: 0o755 });
assert.strictEqual(serve.desktopAppLauncher(asMac), null, 'an app with no bundled coa.js is not a launcher');

fs.writeFileSync(path.join(bundle, 'Resources', 'coa', 'coa.js'), '#!/usr/bin/env node\n');
const appCoa = serve.desktopAppLauncher(asMac);
assert.deepStrictEqual(
  { command: appCoa.command, args: appCoa.args, env: appCoa.env, desktop: appCoa.desktop },
  {
    command: path.join(bundle, 'MacOS', 'Coalesce'),
    args: [path.join(bundle, 'Resources', 'coa', 'coa.js')],
    // Electron is only a Node if you tell it to be, and the app ships no other.
    env: { ELECTRON_RUN_AS_NODE: '1' },
    desktop: true,
  },
  "runs the app's CLI the way the app's own shim does",
);
assert.strictEqual(appCoa.uiPath, null, 'an app with no index.html has no UI to point at');

fs.writeFileSync(path.join(bundle, 'Resources', 'coa', 'web-ui', 'index.html'), '<!DOCTYPE html>');
const withUi = serve.desktopAppLauncher(asMac);
assert.strictEqual(withUi.uiPath, path.join(bundle, 'Resources', 'coa', 'web-ui'), 'serves the UI the app carries');
assert.strictEqual(
  serve.serveEnv(withUi, {})[serve.UI_PATH_ENV],
  path.join(bundle, 'Resources', 'coa', 'web-ui'),
  'and that is what coa serve is told to serve',
);
assert.strictEqual(serve.serveEnv(withUi, {}).ELECTRON_RUN_AS_NODE, '1', 'serve keeps the env the launcher needs');
assert.strictEqual(
  serve.describeCoa(withUi),
  `${path.join(bundle, 'MacOS', 'Coalesce')} ${path.join(bundle, 'Resources', 'coa', 'coa.js')}`,
  'logs and errors name the whole command, not just the binary',
);

// ------------------------------------------------------------------ resolveCoa

assert.strictEqual(serve.resolveCoa({ coaPath: '/usr/local/bin/coa' }).command, '/usr/local/bin/coa', 'a path wins');
assert.strictEqual(
  serve.resolveCoa({ coaPath: '/usr/local/bin/coa', source: 'desktop' }).command,
  '/usr/local/bin/coa',
  'an explicit path overrides the source setting rather than fighting it',
);
assert.strictEqual(serve.resolveCoa({ source: 'path' }).command, 'coa', '`path` never reaches for Desktop');
assert.strictEqual(serve.resolveCoa({ source: 'path' }).desktop, false, 'and is not treated as Desktop');

// The shim installed above is still in the scratch home, so it wins auto-detection.
assert.strictEqual(serve.resolveCoa({}).command, shim, 'a running Desktop is preferred: its build matches the app');
assert.strictEqual(serve.resolveCoa({ source: 'desktop' }).command, shim, 'and `desktop` takes it too');

fs.rmSync(path.join(desktop, path.basename(shim)));
const noDesktop = serve.resolveCoa({ source: 'desktop' }, { platform: 'linux' });
assert.ok(noDesktop.missing, 'asking for Desktop where there is none says so');
assert.ok(noDesktop.missing.includes('coalesceServe.coaSource'), 'and names the setting to change');

// ------------------------------------------------------------------- windows
// These run on every host: the helpers are pure, and the Windows-only spawn
// path is the one nobody developing on a Mac would otherwise exercise.

assert.strictEqual(serve.quoteForCmd('serve'), 'serve', 'a plain argument is left bare');
assert.strictEqual(serve.quoteForCmd(''), '""', 'an empty argument still needs to be an argument');
assert.strictEqual(serve.quoteForCmd('C:\\R&D\\repo'), '"C:\\R&D\\repo"', 'quotes neutralise cmd metacharacters');
assert.strictEqual(serve.quoteForCmd('C:\\my repo\\'), '"C:\\my repo\\\\"', 'a trailing backslash is doubled');
assert.strictEqual(serve.quoteForCmd('say "hi"'), '"say \\"hi\\""', 'embedded quotes are escaped');

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coabin-'));
fs.writeFileSync(path.join(binDir, 'coa.cmd'), '@echo off\n', { mode: 0o755 });
// Lower-case PATHEXT so the lookup is the same on a case-sensitive filesystem.
const winEnv = { PATH: binDir, PATHEXT: '.exe;.cmd' };

assert.strictEqual(
  serve.resolveWindowsExecutable('coa', winEnv),
  path.join(binDir, 'coa.cmd'),
  'a bare `coa` on PATH resolves to the .cmd shim CreateProcess would miss',
);
assert.strictEqual(
  serve.resolveWindowsExecutable(path.join(binDir, 'coa'), winEnv),
  path.join(binDir, 'coa.cmd'),
  'an extensionless explicit path gets the same treatment',
);
assert.strictEqual(
  serve.resolveWindowsExecutable(path.join(binDir, 'coa.cmd'), winEnv),
  path.join(binDir, 'coa.cmd'),
  'a spelled-out path is taken as given',
);
assert.strictEqual(serve.resolveWindowsExecutable('nope', winEnv), null, 'nothing on PATH, nothing resolved');
fs.rmSync(binDir, { recursive: true, force: true });

fs.rmSync(home, { recursive: true, force: true });
console.log('all assertions passed');

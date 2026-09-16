// Everything in here is plain Node with no `vscode` import, so it can be
// exercised from a normal `node` process (see test/serve.test.js).
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { WINDOWS, samePath } = require('./fsutil');

const READY_RE = /COA_SERVE_READY\s+(\{.*?\})\s*$/m;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const DEFAULT_TIMEOUT_MS = 180_000; // the first run may download the UI bundle

const DESKTOP_DIR = path.join(os.homedir(), '.coalesce', 'desktop');
const UI_PATH_ENV = 'COALESCE_UI_PATH';

/**
 * Coalesce Desktop is an Electron app, and Electron run with this set is a
 * plain Node — which is how the app runs its own bundled `coa.js`, and the only
 * way to run it without a separate Node on PATH.
 */
const DESKTOP_APP_ENV = { ELECTRON_RUN_AS_NODE: '1' };

const DESKTOP_MISSING =
  'Coalesce Desktop was not found. Install the app, or set `coalesceServe.coaSource` back to `auto`.';

// The CLI's own one-line complaints, most user-facing first.
const SERVE_FAILED_RE = /^\s*[✖x]\s*Serve failed:\s*(.+)$/gm;
const CLI_ERROR_RE = /\|error:(?:\[[^\]]*\])?\s*(.+)$/gm;
// Both mean the same thing: this build has no UI to serve and none to download.
const UI_BUNDLE_MISSING_RE = /UI bundle was not found at \S+ \(HTTP \d+\)|No release version is baked into this CLI/;

/** Windows has no one spelling for an installed shim, so accept any of them. */
function desktopShimCandidates() {
  const base = path.join(DESKTOP_DIR, 'coa');
  return WINDOWS ? ['.cmd', '.exe', '.bat', ''].map((ext) => base + ext) : [base];
}

/** Where Coalesce Desktop installs its `coa`; on Windows, the variant that is there. */
function desktopShimPath() {
  const candidates = desktopShimCandidates();
  return candidates.find(isExecutableFile) || candidates[0];
}

function isDesktopShim(coa) {
  return !!coa && desktopShimCandidates().some((candidate) => samePath(coa, candidate));
}

/** X_OK is meaningless on Windows — every readable file "executes" — so just look for a file. */
function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (WINDOWS) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ the app's own CLI

/**
 * Where an installed Coalesce Desktop puts its Electron binary and its
 * resources. The app ships for macOS and Windows only, so anywhere else has
 * nothing to find.
 *
 * Windows is electron-builder's NSIS layout: per-user by default, per-machine
 * when someone installed it for everyone.
 *
 * `platform` and `roots` are parameters rather than reads of `process` so the
 * layout for one OS can be asserted from another.
 */
function desktopAppCandidates({ env = process.env, platform = process.platform, home = os.homedir(), roots } = {}) {
  if (platform === 'win32') {
    const local = envGet(env, 'LOCALAPPDATA');
    const dirs =
      roots ||
      [local && path.win32.join(local, 'Programs'), envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)')].filter(
        Boolean,
      );
    return dirs.map((root) => ({
      exe: path.win32.join(root, 'Coalesce', 'Coalesce.exe'),
      resources: path.win32.join(root, 'Coalesce', 'resources'),
    }));
  }
  if (platform === 'darwin') {
    return (roots || ['/Applications', path.posix.join(home, 'Applications')]).map((root) => ({
      exe: path.posix.join(root, 'Coalesce.app', 'Contents', 'MacOS', 'Coalesce'),
      resources: path.posix.join(root, 'Coalesce.app', 'Contents', 'Resources'),
    }));
  }
  return [];
}

/**
 * The CLI inside an installed Coalesce Desktop, invoked the way the app's own
 * shim invokes it: the app's Electron binary as the Node, its bundled `coa.js`
 * as the script.
 *
 * This is what makes the app usable by someone who cannot install the CLI
 * separately. It does not need Desktop to be running — unlike the shim, which
 * the app writes on launch and deletes again on quit.
 *
 * @returns {Launcher|null}
 */
function desktopAppLauncher(options = {}) {
  for (const { exe, resources } of desktopAppCandidates(options)) {
    const entry = path.join(resources, 'coa', 'coa.js');
    if (!isExecutableFile(exe) || !fs.existsSync(entry)) continue;
    const ui = path.join(resources, 'coa', 'web-ui');
    return {
      command: exe,
      args: [entry],
      env: { ...DESKTOP_APP_ENV },
      uiPath: fs.existsSync(path.join(ui, 'index.html')) ? ui : null,
      desktop: true,
    };
  }
  return null;
}

// -------------------------------------------------------------- resolving `coa`

/**
 * How to run `coa`: a program, the arguments that have to come before the
 * caller's, the environment it needs, and the UI directory to serve.
 *
 * @typedef {object} Launcher
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string,string>} env
 * @property {string|null} uiPath
 * @property {boolean} desktop  whether this is Coalesce Desktop's copy of the CLI
 * @property {string} [missing] why the configured source could not be honoured
 */

/** A plain executable: a path, or a bare name for the OS to resolve against PATH. */
function executableLauncher(coa) {
  return { command: coa, args: [], env: {}, uiPath: desktopUiPath(coa), desktop: isDesktopShim(coa) };
}

/** Accept either spelling, so a bare path still works wherever one is passed. */
function toLauncher(coa) {
  return typeof coa === 'string' ? executableLauncher(coa) : coa;
}

/** The command line as a human would type it — for logs and error messages. */
function describeCoa(coa) {
  const launcher = toLauncher(coa);
  return [launcher.command, ...launcher.args].join(' ');
}

/** The shim Desktop publishes while it runs, if it is there right now. */
function desktopShimLauncher() {
  const shim = desktopShimCandidates().find(isExecutableFile);
  return shim ? executableLauncher(shim) : null;
}

/** Desktop's CLI however we can reach it: the live shim first, else the installed app. */
function desktopLauncher(options = {}) {
  return desktopShimLauncher() || desktopAppLauncher(options);
}

const COA_SOURCES = ['auto', 'desktop', 'path'];

/**
 * Resolve how to run `coa`.
 *
 * `auto` keeps a working CLI working: the shim Desktop publishes while it is
 * running wins (its build matches the app being served), then `coa` from PATH,
 * and only when there is no CLI at all does it fall back to the copy inside an
 * installed Desktop. That last step is the point of the whole thing — it is
 * what lets someone who cannot install the CLI use the extension anyway —
 * but it must not quietly displace a `coa` the user installed on purpose.
 *
 * `coaPath` overrides every source; `desktop` and `path` pin one.
 *
 * @returns {Launcher} never null: an unreachable choice still returns something
 *   to spawn, so the failure is one clear ENOENT rather than a silent no-op.
 */
function resolveCoa({ coaPath = '', source = 'auto' } = {}, options = {}) {
  if (coaPath) return executableLauncher(coaPath);

  if (source === 'desktop') {
    const found = desktopLauncher(options);
    return found || { ...executableLauncher(desktopShimPath()), desktop: true, missing: DESKTOP_MISSING };
  }
  if (source === 'path') return executableLauncher('coa');

  const shim = desktopShimLauncher();
  if (shim) return shim;
  if (resolveOnPath('coa', options.env)) return executableLauncher('coa');
  // Nothing installed: the app's copy, or a bare `coa` so the error names it.
  return desktopAppLauncher(options) || executableLauncher('coa');
}

// ------------------------------------------------------------ spawning on win32

/** `process.env` is case-insensitive on Windows; a spread copy of it is not. */
function envGet(env, name) {
  if (env && env[name] !== undefined) return env[name];
  if (!WINDOWS || !env) return undefined;
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

const isBatchFile = (file) => /\.(cmd|bat)$/i.test(file);

/**
 * The file Windows would actually run for `cmd`.
 *
 * Node's shell-less spawn goes to CreateProcess, which appends `.exe` but never
 * `.cmd`, so a bare `coa` that is really `coa.cmd` dies with ENOENT unless the
 * PATHEXT walk happens here.
 *
 * @returns {string|null} the full path, or null when nothing matches.
 */
function resolveWindowsExecutable(cmd, env = process.env) {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const spellings = (base) =>
    exts.some((ext) => base.toLowerCase().endsWith(ext.toLowerCase()))
      ? [base]
      : [...exts.map((ext) => base + ext), base];

  if (path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return spellings(cmd).find(isExecutableFile) || null;

  for (const dir of (envGet(env, 'PATH') || '').split(path.delimiter)) {
    if (!dir) continue;
    const hit = spellings(path.join(dir.replace(/^"|"$/g, ''), cmd)).find(isExecutableFile);
    if (hit) return hit;
  }
  return null;
}

/**
 * The file this host would actually run for `cmd`, or null if nothing would.
 *
 * Asking before spawning is what lets auto-detection tell "no CLI installed"
 * apart from "the CLI is there", instead of finding out from an ENOENT.
 */
function resolveOnPath(cmd, env = process.env) {
  if (WINDOWS) return resolveWindowsExecutable(cmd, env);
  if (cmd.includes('/')) return isExecutableFile(cmd) ? cmd : null;
  for (const dir of (envGet(env, 'PATH') || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, cmd);
    if (isExecutableFile(file)) return file;
  }
  return null;
}

/**
 * Quote one argument for a `cmd.exe /s /c "…"` command line.
 *
 * The double quotes are what stop cmd.exe reading a shell metacharacter in a
 * path (`C:\R&D\repo`) as syntax; backslashes in front of the closing quote
 * have to be doubled or they escape it instead. `%VAR%` is still expanded
 * inside quotes and cmd.exe has no escape for it — a path containing `%` is
 * the one case this cannot carry through.
 */
function quoteForCmd(arg) {
  const value = String(arg);
  if (value === '') return '""';
  if (!/[\s"^&|<>()%!,;=]/.test(value)) return value;
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Spawn `coa` in a way that works on every host.
 *
 * On Windows `coa` is normally a `.cmd` shim, and since Node 20.12 spawning a
 * batch file without a shell throws EINVAL. `shell: true` would fix that but
 * hands cmd.exe the arguments unescaped, so resolve the file here and build the
 * command line with our own quoting instead.
 */
function spawnCoa(coa, args, options = {}) {
  const launcher = toLauncher(coa);
  const argv = [...launcher.args, ...args];
  // Leave `env` exactly as the caller left it — undefined means inherit — unless
  // the launcher has something of its own to add.
  const env = Object.keys(launcher.env).length ? { ...(options.env || process.env), ...launcher.env } : options.env;
  const base = { ...options, env, shell: false, windowsHide: true };
  if (!WINDOWS) return cp.spawn(launcher.command, argv, base);

  const resolved = resolveWindowsExecutable(launcher.command, env) || launcher.command;
  if (!isBatchFile(resolved)) return cp.spawn(resolved, argv, base);

  const line = [resolved, ...argv].map(quoteForCmd).join(' ');
  const comspec = envGet(options.env, 'ComSpec') || process.env.ComSpec || 'cmd.exe';
  // `/s` plus the wrapping quotes make cmd.exe take the rest of the line verbatim.
  return cp.spawn(comspec, ['/d', '/s', '/c', `"${line}"`], { ...base, windowsVerbatimArguments: true });
}

/**
 * Coalesce Desktop installs its shim on launch, and the CLI behind it is an
 * unreleased build (`0.0.0-ci`). Run standalone it tries to download a UI
 * bundle that was never published and dies on an HTTP 404 — which is why
 * `coa serve` breaks once Desktop has been started. The app carries the
 * matching UI next to its CLI entry point, so serve that instead.
 *
 * @returns {string|null} the app's bundled UI directory, or null if `coa` is
 *   not the Desktop shim or the app has no usable copy.
 */
function desktopUiPath(coa) {
  if (!isDesktopShim(coa)) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'agent.json'), 'utf8'))?.coa?.coaEntry;
  } catch {
    return null;
  }
  if (!entry) return null;
  const ui = path.join(path.dirname(entry), 'web-ui');
  return fs.existsSync(path.join(ui, 'index.html')) ? ui : null;
}

/** `process.env`, whatever the launcher needs, and the UI override Desktop's CLI needs to work at all. */
function serveEnv(coa, base = process.env) {
  const launcher = toLauncher(coa);
  const env = { ...base, ...launcher.env };
  if (envGet(base, UI_PATH_ENV)) return env; // the user knows better
  if (launcher.uiPath) env[UI_PATH_ENV] = launcher.uiPath;
  return env;
}

function lastMatch(re, text) {
  let last = null;
  for (const match of text.matchAll(re)) last = match;
  return last ? last[1].trim() : null;
}

/** The most specific thing `coa` said about why it gave up, if anything. */
function lastCliError(output) {
  return lastMatch(SERVE_FAILED_RE, output) ?? lastMatch(CLI_ERROR_RE, output);
}

/**
 * Turn an early exit into a message worth showing a human: the CLI's own
 * reason where it has one, and a way out for the Desktop-shim failure.
 */
function explainExit({ output = '', code, signal, coa }) {
  const detail = lastCliError(output.replace(ANSI_RE, ''));

  if (detail && UI_BUNDLE_MISSING_RE.test(detail)) {
    // The full story is in the log; the notification only needs the way out.
    return toLauncher(coa).desktop
      ? 'Coalesce Desktop may be interfering with the `coa` CLI. Try quitting Coalesce Desktop and starting again.'
      : 'This `coa` has no Coalesce UI to serve.';
  }

  const because = detail ? `: ${detail}` : ` (code ${code}, signal ${signal})`;
  return `\`coa serve\` exited before it was ready${because}`;
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    // A host this machine cannot bind at all (IPv6 switched off) is not a clash.
    server.once('error', (err) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Windows resolves `localhost` to ::1 ahead of 127.0.0.1, so a port held on
 * only one of the two stacks still has to count as taken.
 */
async function isPortFree(port) {
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::1'));
}

async function findFreePort(preferred, span = 50) {
  for (let port = preferred; port < preferred + span; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${preferred}-${preferred + span - 1}`);
}

/**
 * Spawn `coa serve --no-open` and resolve once it prints its COA_SERVE_READY
 * line, which carries the URL including the auth nonce.
 *
 * Returns the child immediately plus a promise for the parsed readiness
 * payload, so the caller can cancel by killing the child.
 *
 * @returns {{ proc: import('child_process').ChildProcess, ready: Promise<{url: string, port: number, nonce?: string}> }}
 */
function startServe({ coa, dir, port, onOutput, onExit, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = ['--no-color', 'serve', '--no-open', '--port', String(port), '--dir', dir];
  const env = serveEnv(coa);
  onOutput?.(`$ ${describeCoa(coa)} ${args.join(' ')}\n  (cwd: ${dir})\n`);
  if (envGet(env, UI_PATH_ENV) !== envGet(process.env, UI_PATH_ENV)) {
    onOutput?.(`  (${UI_PATH_ENV}: ${envGet(env, UI_PATH_ENV)} — Coalesce Desktop's CLI has no downloadable UI bundle)\n`);
  }

  const proc = spawnCoa(coa, args, { cwd: dir, env });

  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`\`coa serve\` did not report readiness within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );

    const onData = (chunk) => {
      const text = chunk.toString();
      onOutput?.(text);
      buffer += text.replace(ANSI_RE, '');
      const match = buffer.match(READY_RE);
      if (!match) return;
      try {
        finish(resolve, JSON.parse(match[1]));
      } catch (err) {
        finish(reject, new Error(`Could not parse COA_SERVE_READY: ${err.message}`));
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code, signal) => {
      finish(reject, new Error(explainExit({ output: buffer, code, signal, coa })));
      onExit?.(code, signal);
    });
  });

  return { proc, ready };
}

function killTree(proc) {
  if (!proc || proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  if (WINDOWS) {
    // SIGTERM does not reach the node process behind the .cmd shim on Windows,
    // and with cmd.exe wrapping it there is a whole tree to take down.
    const killer = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => proc.kill()); // no taskkill on PATH — best effort
    return;
  }
  const pid = proc.pid;
  proc.kill('SIGTERM');
  setTimeout(() => {
    try {
      process.kill(pid, 0); // still alive?
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref?.();
}

module.exports = {
  READY_RE,
  ANSI_RE,
  DEFAULT_TIMEOUT_MS,
  UI_PATH_ENV,
  DESKTOP_MISSING,
  COA_SOURCES,
  resolveCoa,
  describeCoa,
  toLauncher,
  desktopAppCandidates,
  desktopAppLauncher,
  desktopLauncher,
  desktopShimPath,
  desktopShimCandidates,
  isDesktopShim,
  isExecutableFile,
  resolveOnPath,
  resolveWindowsExecutable,
  quoteForCmd,
  spawnCoa,
  desktopUiPath,
  serveEnv,
  lastCliError,
  explainExit,
  isPortFree,
  findFreePort,
  startServe,
  killTree,
};

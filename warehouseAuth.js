/**
 * Snowflake OAuth sign-in: the cached-token state the profile form shows, and
 * the two `coa auth warehouse` commands behind its button.
 *
 * Plain Node with no `vscode` import, so it can be exercised from a normal
 * `node` process — see test/warehouseAuth.test.js.
 */
const fs = require('fs');
const path = require('path');

const { spawnCoa, killTree, lastCliError, ANSI_RE } = require('./serve');

const TOKEN_CACHE_FILE = 'snowflake-oauth-tokens.json';
/** The driver namespaces every cached token; these two are the OAuth pair. */
const OAUTH_KEY_RE = /^SnowflakeTokenCache\.v\d+\.Oauth(Access|Refresh)Token\./i;
/** `coa` gives the browser five minutes, so give the process a little more. */
const LOGIN_TIMEOUT_MS = 330_000;
const LOGOUT_TIMEOUT_MS = 30_000;

/** `coa` caches the tokens beside the config file it read the profile from. */
function tokenCachePath(configPath) {
  return path.join(path.dirname(configPath), TOKEN_CACHE_FILE);
}

/**
 * Whether `coa` holds cached warehouse tokens.
 *
 * Presence of the file is not on its own a sign-in: `coa auth warehouse logout`
 * can rewrite the cache without the token keys rather than unlinking it, so the
 * OAuth entries have to still be in there.
 *
 * One cache serves every profile — the driver keys it by account and user, not
 * by profile name — so this answers "signed in to a warehouse", not "signed in
 * to this profile". The form says as much.
 */
function hasCachedLogin(configPath) {
  try {
    const cache = JSON.parse(fs.readFileSync(tokenCachePath(configPath), 'utf8'));
    return !!cache && typeof cache === 'object' && Object.keys(cache).some((key) => OAUTH_KEY_RE.test(key));
  } catch {
    return false; // missing, unreadable or not JSON — nothing usable cached
  }
}

/**
 * The JSON body of a `--json` run, which `coa` may pretty-print among other
 * lines. @returns {object|null}
 */
function parseJsonResult(output) {
  const text = output.trim();
  const inner = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  for (const candidate of [text, inner]) {
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* not the JSON we are after */
    }
  }
  return null;
}

/** The most specific reason the run gave, preferring its structured errors. */
function failureMessage(output, code) {
  const json = parseJsonResult(output);
  const structured = json?.errors?.[0]?.message || json?.error || json?.message;
  return structured || lastCliError(output) || `\`coa auth warehouse\` exited with code ${code}.`;
}

/** `--profile` overrides the workspace's own choice, so it alone decides who signs in. */
function loginArgs(profile, dir) {
  return ['--no-color', 'auth', 'warehouse', 'login', ...(dir ? ['--dir', dir] : []), '--profile', profile, '--json'];
}

function logoutArgs() {
  return ['--no-color', 'auth', 'warehouse', 'logout', '--json'];
}

/**
 * Run one `coa auth warehouse` command.
 *
 * Returns the child alongside the promise so a caller can cancel by killing it
 * — sign-in blocks until the browser comes back, which can be minutes.
 *
 * @returns {{ proc: import('child_process').ChildProcess, done: Promise<object|null> }}
 *   `done` resolves with the parsed `--json` body, or rejects with the CLI's reason.
 */
function runAuth({ coa, args, cwd, timeoutMs = LOGIN_TIMEOUT_MS }) {
  const proc = spawnCoa(coa, args, { cwd, env: process.env });

  const done = new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      killTree(proc);
      finish(reject, new Error(`Sign-in did not finish within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString().replace(ANSI_RE, '');
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code) => {
      if (code === 0) finish(resolve, parseJsonResult(output));
      else finish(reject, new Error(failureMessage(output, code)));
    });
  });

  return { proc, done };
}

module.exports = {
  TOKEN_CACHE_FILE,
  OAUTH_KEY_RE,
  LOGIN_TIMEOUT_MS,
  LOGOUT_TIMEOUT_MS,
  tokenCachePath,
  hasCachedLogin,
  parseJsonResult,
  failureMessage,
  loginArgs,
  logoutArgs,
  runAuth,
};

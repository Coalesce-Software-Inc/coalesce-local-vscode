/**
 * Unit tests for the Snowflake OAuth sign-in state. No vscode, no `coa`:
 *
 *   node test/warehouseAuth.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auth = require('../warehouseAuth');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A config dir holding the given token cache, or none at all. */
function withCache(cache) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coaauth-'));
  const configPath = path.join(dir, 'config');
  fs.writeFileSync(configPath, '[default]\n');
  if (cache !== undefined) fs.writeFileSync(auth.tokenCachePath(configPath), JSON.stringify(cache));
  return { dir, configPath };
}

const KEY = 'SnowflakeTokenCache.v2.OauthRefreshToken.0123456789abcdef0123456789abcdef01234567';

// -------------------------------------------------------------- cache location

test('the cache sits beside the config file it read the profile from', () => {
  assert.strictEqual(
    auth.tokenCachePath(path.join('/home/me', '.coa', 'config')),
    path.join('/home/me', '.coa', 'snowflake-oauth-tokens.json'),
  );
});

// ----------------------------------------------------------------- sign-in state

test('cached OAuth tokens count as signed in', () => {
  const { dir, configPath } = withCache({ [KEY]: 'token-body' });
  assert.strictEqual(auth.hasCachedLogin(configPath), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no cache file at all is signed out', () => {
  const { dir, configPath } = withCache(undefined);
  assert.strictEqual(auth.hasCachedLogin(configPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cache emptied by `coa auth warehouse logout` is signed out, not signed in', () => {
  // logout can rewrite the file without its token keys rather than unlinking
  // it, so mere existence is the wrong question to ask.
  const { dir, configPath } = withCache({});
  assert.strictEqual(auth.hasCachedLogin(configPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unrelated cached credentials are not a warehouse sign-in', () => {
  const { dir, configPath } = withCache({ 'SnowflakeTokenCache.v2.IdToken.abc': 'x' });
  assert.strictEqual(auth.hasCachedLogin(configPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt cache reads as signed out instead of throwing', () => {
  const { dir, configPath } = withCache(undefined);
  fs.writeFileSync(auth.tokenCachePath(configPath), 'not json at all');
  assert.strictEqual(auth.hasCachedLogin(configPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- arguments

test('login names the profile explicitly, since --profile overrides the workspace', () => {
  assert.deepStrictEqual(auth.loginArgs('my_sf_conn', '/repo'), [
    '--no-color', 'auth', 'warehouse', 'login', '--dir', '/repo', '--profile', 'my_sf_conn', '--json',
  ]);
});

test('login leaves --dir off when there is no workspace to point at', () => {
  assert.deepStrictEqual(auth.loginArgs('my_sf_conn', null), [
    '--no-color', 'auth', 'warehouse', 'login', '--profile', 'my_sf_conn', '--json',
  ]);
});

test('logout takes no profile — it clears the one shared cache', () => {
  assert.deepStrictEqual(auth.logoutArgs(), ['--no-color', 'auth', 'warehouse', 'logout', '--json']);
});

// ----------------------------------------------------------------- output parsing

test('reads the JSON body out of a run that also logged prose', () => {
  const output = 'Opening your browser…\n{"signedIn":true,"account":"xy12345","tokenCachePath":"/home/me/.coa/x.json"}\n';
  assert.strictEqual(auth.parseJsonResult(output).signedIn, true);
});

test('reads a pretty-printed JSON body', () => {
  assert.strictEqual(auth.parseJsonResult('note\n{\n  "signedIn": true\n}\n').signedIn, true);
});

test('output with no JSON at all is not an error', () => {
  assert.strictEqual(auth.parseJsonResult('nothing structured here'), null);
});

test('prefers the CLI\'s own reason for a failure', () => {
  const output = '{"success":false,"errors":[{"message":"Profile \\"x\\" has no snowflakeAccount"}]}';
  assert.strictEqual(auth.failureMessage(output, 1), 'Profile "x" has no snowflakeAccount');
});

test('falls back to the CLI error line, then to the exit code', () => {
  assert.strictEqual(auth.failureMessage('|error: invalid_grant\n', 1), 'invalid_grant');
  assert.ok(auth.failureMessage('', 3).includes('code 3'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

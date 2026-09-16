/**
 * Unit tests for the ~/.coa/config model. No vscode, no real config file:
 *
 *   node test/coaconfig.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../coaconfig');
const { platformKindOf, authTypeOf, fieldsFor, usesSignIn, OAUTH_REDIRECT_EXAMPLE } = require('../platforms');

const SAMPLE = `# my coa config
[default]
snowflakeAccount=acct
snowflakeAuthType=Basic
snowflakePassword=pw
domain=https://demo.example.com
environmentID=65

[my_sf_conn]
snowflakeAccount=acct
snowflakeAuthType=Basic
snowflakePassword=pw
domain=https://demo.example.com
environmentID=65

[my_dbx_conn]
platformKind=Databricks
databricksAuthType=Token
databricksHost=https://dbc.example.com
databricksPath=/sql/1.0/warehouses/abc
databricksToken=dbtok
domain=https://sandbox.example.com
environmentID=12
`;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ parsing

test('round-trips an unmodified file byte for byte', () => {
  assert.strictEqual(cfg.serialize(cfg.parse(SAMPLE)), SAMPLE);
});

test('round-trips a CRLF file too, given the eol read() reports', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  assert.strictEqual(cfg.serialize(cfg.parse(crlf), '\r\n'), crlf);
  const sections = cfg.parse(crlf);
  cfg.upsertSection(sections, 'my_sf_conn', { snowflakeAccount: 'changed' });
  const out = cfg.serialize(sections, '\r\n');
  assert.ok(!/[^\r]\n/.test(out), 'every line ending stayed CRLF');
});

test('keeps comments and unknown lines outside the sections it rewrites', () => {
  const sections = cfg.parse(SAMPLE);
  cfg.upsertSection(sections, 'my_dbx_conn', { platformKind: 'Databricks', databricksHost: 'https://new.example.com' });
  const out = cfg.serialize(sections);
  assert.ok(out.startsWith('# my coa config\n'), 'preamble comment survives');
  assert.ok(out.includes('[my_sf_conn]\nsnowflakeAccount=acct'), 'untouched section survives verbatim');
  assert.ok(out.includes('databricksHost=https://new.example.com'));
  assert.ok(!out.includes('databricksToken=dbtok'), 'keys absent from the new entries are gone');
});

test('reads values containing = and : intact', () => {
  const sections = cfg.parse('[p]\nsnowflakeKeyPairKey=-----BEGIN KEY-----abc=def==\ndomain=https://x.example.com:8443\n');
  const entries = cfg.entriesOf(cfg.findSection(sections, 'p'));
  assert.strictEqual(entries.snowflakeKeyPairKey, '-----BEGIN KEY-----abc=def==');
  assert.strictEqual(entries.domain, 'https://x.example.com:8443');
});

// ------------------------------------------------------------------ quoting

test('unquotes a value `coa` wrote as a JSON literal', () => {
  const sections = cfg.parse('[oauth]\nsnowflakeOAuthClientID="AbC123+dEf456/ghI789="\n');
  const entries = cfg.entriesOf(cfg.findSection(sections, 'oauth'));
  assert.strictEqual(entries.snowflakeOAuthClientID, 'AbC123+dEf456/ghI789=');
});

test('quotes on write exactly when `ini` would, so `coa` reads back what was typed', () => {
  // A base64 client secret ends in '=', which unquoted would be ambiguous.
  assert.strictEqual(cfg.encodeValue('Zm9vYmFyL2Jheit0ZXN0+PQ='), '"Zm9vYmFyL2Jheit0ZXN0+PQ="');
  assert.strictEqual(cfg.encodeValue('http://localhost:8080'), 'http://localhost:8080');
  assert.strictEqual(cfg.encodeValue('COMPUTE_WH'), 'COMPUTE_WH');
  assert.strictEqual(cfg.encodeValue(' padded '), '" padded "');
  assert.strictEqual(cfg.encodeValue('a#b;c'), 'a\\#b\\;c', 'a comment character cannot be left bare');
});

test('every value survives a write/read round trip', () => {
  for (const value of ['AbC123+dEf456/ghI789=', 'plain', 'a#b;c', ' padded ', '-----BEGIN KEY-----\nabc=\n', '"quoted"']) {
    const sections = cfg.parse('');
    cfg.upsertSection(sections, 'p', { k: value });
    const back = cfg.entriesOf(cfg.findSection(cfg.parse(cfg.serialize(sections)), 'p'));
    assert.strictEqual(back.k, value, `round trip of ${JSON.stringify(value)}`);
  }
});

test('an OAuth profile edited in the form writes back unchanged', () => {
  const original = [
    '[my_sf_conn]',
    'snowflakeAccount=xy12345',
    'snowflakeAuthType=OAuth',
    'snowflakeUsername=jdoe',
    'snowflakeOAuthClientID="AbC123+dEf456/ghI789="',
    'snowflakeOAuthRedirectUri=http://localhost:8080',
    '',
  ].join('\n');
  const sections = cfg.parse(original);
  const entries = cfg.entriesOf(cfg.findSection(sections, 'my_sf_conn'));
  cfg.upsertSection(sections, 'my_sf_conn', cfg.applyFields(entries, entries));
  assert.strictEqual(cfg.serialize(sections), original, 'no quote drift from opening and saving');
});

// ---------------------------------------------------------------- listing

test('listProfiles reports platform and excludes default', () => {
  const list = cfg.listProfiles(cfg.parse(SAMPLE));
  assert.deepStrictEqual(list.map((p) => p.name), ['my_sf_conn', 'my_dbx_conn']);
  assert.deepStrictEqual(list.map((p) => p.platformKind), ['Snowflake', 'Databricks']);
  assert.deepStrictEqual(list.map((p) => p.active), [false, false], 'nothing is active without a workspace');
});

test('the active flag comes from the name workspace.yml selects, not from [default]', () => {
  const list = cfg.listProfiles(cfg.parse(SAMPLE), 'my_dbx_conn');
  assert.deepStrictEqual(list.map((p) => p.active), [false, true]);
});

test('editing a named profile leaves [default] alone', () => {
  const sections = cfg.parse(SAMPLE);
  cfg.upsertSection(sections, 'my_sf_conn', { snowflakeAccount: 'changed' });
  cfg.deleteProfile(sections, 'my_dbx_conn');
  assert.strictEqual(cfg.entriesOf(cfg.findSection(sections, 'default')).snowflakeAccount, 'acct');
});

test('[default] is editable in its own right — the sidebar falls back to it', () => {
  const sections = cfg.parse(SAMPLE);
  const entries = cfg.entriesOf(cfg.findSection(sections, 'default'));
  cfg.upsertSection(sections, 'default', { ...entries, token: 'rotated' });
  assert.strictEqual(cfg.entriesOf(cfg.findSection(sections, 'default')).token, 'rotated');
  assert.deepStrictEqual(cfg.listProfiles(sections).map((p) => p.name), ['my_sf_conn', 'my_dbx_conn'], 'still not a profile');
});

// --------------------------------------------------------------- form merge

test('switching platform drops the previous platform keys but keeps cloud keys', () => {
  const existing = cfg.entriesOf(cfg.findSection(cfg.parse(SAMPLE), 'my_sf_conn'));
  const merged = cfg.applyFields(existing, {
    platformKind: 'Databricks',
    databricksAuthType: 'Token',
    databricksHost: 'https://dbc.example.com',
    databricksPath: '/sql/1.0/warehouses/abc',
    databricksToken: 'tok',
    domain: 'https://demo.example.com',
    environmentID: '65',
  });
  assert.ok(!('snowflakeAccount' in merged) && !('snowflakePassword' in merged), 'snowflake keys dropped');
  assert.strictEqual(merged.databricksHost, 'https://dbc.example.com');
  assert.strictEqual(merged.environmentID, '65');
});

test('an empty value removes the key', () => {
  const merged = cfg.applyFields({ snowflakeRole: 'SYSADMIN', domain: 'x' }, { snowflakeRole: '', domain: 'y' });
  assert.ok(!('snowflakeRole' in merged));
  assert.strictEqual(merged.domain, 'y');
});

test('a blank secret keeps the stored value (the rule the form relies on)', () => {
  const existing = { databricksToken: 'keepme', databricksHost: 'https://dbc.example.com', platformKind: 'Databricks' };
  const submitted = { platformKind: 'Databricks', databricksAuthType: 'Token', databricksHost: 'https://dbc.example.com' };
  for (const field of fieldsFor('Databricks', 'Token')) {
    if (field.secret && !(field.key in submitted) && existing[field.key]) submitted[field.key] = existing[field.key];
  }
  assert.strictEqual(cfg.applyFields(existing, submitted).databricksToken, 'keepme');
});

// ---------------------------------------------------------------- platforms

test('infers the platform of a legacy Snowflake profile with no platformKind', () => {
  assert.strictEqual(platformKindOf({ snowflakeAccount: 'a' }), 'Snowflake');
  assert.strictEqual(platformKindOf({ databricksHost: 'h' }), 'Databricks');
  assert.strictEqual(platformKindOf({ bigQueryServiceAccountKey: 'k' }), 'BigQuery');
  assert.strictEqual(platformKindOf({}), 'Snowflake');
});

test('falls back to the first auth type when the stored one is unknown', () => {
  assert.strictEqual(authTypeOf({ snowflakeAuthType: 'KeyPair' }, 'Snowflake'), 'KeyPair');
  assert.strictEqual(authTypeOf({ snowflakeAuthType: 'Nonsense' }, 'Snowflake'), 'Basic');
});

test('recognises a Snowflake OAuth profile and offers its client fields', () => {
  assert.strictEqual(authTypeOf({ snowflakeAuthType: 'OAuth' }, 'Snowflake'), 'OAuth');
  const keys = fieldsFor('Snowflake', 'OAuth').map((f) => f.key);
  assert.ok(keys.includes('snowflakeOAuthClientID') && keys.includes('snowflakeOAuthClientSecret'));
  assert.ok(keys.includes('snowflakeOAuthRedirectUri'));
  assert.ok(
    !fieldsFor('Snowflake', 'OAuth').some((f) => f.key === 'snowflakePassword' || f.key === 'snowflakeKeyPairKey'),
    'OAuth stores no credential of its own',
  );
});

test('the three OAuth client fields are optional and default to nothing', () => {
  // They only apply to a custom security integration, so an untouched form must
  // write none of them — empty means Snowflake's built-in OAuth.
  const oauth = fieldsFor('Snowflake', 'OAuth');
  for (const key of ['snowflakeOAuthClientID', 'snowflakeOAuthClientSecret', 'snowflakeOAuthRedirectUri']) {
    const field = oauth.find((f) => f.key === key);
    assert.ok(!field.required, `${key} is optional`);
    assert.strictEqual(field.default, undefined, `${key} writes no value of its own`);
  }
  const redirect = oauth.find((f) => f.key === 'snowflakeOAuthRedirectUri');
  assert.strictEqual(redirect.placeholder, OAUTH_REDIRECT_EXAMPLE, 'the loopback URL is only an example');
  assert.strictEqual(
    oauth.find((f) => f.key === 'snowflakeOAuthClientSecret').secret,
    true,
    'the client secret is masked like every other credential',
  );
});

test('an OAuth profile with no client settings saves none of those keys', () => {
  const merged = cfg.applyFields({}, {
    platformKind: 'Snowflake',
    snowflakeAuthType: 'OAuth',
    snowflakeAccount: 'acct',
    snowflakeUsername: 'me',
  });
  assert.deepStrictEqual(Object.keys(merged).sort(), [
    'platformKind', 'snowflakeAccount', 'snowflakeAuthType', 'snowflakeUsername',
  ]);
});

test('only OAuth asks for a browser sign-in', () => {
  assert.strictEqual(usesSignIn('Snowflake', 'OAuth'), true);
  assert.strictEqual(usesSignIn('Snowflake', 'KeyPair'), false);
  assert.strictEqual(usesSignIn('Databricks', 'OAuthM2M'), false, 'M2M needs no browser');
});

test('switching Snowflake auth away from OAuth drops the client keys', () => {
  const existing = {
    snowflakeAccount: 'acct',
    snowflakeAuthType: 'OAuth',
    snowflakeOAuthClientID: 'cid',
    snowflakeOAuthClientSecret: 'sec',
    snowflakeOAuthRedirectUri: 'http://localhost:8080',
    domain: 'https://demo.example.com',
  };
  const merged = cfg.applyFields(existing, {
    platformKind: 'Snowflake',
    snowflakeAuthType: 'Basic',
    snowflakeAccount: 'acct',
    snowflakeUsername: 'me',
    snowflakePassword: 'pw',
    domain: 'https://demo.example.com',
  });
  for (const key of ['snowflakeOAuthClientID', 'snowflakeOAuthClientSecret', 'snowflakeOAuthRedirectUri']) {
    assert.ok(!(key in merged), `${key} dropped`);
  }
  assert.strictEqual(merged.domain, 'https://demo.example.com', 'cloud keys survive');
});

// --------------------------------------------------------------------- i/o

test('writes atomically at mode 0600 and backs up the previous file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coacfg-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, SAMPLE, { mode: 0o600 });

  const { sections, eol } = cfg.read(file);
  cfg.upsertSection(sections, 'my_dbx_conn', { platformKind: 'Databricks', databricksToken: 'rotated' });
  const backupPath = cfg.backup(file);
  cfg.write(file, sections, eol);

  // Windows has no POSIX mode; chmod there only toggles the read-only bit.
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'config stays owner-only');
    assert.strictEqual(fs.statSync(backupPath).mode & 0o777, 0o600, 'backup is owner-only too');
  }
  assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), SAMPLE, 'backup holds the pre-write content');
  assert.strictEqual(cfg.entriesOf(cfg.findSection(cfg.read(file).sections, 'my_dbx_conn')).databricksToken, 'rotated');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp.')), 'no temp file left behind');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps at most 10 backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coacfg-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, SAMPLE, { mode: 0o600 });
  for (let i = 0; i < 14; i++) {
    fs.writeFileSync(file, `${SAMPLE}# run ${i}\n`, { mode: 0o600 });
    cfg.backup(file);
  }
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  assert.strictEqual(backups.length, 10, `expected 10 backups, found ${backups.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reading a missing file yields an empty, writable model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coacfg-'));
  const file = path.join(dir, 'nested', 'config');
  const { sections, existed } = cfg.read(file);
  assert.strictEqual(existed, false);
  assert.deepStrictEqual(cfg.namedProfiles(sections), []);
  cfg.upsertSection(sections, 'first', { platformKind: 'BigQuery', bigQueryServiceAccountKey: '/k.json' });
  cfg.write(file, sections);
  assert.strictEqual(cfg.listProfiles(cfg.read(file).sections)[0].platformKind, 'BigQuery');
  fs.rmSync(dir, { recursive: true, force: true });
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

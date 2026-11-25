/**
 * Checks for the theme proxy against a stand-in for `coa serve`:
 *
 *   node test/themeProxy.test.js
 *
 * The stand-in serves an index.html shaped like the real one (an inline script
 * that reads `coalesce-theme` first thing in <head>, unless `window.coalesceDesktop` is set), a script asset, and a
 * WebSocket-style upgrade that echoes.
 */
const assert = require('assert');
const http = require('http');
const net = require('net');
const { MESSAGE_TYPE, hostTheme, themeScript, injectThemeScript, startThemeProxy } = require('../themeProxy');

const INDEX =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <base href="/" />\n' +
  '    <script>var preference = localStorage.getItem("coalesce-theme");</script>\n  </head>\n  <body></body>\n</html>\n';

// ------------------------------------------------------------- the script

const script = themeScript('dark', 'darwin');
assert.ok(script.endsWith(`)("dark","${MESSAGE_TYPE}","darwin")</script>`), 'carries the scheme, message type and platform');
assert.ok(script.includes("'coalesceDesktop'"), 'claims the host, as Desktop\'s preload does');
assert.strictEqual(script.match(/<\/script>/g).length, 1, 'one script element');

// Run the script against a stand-in window, the way the page would.
function fakeWindow({ systemDark = false } = {}) {
  const systemList = new EventTarget();
  Object.defineProperty(systemList, 'matches', { get: () => systemDark });
  const listeners = [];
  const win = {
    matchMedia: (q) => (q === '(prefers-color-scheme: dark)' ? systemList : { media: q, matches: false, real: true }),
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    parent: {},
  };
  const post = (data, source = win.parent) => listeners.forEach((fn) => fn({ data, source }));
  const setSystem = (dark) => {
    systemDark = dark;
    systemList.dispatchEvent(new Event('change'));
  };
  return { win, post, setSystem };
}
function run(theme, opts) {
  const fake = fakeWindow(opts);
  const { win } = fake;
  new Function('window', 'addEventListener', 'parent', 'MediaQueryListEvent', `(${hostTheme})(${JSON.stringify(theme)},"${MESSAGE_TYPE}","test")`)(
    win, win.addEventListener, win.parent, undefined,
  );
  return fake;
}

{
  const { win, post } = run('dark');
  assert.deepStrictEqual({ ...win.coalesceDesktop }, { isDesktop: true, platform: 'test' }, 'the UI sees a host');
  const dark = win.matchMedia('(prefers-color-scheme: dark)');
  const light = win.matchMedia('( prefers-color-scheme : LIGHT )');
  assert.strictEqual(dark.matches, true, 'dark answers the dark query');
  assert.strictEqual(light.matches, false, 'and not the light one');
  assert.strictEqual(win.matchMedia('(prefers-color-scheme: dark)'), dark, 'one list per query, not one per call');
  assert.strictEqual(win.matchMedia('(min-width: 1px)').real, true, 'other queries go to the real matchMedia');

  const events = [];
  dark.addEventListener('change', () => events.push('listener'));
  dark.addListener(() => events.push('addListener'));
  dark.onchange = () => events.push('onchange');
  post({ type: MESSAGE_TYPE, theme: 'dark' });
  assert.deepStrictEqual(events, [], 'the scheme already shown fires nothing');
  post({ type: MESSAGE_TYPE, theme: 'light' }, {});
  assert.deepStrictEqual(events, [], 'messages from anyone but the frame parent are ignored');
  post({ type: 'other', theme: 'light' });
  post({ type: MESSAGE_TYPE, theme: 'purple' });
  assert.strictEqual(dark.matches, true, 'unknown messages and schemes are ignored');
  post({ type: MESSAGE_TYPE, theme: 'light' });
  assert.strictEqual(dark.matches, false, 'a message switches the scheme');
  assert.strictEqual(light.matches, true);
  assert.deepStrictEqual(events.sort(), ['addListener', 'listener', 'onchange'], 'every kind of listener hears it');
}

{
  const { win, post, setSystem } = run('system', { systemDark: true });
  const dark = win.matchMedia('(prefers-color-scheme: dark)');
  let changes = 0;
  dark.addEventListener('change', () => changes++);
  assert.strictEqual(dark.matches, true, 'system passes the real answer through');
  setSystem(false);
  assert.strictEqual(dark.matches, false, 'and follows it');
  assert.strictEqual(changes, 1, 'firing change when the system switches');
  post({ type: MESSAGE_TYPE, theme: 'dark' });
  setSystem(true);
  setSystem(false);
  assert.strictEqual(dark.matches, true, 'a fixed scheme ignores the system');
  assert.strictEqual(changes, 2);
}

const injected = injectThemeScript(INDEX, 'light');
assert.ok(
  injected.indexOf('("light",') < injected.indexOf('var preference'),
  'runs before the UI reads the key',
);
assert.ok(injected.includes('<head>' + themeScript('light')), 'sits right after <head>');
assert.ok(
  injectThemeScript('<html><head lang="x"><title>t</title></head></html>', 'dark').includes('<head lang="x"><script>'),
  'handles <head> with attributes',
);
assert.ok(!injectThemeScript('<header>', 'dark').startsWith('<header><script>'), '<header> is not <head>');

// --------------------------------------------------------------- the proxy

function request(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/' || req.url.startsWith('/nodes/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: 'W/"abc"', 'content-length': Buffer.byteLength(INDEX) });
      res.end(req.method === 'HEAD' ? undefined : INDEX);
    } else if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', etag: 'W/"js"' });
      res.end('console.log("<head>")');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    }
  });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d)); // echo
  });
  const target = await listen(upstream);

  let theme = 'dark';
  const proxy = await startThemeProxy({ port: 0, target, getTheme: () => theme });
  const page = { accept: 'text/html,application/xhtml+xml', 'if-none-match': 'W/"abc"', 'accept-encoding': 'gzip' };

  let { res, body } = await request(proxy.port, '/', page);
  assert.strictEqual(res.statusCode, 200, 'a cached page is fetched again, not answered 304');
  assert.ok(body.includes('("dark",'), 'page carries the current scheme');
  assert.strictEqual(Number(res.headers['content-length']), Buffer.byteLength(body), 'content-length matches the new body');
  assert.strictEqual(res.headers['cache-control'], 'no-store', 'the page is not cached with a stale scheme');
  assert.strictEqual(res.headers.etag, undefined, 'no validator for the browser to revalidate with');
  const forwarded = seen[seen.length - 1];
  assert.strictEqual(forwarded['if-none-match'], undefined, 'conditional headers are dropped');
  assert.strictEqual(forwarded['accept-encoding'], undefined, 'the page is fetched uncompressed');
  assert.strictEqual(forwarded.host, `127.0.0.1:${proxy.port}`, 'the Host header is passed through');

  theme = 'light';
  ({ body } = await request(proxy.port, '/nodes/abc', page));
  assert.ok(body.includes('("light",'), 'deep links get the scheme too, asked fresh each load');

  ({ res, body } = await request(proxy.port, '/', page, 'HEAD'));
  assert.strictEqual(body, '', 'HEAD gets no body');

  ({ body } = await request(proxy.port, '/', { accept: '*/*' }));
  assert.strictEqual(body, INDEX, 'index.html served to a script or worker fetch is left alone');

  ({ res, body } = await request(proxy.port, '/app.js', { 'if-none-match': 'W/"js"', 'accept-encoding': 'gzip' }));
  assert.strictEqual(body, 'console.log("<head>")', 'assets pass through untouched');
  assert.strictEqual(res.headers.etag, 'W/"js"', 'assets keep their caching headers');
  assert.strictEqual(seen[seen.length - 1]['accept-encoding'], 'gzip', 'assets keep their request headers');

  ({ res, body } = await request(proxy.port, '/missing'));
  assert.strictEqual(res.statusCode, 404, 'status codes pass through');

  const echoed = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    let text = '';
    socket.on('data', (d) => {
      text += d.toString();
      if (text.includes('\r\n\r\n') && !text.includes('ping')) socket.write('ping');
      if (text.includes('ping')) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on('error', reject);
  });
  assert.ok(echoed.startsWith('HTTP/1.1 101'), 'upgrades reach the server');
  assert.ok(echoed.endsWith('ping'), 'upgraded connections are piped both ways');

  proxy.close();
  upstream.close();
  await assert.rejects(request(proxy.port, '/'), 'close() frees the port');

  const dead = await startThemeProxy({ port: 0, target, getTheme: () => 'dark' });
  ({ res, body } = await request(dead.port, '/', page));
  assert.strictEqual(res.statusCode, 502, 'a server that is gone is a 502, not a hang');
  dead.close();

  console.log('all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

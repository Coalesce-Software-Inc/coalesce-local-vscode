/**
 * A pass-through proxy in front of `coa serve` that adds one script to the
 * page, so the extension can choose the UI's colour scheme.
 *
 * It does what Coalesce Desktop does. Desktop's preload exposes
 * `window.coalesceDesktop = { isDesktop: true, platform }`; the UI then treats
 * the scheme as the host's business (`isThemeHostControlled`), ignores the
 * user's saved and remembered preference, and paints `system`: whatever
 * `(prefers-color-scheme: dark)` says, following its `change` events. Desktop
 * steers that media query through Electron's `nativeTheme.themeSource` from
 * its View › Theme menu (Light, Dark, Match system).
 *
 * A webview has no `nativeTheme` to set, and the UI runs in an iframe on its
 * own `localhost` origin, out of the webview's reach. Serving the page through
 * this proxy reaches it: the added script sets the same flag and answers the
 * colour-scheme media query with the scheme the extension picks, firing
 * `change` when the webview posts a new one. The UI repaints in place, as it
 * does in Desktop; nothing reloads and nothing is written to its storage.
 *
 * The proxy listens on the port the user expects (`coalesceServe.port`), not a
 * random one: localStorage is per origin, port included, so a new port would
 * lose everything else the UI keeps there.
 */
const http = require('http');
const net = require('net');

/** The `type` of the message the webview forwards to the framed UI. */
const MESSAGE_TYPE = 'coalesce-local-ui.theme';
const THEMES = ['light', 'dark', 'system'];

/**
 * Runs in the page, ahead of the UI's own scripts. Serialised with
 * `toString()`, so it must not refer to anything outside itself.
 *
 * @param {'light' | 'dark' | 'system'} initial the scheme to paint; `system` passes the real media query through
 * @param {string} messageType the `type` of the webview's messages
 * @param {string} platform what Desktop reports as `process.platform`
 */
function hostTheme(initial, messageType, platform) {
  var want = initial;
  var realMatchMedia = window.matchMedia.bind(window);
  var system = realMatchMedia('(prefers-color-scheme: dark)');
  var pattern = /^\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*$/i;
  var lists = {};

  function isDark() {
    return want === 'system' ? system.matches : want === 'dark';
  }

  // One list per query, so the UI calling matchMedia on every render does not pile them up.
  function colourSchemeList(media, dark) {
    var key = dark ? 'dark' : 'light';
    if (lists[key]) return lists[key];
    var list = new EventTarget();
    var onchange = null;
    var matches = function () {
      return isDark() === dark;
    };
    var last = matches();
    Object.defineProperties(list, {
      media: { value: media },
      matches: { get: matches },
      onchange: {
        get: function () {
          return onchange;
        },
        set: function (fn) {
          onchange = typeof fn === 'function' ? fn : null;
        },
      },
      addListener: {
        value: function (fn) {
          list.addEventListener('change', fn);
        },
      },
      removeListener: {
        value: function (fn) {
          list.removeEventListener('change', fn);
        },
      },
      update: {
        value: function () {
          var now = matches();
          if (now === last) return;
          last = now;
          var event;
          try {
            event = new MediaQueryListEvent('change', { matches: now, media: media });
          } catch (e) {
            event = new Event('change');
          }
          if (onchange) onchange.call(list, event);
          list.dispatchEvent(event);
        },
      },
    });
    return (lists[key] = list);
  }

  function update() {
    for (var key in lists) lists[key].update();
  }

  Object.defineProperty(window, 'coalesceDesktop', {
    value: Object.freeze({ isDesktop: true, platform: platform }),
  });
  window.matchMedia = function (query) {
    var scheme = pattern.exec(String(query));
    return scheme ? colourSchemeList(String(query), scheme[1].toLowerCase() === 'dark') : realMatchMedia(query);
  };
  system.addEventListener('change', function () {
    if (want === 'system') update();
  });
  addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.type !== messageType) return;
    if (data.theme !== 'light' && data.theme !== 'dark' && data.theme !== 'system') return;
    want = data.theme;
    update();
  });
}

/** The script added to each HTML page. */
function themeScript(theme, platform = process.platform) {
  const args = [theme, MESSAGE_TYPE, platform].map((arg) => JSON.stringify(arg)).join(',');
  // `<\/` keeps a `</script>` in a string from ending the element early.
  return `<script>(${hostTheme.toString()})(${args})</script>`.replace(/<\/(?!script>$)/gi, '<\\/');
}

/** Add the theme script right after `<head>`, ahead of the UI's own inline script. */
function injectThemeScript(html, theme) {
  const script = themeScript(theme);
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return script + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + script + html.slice(at);
}

const isHtml = (headers) => /^text\/html\b/i.test(headers['content-type'] || '');

/**
 * Proxy `127.0.0.1:<port>` to `coa serve` on `127.0.0.1:<target>`, adding the
 * theme script to page loads. WebSocket upgrades are piped through as is.
 *
 * @param {{ port: number, target: number, getTheme: () => 'light' | 'dark' | 'system' }} options
 *   `getTheme` is asked on every page load, so a reload picks up a new choice.
 * @returns {Promise<{ port: number, close: () => void }>}
 */
function startThemeProxy({ port, target, getTheme }) {
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers };
    // Only page loads get the script: the UI's server answers any unknown path
    // with index.html, including script and service-worker fetches.
    const page = req.method === 'GET' && /text\/html/i.test(headers.accept || '');
    if (page) {
      // The script has to be spliced into plain text, and a cached page would
      // carry the scheme it was served with.
      delete headers['accept-encoding'];
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }

    const upstream = http.request(
      { host: '127.0.0.1', port: target, method: req.method, path: req.url, headers },
      (up) => {
        if (!page || !isHtml(up.headers) || up.headers['content-encoding']) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        const chunks = [];
        up.on('data', (chunk) => chunks.push(chunk));
        up.on('end', () => {
          const body = Buffer.from(injectThemeScript(Buffer.concat(chunks).toString('utf8'), getTheme()), 'utf8');
          const out = { ...up.headers, 'content-length': String(body.length), 'cache-control': 'no-store' };
          delete out.etag;
          delete out['last-modified'];
          delete out['transfer-encoding'];
          res.writeHead(up.statusCode ?? 502, out);
          res.end(body);
        });
        up.on('error', () => res.destroy());
      },
    );
    upstream.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`coa serve is not reachable: ${err.message}`);
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(target, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const close = () => {
    server.close();
    for (const socket of sockets) socket.destroy(); // keep-alive and WebSocket connections
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({ port: server.address().port, close });
    });
  });
}

module.exports = { MESSAGE_TYPE, THEMES, hostTheme, themeScript, injectThemeScript, startThemeProxy };

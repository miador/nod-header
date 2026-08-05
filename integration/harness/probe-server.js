/**
 * The other end of the wire.
 *
 * Every integration assertion in this suite is ultimately "did the header reach
 * a server?", so the server is the oracle. It records the headers of every
 * request verbatim and serves just enough content to provoke the resource types
 * the extension has to cover: a top-level document, a stylesheet, a script and
 * an XHR. Nothing is cached, so navigating to the same path twice really does
 * produce two records.
 *
 * Node built-ins only, like the rest of this repository.
 */
import { createServer } from 'node:http';

const HTML_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>flex probe</title>
<link rel="stylesheet" href="/probe.css">
<h1>flex probe</h1>
<script src="/probe.js"></script>
<script>fetch('/probe.json').catch(() => {});</script>
`;

const BARE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>flex bare</title>
<h1>bare</h1>
`;

/** path -> [content type, body]. Anything else is a 404 with a body, not empty. */
const ROUTES = new Map([
  ['/page', ['text/html; charset=utf-8', HTML_PAGE]],
  ['/bare', ['text/html; charset=utf-8', BARE_PAGE]],
  ['/other', ['text/html; charset=utf-8', BARE_PAGE]],
  ['/probe.css', ['text/css; charset=utf-8', 'h1{color:#0b57d0}']],
  ['/probe.js', ['text/javascript; charset=utf-8', 'globalThis.__flexProbe = true;']],
  ['/probe.json', ['application/json; charset=utf-8', '{"ok":true}']],
]);

/**
 * A recorded request. `headers` is a plain lower-cased map exactly as Node
 * parsed it off the socket — repeated headers arrive joined by ", ", which is
 * what makes an `append` operation observable.
 */
function record(req) {
  return {
    method: req.method,
    path: req.url,
    headers: { ...req.headers },
    /** Header lookup that tolerates the case the browser chose to send. */
    get(name) {
      return this.headers[name.toLowerCase()];
    },
    has(name) {
      return Object.hasOwn(this.headers, name.toLowerCase());
    },
  };
}

export async function startProbeServer() {
  /** @type {Array<ReturnType<typeof record>>} */
  const requests = [];

  const server = createServer((req, res) => {
    requests.push(record(req));

    const route = ROUTES.get((req.url ?? '').split('?')[0]);
    const [type, body] = route ?? ['text/plain; charset=utf-8', 'no route'];
    res.writeHead(route ? 200 : 404, {
      'content-type': type,
      // Without this a second navigation to the same path is served from the
      // browser's cache and never reaches us, which would look like a missing
      // header rather than a missing request.
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      // The probe page fetches its own origin, but keeping this open means a
      // test can also fetch it cross-origin from an extension page, and read
      // the response headers the extension added when it does.
      'access-control-allow-origin': '*',
      'access-control-expose-headers': '*',
    });
    res.end(body);
  });

  // Loopback only: this server exists for one browser on this machine.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,

    url(path) {
      return `http://127.0.0.1:${port}${path}`;
    },

    clear() {
      requests.length = 0;
    },

    /** Every recorded request for a path, oldest first. */
    forPath(path) {
      return requests.filter((r) => r.path === path);
    },

    /**
     * Resolve once `predicate` holds over the recorded requests. Navigations are
     * fire-and-forget, so this is how a test waits for the wire instead of
     * sleeping and hoping.
     */
    async waitFor(predicate, { timeout = 15000, label = 'a matching request' } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = predicate(requests);
        if (hit) return hit;
        if (Date.now() > deadline) {
          const seen = requests.map((r) => `${r.method} ${r.path}`).join(', ') || 'nothing';
          throw new Error(`timed out after ${timeout}ms waiting for ${label}; saw: ${seen}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    /**
     * The recorded request for `path`, waiting for it if it has not landed yet.
     *
     * This looks at the whole buffer rather than only at what arrives after the
     * call, because a navigation is already finished by the time the driver
     * returns: the browser cannot commit a document it has not fetched. Tests
     * call `clear()` before each scenario, which is what keeps the buffer
     * unambiguous.
     */
    async waitForPath(path, options = {}) {
      return this.waitFor(
        (all) => all.find((r) => r.path === path),
        { label: `a request for ${path}`, ...options },
      );
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

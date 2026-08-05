/**
 * Chrome and Edge, running the extension for real.
 *
 * The extension is loaded unpacked from `dist/chrome`, the same directory the
 * release zip is made from, so the bytes under test are the bytes that ship.
 *
 * It is installed over the DevTools `Extensions` domain rather than with
 * `--load-extension`: branded Chrome stopped honouring that switch, and a
 * browser that starts fine with no extension in it is the worst possible
 * failure mode for a test suite. `Extensions.loadUnpacked` either installs the
 * extension and hands back its id, or fails loudly.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp } from './cdp.js';

function args({ userDataDir, headless }) {
  const list = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-search-engine-choice-screen',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--window-size=900,700',
  ];
  // Headless loads extensions perfectly well; the switch stays separate so a
  // runner that disagrees can be flipped with NOD_HEADFUL=1 under xvfb.
  if (headless) list.unshift('--headless=new');
  list.push('about:blank');
  return list;
}

/** The port Chrome actually chose, written once the DevTools server is up. */
async function devtoolsPort(userDataDir, child, timeout = 45000) {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;

  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`browser exited with code ${child.exitCode} before DevTools was ready`);
    }
    try {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }

    if (Date.now() > deadline) throw new Error(`DevTools port file never appeared in ${userDataDir}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function browserInfo(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (info.webSocketDebuggerUrl) return info;
    } catch { /* server still coming up */ }
    if (Date.now() > deadline) throw new Error('DevTools HTTP endpoint never answered');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Wait until the extension's own service worker has a target, i.e. it booted. */
async function awaitServiceWorker(cdp, id, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`),
    );
    if (worker) return worker;
    if (Date.now() > deadline) {
      const seen = targetInfos.map((t) => `${t.type} ${t.url}`).join('\n    ') || 'no targets';
      throw new Error(`the extension's service worker never started.\n    ${seen}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Evaluate `expression` in one session. The expression may be an async IIFE; its
 * settled value comes back by value, and a rejection becomes a thrown Error with
 * the page's own message rather than an empty result.
 */
async function evaluate(cdp, sessionId, expression, label) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);

  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(`${label} threw: ${details.exception?.description ?? details.text}`);
  }
  return result.result.value;
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

/**
 * Launch the browser with the extension installed. The returned object is the
 * same shape the Firefox harness returns, so the tests are written once.
 */
export async function launchChromium({ binary, extensionDir, headless = true, label = 'Chromium' }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nod-chromium-'));
  const child = spawn(binary, args({ userDataDir, headless }), { stdio: ['ignore', 'pipe', 'pipe'] });

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdout.resume();

  /** Console errors and uncaught exceptions from any of the extension's contexts. */
  const problems = [];
  let cdp = null;

  const cleanup = () => {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child.exitCode === null) child.kill('SIGKILL');
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    const port = await devtoolsPort(userDataDir, child);
    const info = await browserInfo(port);
    cdp = await Cdp.open(info.webSocketDebuggerUrl);

    // Auto-attach in flat mode, so the service worker's own errors are visible
    // as soon as it starts rather than only if we happen to look.
    cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
      if (!targetInfo.url.startsWith('chrome-extension://')) return;
      cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }, sessionId) => {
      if (!sessionId) return;
      problems.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
    });
    cdp.on('Runtime.consoleAPICalled', ({ type, args: callArgs }, sessionId) => {
      if (!sessionId || type !== 'error') return;
      problems.push(callArgs.map((a) => a.description ?? a.value).join(' '));
    });
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    });

    let id;
    try {
      ({ id } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir }));
    } catch (error) {
      throw new Error(
        `could not install the unpacked extension from ${extensionDir}: ${error.message}\n`
        + '  Extensions.loadUnpacked needs Chrome or Edge 130 or newer.',
        { cause: error },
      );
    }
    await awaitServiceWorker(cdp, id);

    const origin = `chrome-extension://${id}`;
    // Two tabs for the whole run: one parked on an extension page so privileged
    // evaluation always has somewhere to happen, one for navigating the web.
    const extensionTab = await openTab(cdp, `${origin}/options/options.html`);
    const webTab = await openTab(cdp, 'about:blank');

    return {
      name: label,
      engine: 'chromium',
      version: info.Browser ?? label,
      extensionId: id,
      extensionOrigin: origin,
      problems,

      /**
       * Evaluate `expression` inside the extension's options page, where the
       * `chrome.*` APIs are the real ones. The expression may be an async IIFE;
       * its settled value comes back by value.
       */
      evalInExtension(expression) {
        return evaluate(cdp, extensionTab.sessionId, expression, 'evalInExtension');
      },

      /** Evaluate in whatever page the web tab is currently showing. */
      evalInPage(expression) {
        return evaluate(cdp, webTab.sessionId, expression, 'evalInPage');
      },

      async navigate(url) {
        const loaded = cdp.once('Page.loadEventFired', {
          timeout: 20000,
          filter: (_params, sessionId) => sessionId === webTab.sessionId,
        }).catch(() => {});
        await cdp.send('Page.navigate', { url }, webTab.sessionId);
        // Firefox's navigate blocks until the load finishes, so this one does
        // too — otherwise a test that evaluates in the page races the document.
        // A page that never finishes loading is not a failure here: the
        // assertions are about what the server saw.
        await loaded;
      },

      async close() {
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    const tail = stderr.join('').trim().split('\n').slice(-6).join('\n');
    const context = tail ? `\nbrowser stderr:\n${tail}` : '';
    throw new Error(`${label} failed to start: ${error.message}${context}`, { cause: error });
  }
}

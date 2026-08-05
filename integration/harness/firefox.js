/**
 * Firefox, running the extension for real.
 *
 * Installed as a temporary add-on from `dist/firefox`, which is where the AMO
 * zip is made from. Firefox is the browser that exercises the blocking
 * webRequest fallback rather than declarativeNetRequest, so this is the only
 * place that path is tested against a real network stack.
 *
 * The moz-extension origin is normally a per-profile random UUID. Since the
 * profile is ours and thrown away afterwards, we pin the mapping in a pref
 * before launch, which is how the harness knows the URL of the options page
 * without having to go looking for it.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Marionette } from './marionette.js';

/** Must match browser_specific_settings.gecko.id in the Firefox manifest. */
const ADDON_ID = 'nod-header@nodheader.dev';

/** Any valid UUID will do; it only has to be stable within this profile. */
const ADDON_UUID = '3f2b7c14-9d5a-4e6b-8c71-1a2b3c4d5e6f';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function writeProfile(dir, port, extra) {
  const prefs = {
    // Automation server.
    'marionette.port': port,
    // Pin the extension's origin, see the note at the top of this file.
    'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: ADDON_UUID }),
    // A temporary add-on is unsigned by definition.
    'xpinstall.signatures.required': false,
    'extensions.autoDisableScopes': 0,
    'extensions.langpacks.signatures.required': false,
    // Nothing should compete with the test for the first paint or the network.
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage': 'about:blank',
    'browser.startup.page': 0,
    'browser.newtabpage.enabled': false,
    'browser.aboutwelcome.enabled': false,
    'browser.sessionstore.resume_from_crash': false,
    'app.update.enabled': false,
    'app.update.auto': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false,
    'toolkit.telemetry.unified': false,
    'extensions.getAddons.cache.enabled': false,
    'extensions.update.enabled': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'dom.push.connection.enabled': false,
    // Keep the request log honest: no HTTP cache to serve a repeat navigation.
    'browser.cache.disk.enable': false,
    'browser.cache.memory.enable': false,
    ...extra,
  };

  const lines = Object.entries(prefs).map(([key, value]) => {
    const literal = typeof value === 'string' ? JSON.stringify(value) : String(value);
    return `user_pref(${JSON.stringify(key)}, ${literal});`;
  });
  writeFileSync(join(dir, 'user.js'), `${lines.join('\n')}\n`);
}

/**
 * Run `expression` in the current browsing context and settle it out. The
 * callback form is Marionette's only way to wait for a promise.
 */
async function evaluate(client, expression, label) {
  const script = `
    const done = arguments[arguments.length - 1];
    (async () => (${expression}))().then(
      (value) => done({ ok: true, value }),
      (error) => done({ ok: false, error: String((error && error.stack) || error) }),
    );
  `;
  const reply = await client.send('WebDriver:ExecuteAsyncScript', { script, args: [] });
  const outcome = reply.value;
  if (!outcome || typeof outcome !== 'object') {
    throw new Error(`${label} returned ${JSON.stringify(outcome)}`);
  }
  if (!outcome.ok) throw new Error(`${label} threw: ${outcome.error}`);
  return outcome.value;
}

/**
 * Launch Firefox with the extension installed. Returns the same shape the
 * Chromium harness returns, so the tests are written once.
 */
export async function launchFirefox({ binary, extensionDir, headless = true, label = 'Firefox', prefs = {} }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'nod-firefox-'));
  const port = await freePort();
  writeProfile(profileDir, port, prefs);

  const args = [
    '--profile', profileDir,
    '--no-remote',
    '--new-instance',
    '--marionette',
    // Without this, Firefox refuses to navigate an automated tab to a
    // moz-extension:// URL at all, so the options page would be unreachable and
    // there would be nowhere privileged to evaluate from.
    '--remote-allow-system-access',
  ];
  if (headless) args.push('--headless');
  args.push('about:blank');

  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOZ_DISABLE_AUTO_SAFE_MODE: '1', MOZ_CRASHREPORTER_DISABLE: '1' },
  });

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdout.resume();

  let client = null;
  const cleanup = async () => {
    try {
      if (client) {
        await Promise.race([
          client.send('Marionette:Quit', { flags: ['eForceQuit'] }),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
        client.close();
      }
    } catch { /* it is going away either way */ }
    if (child.exitCode === null) child.kill('SIGKILL');
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    client = await Marionette.connect(port);
    const session = await client.send('WebDriver:NewSession', { capabilities: {} });
    const version = session.capabilities?.browserVersion
      ? `Firefox/${session.capabilities.browserVersion}`
      : label;

    await client.send('WebDriver:SetTimeouts', { script: 30000, pageLoad: 30000, implicit: 0 });

    const installed = await client.send('Addon:Install', { path: extensionDir, temporary: true });
    if (installed.value && installed.value !== ADDON_ID) {
      throw new Error(`installed add-on reports id '${installed.value}', expected '${ADDON_ID}'`);
    }

    const origin = `moz-extension://${ADDON_UUID}`;
    const extensionHandle = (await client.send('WebDriver:GetWindowHandle')).value;
    await client.send('WebDriver:Navigate', { url: `${origin}/options/options.html` });

    // Confirm the pinned UUID is really the extension's origin before any test
    // relies on it: a wrong guess would otherwise surface as a page that simply
    // has no extension APIs, ten assertions later.
    const proof = await client.send('WebDriver:ExecuteScript', {
      script: 'return typeof browser === "object" && !!browser.runtime && browser.runtime.id;',
      args: [],
    });
    if (proof.value !== ADDON_ID) {
      throw new Error(
        `${origin}/options/options.html did not load as the extension `
        + `(browser.runtime.id was ${JSON.stringify(proof.value)}); the pinned UUID pref was not honoured`,
      );
    }

    const web = await client.send('WebDriver:NewWindow', { type: 'tab', focus: true });
    const webHandle = web.handle;

    // Switching every time rather than remembering which tab is focused. The
    // cheaper version had to write the new handle after the await that changed
    // it, which is a race if two calls ever overlap — and a wrong answer there
    // would evaluate an extension snippet in the page under test.
    const focus = (handle) => client.send('WebDriver:SwitchToWindow', { handle, focus: true });

    return {
      name: label,
      engine: 'gecko',
      version,
      extensionId: ADDON_ID,
      extensionOrigin: origin,
      // Gecko has no equivalent of CDP's console feed here; the smoke test reads
      // the extension's own diagnostics instead, which is what actually matters.
      problems: [],

      /**
       * Evaluate `expression` in the extension's options page. Marionette's
       * async script hands the value back through a callback, so the expression
       * is wrapped rather than returned directly — same contract as the Chromium
       * harness: an expression, possibly a promise, resolved by value.
       */
      async evalInExtension(expression) {
        await focus(extensionHandle);
        return evaluate(client, expression, 'evalInExtension');
      },

      /** Evaluate in whatever page the web tab is currently showing. */
      async evalInPage(expression) {
        await focus(webHandle);
        return evaluate(client, expression, 'evalInPage');
      },

      async navigate(url) {
        await focus(webHandle);
        // A navigation that does not finish is normal here: a test can point the
        // browser at a path whose response the extension never lets complete.
        // The assertion is on what the server saw, so a load timeout is not a
        // test failure.
        try {
          await client.send('WebDriver:Navigate', { url });
        } catch (error) {
          if (!/timeout|Timeout/.test(String(error.message))) throw error;
        }
      },

      async close() {
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    const tail = stderr.join('').trim().split('\n').slice(-8).join('\n');
    const context = tail ? `\nbrowser stderr:\n${tail}` : '';
    throw new Error(`${label} failed to start: ${error.message}${context}`, { cause: error });
  }
}

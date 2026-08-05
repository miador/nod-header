/**
 * One entry point for the suite: name a browser, get a driven browser back with
 * the extension installed, or a reason it was skipped.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, headless, requestedBrowser } from './browsers.js';
import { launchChromium } from './chromium.js';
import { launchFirefox } from './firefox.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

/** The unpacked build a target loads from — the same tree its zip is made of. */
export function buildDir(target) {
  return join(REPO_ROOT, 'dist', target);
}

/**
 * Resolve the browser to drive. Returns `{ skip }` when it is not installed,
 * so a laptop with one browser runs the tests it can instead of failing.
 */
export function plan(name = requestedBrowser()) {
  // Opt-in: `node --test` finds this file alongside the unit tests, and running
  // the unit suite should not start a browser as a side effect.
  if (!process.env.NOD_BROWSER && !process.env.NOD_INTEGRATION) {
    return { skip: 'set NOD_BROWSER, or run: npm run test:integration -- --browser=chrome' };
  }

  const spec = findBrowser(name);
  if (!spec) return { skip: `${name} is not installed on this machine` };

  const dir = buildDir(spec.target);
  if (!existsSync(join(dir, 'manifest.json'))) {
    return { skip: `${dir} has no build in it — run: node scripts/build.mjs --target=${spec.target}` };
  }
  return { spec, extensionDir: dir };
}

/**
 * Which background engine the extension should end up choosing.
 *
 * `auto` is what a user gets. `webrequest` turns declarativeNetRequest off in
 * the browser so the extension falls back to blocking webRequest — the only way
 * to exercise that engine against a real network stack, since every shipping
 * browser now prefers the declarative one.
 */
export function wantedEngine() {
  const value = (process.env.NOD_ENGINE ?? 'auto').toLowerCase();
  if (value !== 'auto' && value !== 'webrequest') {
    throw new Error(`NOD_ENGINE must be 'auto' or 'webrequest', not '${value}'`);
  }
  return value;
}

export async function launch(spec, extensionDir) {
  const options = { binary: spec.binary, extensionDir, headless: headless(), label: spec.label };

  if (spec.engine !== 'gecko') {
    if (wantedEngine() === 'webrequest') {
      throw new Error('NOD_ENGINE=webrequest only applies to Firefox; Chromium has no blocking webRequest under MV3');
    }
    return launchChromium(options);
  }

  const prefs = wantedEngine() === 'webrequest' ? { 'extensions.dnr.enabled': false } : {};
  return launchFirefox({ ...options, prefs });
}

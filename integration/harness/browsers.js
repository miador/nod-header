/**
 * Where the browsers are.
 *
 * CI runners ship Chrome, Edge and Firefox already installed, and every one of
 * them puts the binary somewhere different. Nothing here downloads a browser: a
 * browser that is not installed makes its tests skip, so the same command works
 * on a laptop with one browser and on a runner with three.
 *
 * Any lookup can be overridden with an environment variable, which is also how
 * you point the suite at a beta or a nightly:
 *
 *   NOD_CHROME_BIN=/path/to/chrome npm run test:integration
 */
import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDIDATES = {
  chrome: {
    env: 'NOD_CHROME_BIN',
    label: 'Chrome',
    engine: 'chromium',
    target: 'chrome',
    paths: {
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ],
      linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ],
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
    },
  },
  edge: {
    env: 'NOD_EDGE_BIN',
    label: 'Edge',
    engine: 'chromium',
    // Edge runs the Chrome build: same manifest, same declarativeNetRequest.
    // Testing it is how we find out whether that assumption still holds.
    target: 'chrome',
    paths: {
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
      win32: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    },
  },
  firefox: {
    env: 'NOD_FIREFOX_BIN',
    label: 'Firefox',
    engine: 'gecko',
    target: 'firefox',
    paths: {
      darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
      linux: ['/usr/bin/firefox', '/snap/bin/firefox', '/usr/lib/firefox/firefox'],
      win32: [
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
      ],
    },
  },
};

export const BROWSER_NAMES = Object.keys(CANDIDATES);

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The browser the suite should drive, or null with a reason to skip. */
export function findBrowser(name) {
  const spec = CANDIDATES[name];
  if (!spec) throw new Error(`unknown browser '${name}'; expected one of ${BROWSER_NAMES.join(', ')}`);

  const override = process.env[spec.env];
  if (override) {
    if (!executable(override)) throw new Error(`${spec.env} is set to '${override}', which is not executable`);
    return { ...spec, name, binary: override, version: versionOf(override) };
  }

  const binary = (spec.paths[process.platform] ?? []).find(executable);
  if (!binary) return null;
  return { ...spec, name, binary, version: versionOf(binary) };
}

/** Best-effort version string; only ever used in log lines. */
function versionOf(binary) {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch {
    return 'unknown version';
  }
}

/** The browser named by NOD_BROWSER, defaulting to Chrome. */
export function requestedBrowser() {
  return (process.env.NOD_BROWSER ?? 'chrome').toLowerCase();
}

/**
 * Headless unless told otherwise. Chromium's headless mode does load
 * extensions, but a runner that behaves differently can be switched over with
 * NOD_HEADFUL=1 (under xvfb, say) without touching the suite.
 */
export function headless() {
  return process.env.NOD_HEADFUL !== '1';
}

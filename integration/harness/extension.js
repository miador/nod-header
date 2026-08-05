/**
 * Talking to the extension from the outside.
 *
 * Scenarios are set up by writing the state the extension already reads —
 * `storage.local`, the same key the popup writes — and then waiting for the
 * background worker to report that it has published rules. Nothing here reaches
 * into the extension's internals or asks it to behave differently under test.
 *
 * Every scenario gets a unique profile name, which is what makes waiting exact:
 * the harness can tell "the rules I just asked for" from "the rules from the
 * previous test" without watching a clock.
 */

/** Firefox exposes promises on `browser`, Chrome on `chrome`. Same choice src/lib/browser.js makes. */
export const API = '(globalThis.browser ?? globalThis.chrome)';

/** Must match STATE_KEY in src/lib/constants.js. */
const STATE_KEY = 'state';

let sequence = 0;

/**
 * JSON that is also safe to paste into a JavaScript expression. JSON leaves the
 * two Unicode line separators bare and JavaScript source treats them as line
 * endings, so a header value holding one would otherwise break the snippet.
 */
function literal(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, String.raw`\u2028`)
    .replace(/\u2029/g, String.raw`\u2029`);
}

export function header(patch = {}) {
  sequence += 1;
  return {
    id: `h-${sequence}`,
    enabled: true,
    name: '',
    value: '',
    target: 'request',
    operation: 'set',
    comment: '',
    include: [],
    resourceTypes: [],
    ...patch,
  };
}

export function profile(patch = {}) {
  sequence += 1;
  return {
    id: patch.id ?? `p-${sequence}`,
    name: `scenario-${sequence}`,
    color: '#0b57d0',
    headers: [],
    include: [],
    exclude: [],
    resourceTypes: [],
    activeTabOnly: false,
    ...patch,
  };
}

export function state(patch = {}) {
  const profiles = patch.profiles ?? [profile()];
  return {
    schemaVersion: 1,
    enabled: true,
    activeProfileId: profiles[0].id,
    settings: {
      logMatches: false,
      logLimit: 200,
      theme: 'light',
      showBadge: true,
      confirmDestructive: false,
      showTargetTag: true,
    },
    ...patch,
    profiles,
  };
}

/** The background worker's own account of what it has published. */
export function diagnostics(browser) {
  return browser
    .evalInExtension(`${API}.runtime.sendMessage({ type: 'get-diagnostics' })`)
    .then((reply) => reply?.diagnostics ?? null);
}

export async function waitForDiagnostics(browser, predicate, { timeout = 20000, label = 'the engine' } = {}) {
  const deadline = Date.now() + timeout;
  let last;

  for (;;) {
    last = await diagnostics(browser);
    if (last && predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeout}ms waiting for ${label}; last report was ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * How long the report has to stand still before rules are taken to be live.
 * The engine debounces writes, so a report can be published for a state that is
 * already one revision behind. Comfortably longer than that debounce.
 */
const SETTLE_MS = 400;

/**
 * Write `next` and resolve once the worker has published rules for it.
 *
 * Waiting on the profile name alone is not enough: the name in a diagnostics
 * report is read from storage, so it changes the instant the write lands, while
 * the rules follow a debounce later. So this waits for three things — the name,
 * a report stamped after the write, and no further report for SETTLE_MS. That
 * last one is what rules out reading a pass that started before the write and
 * therefore compiled the previous state.
 *
 * `expect` is an extra predicate on the report, so a test says what it is
 * waiting for — one rule, or none — instead of sleeping. `allowErrors` is for
 * the cases that are supposed to fail closed.
 */
export async function applyState(browser, next, { expect = () => true, allowErrors = false, timeout = 20000 } = {}) {
  const wanted = next.profiles.find((p) => p.id === next.activeProfileId)?.name;
  if (!wanted) throw new Error('applyState needs a state whose activeProfileId names one of its profiles');

  // Stamped by the browser's clock, the same one appliedAt comes from.
  const writtenAt = await browser.evalInExtension(`(async () => {
    await ${API}.storage.local.set({ ${literal(STATE_KEY)}: ${literal(next)} });
    return Date.now();
  })()`);

  const deadline = Date.now() + timeout;
  let steady = null;
  let since = 0;
  let last;

  for (;;) {
    last = await diagnostics(browser);
    const ready = last
      && last.activeProfileName === wanted
      && last.appliedAt > writtenAt
      && expect(last);

    if (ready && last.appliedAt === steady) {
      if (Date.now() - since >= SETTLE_MS) break;
    } else if (ready) {
      steady = last.appliedAt;
      since = Date.now();
    } else {
      steady = null;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeout}ms waiting for rules for profile ${wanted}; `
        + `last report was ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!allowErrors && last.errors.length) {
    throw new Error(`the engine reported errors while applying ${wanted}: ${last.errors.join('; ')}`);
  }
  return last;
}

/** One request header, no URL scope: the simplest thing the product does. */
export function oneHeader(patch) {
  return state({ profiles: [profile({ headers: [header(patch)] })] });
}

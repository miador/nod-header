/**
 * The engine facade: pick a strategy, coalesce the calls, report what happened.
 *
 * Typing a header value in the popup writes state on every keystroke, and each
 * write asks for the rules to be reapplied. A short debounce turns that burst
 * into one rule-store update. Callers still get a promise that resolves with
 * the report of the run that included their request, which also keeps the
 * service worker alive until the work is done.
 */
import { api, isGecko, hasDeclarativeNetRequest, hasModifyHeaders, hasBlockingWebRequest, guard } from '../lib/browser.js';
import { readState } from '../lib/storage.js';
import { getActiveProfile, isHeaderApplicable } from '../lib/model.js';
import { applyDnrRules } from './engine-dnr.js';
import { applyWebRequestRules } from './engine-webrequest.js';

const DEBOUNCE_MS = 120;
const REPORT_KEY = 'engineReport';

const ENGINE_LABELS = {
  declarativeNetRequest: 'Declarative rules',
  webRequest: 'Blocking webRequest',
  none: 'Not available',
};

let timer = null;
let waiting = [];
let chain = Promise.resolve();
let lastReport = null;

// ── strategy ────────────────────────────────────────────────────────────────

function engineName() {
  if (hasModifyHeaders()) return 'declarativeNetRequest';
  if (hasBlockingWebRequest()) return 'webRequest';
  return 'none';
}

/**
 * The active tab id is only needed by profiles scoped to it, so the query is
 * skipped otherwise.
 */
export async function queryActiveTabId(state) {
  const profile = getActiveProfile(state);
  if (!profile?.activeTabOnly || typeof api?.tabs?.query !== 'function') return null;
  const first = await guard('query active tab', () => api.tabs.query({ active: true, lastFocusedWindow: true }));
  let tabs = Array.isArray(first) ? first : [];
  if (!tabs.length) {
    const any = await guard('query active tab', () => api.tabs.query({ active: true }));
    tabs = Array.isArray(any) ? any : [];
  }
  const tab = tabs.find((candidate) => typeof candidate?.id === 'number');
  return tab ? tab.id : null;
}

/**
 * The report outlives the worker in session storage, so the options page can
 * still show the last warnings after the worker has been shut down and woken.
 */
async function persistReport(report) {
  if (!api?.storage?.session) return;
  await guard('persist engine report', () => api.storage.session.set({ [REPORT_KEY]: report }));
}

async function readPersistedReport() {
  if (!api?.storage?.session) return null;
  const got = await guard('read engine report', () => api.storage.session.get(REPORT_KEY));
  const report = got?.[REPORT_KEY];
  return report && typeof report === 'object' ? report : null;
}

// ── apply ───────────────────────────────────────────────────────────────────

async function applyOnce() {
  try {
    const state = await readState();
    const activeTabId = await queryActiveTabId(state);
    const options = { activeTabId };
    let report;
    if (hasModifyHeaders()) {
      report = await applyDnrRules(state, options);
    } else if (hasBlockingWebRequest()) {
      report = await applyWebRequestRules(state, options);
    } else {
      report = {
        engine: 'none',
        ruleCount: 0,
        dynamicRuleCount: 0,
        sessionRuleCount: 0,
        regexRuleCount: 0,
        warnings: [],
        errors: ['This browser does not let an extension change request headers.'],
      };
    }
    lastReport = { ...report, activeTabId, appliedAt: Date.now() };
  } catch (err) {
    console.error('[nod-header] apply failed:', err);
    lastReport = {
      engine: engineName(),
      ruleCount: 0,
      dynamicRuleCount: 0,
      sessionRuleCount: 0,
      regexRuleCount: 0,
      warnings: [],
      errors: [`The rules could not be applied: ${err instanceof Error ? err.message : String(err)}`],
      activeTabId: null,
      appliedAt: Date.now(),
    };
  }
  await persistReport(lastReport);
  return lastReport;
}

/** Runs after any in-flight pass, so two passes never overlap. */
export function applyRulesNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = waiting;
  waiting = [];
  chain = chain.catch(() => {}).then(() => applyOnce());
  return chain.then((report) => {
    for (const resolve of batch) resolve(report);
    return report;
  });
}

export function applyRules() {
  return new Promise((resolve) => {
    waiting.push(resolve);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void applyRulesNow();
    }, DEBOUNCE_MS);
  });
}

// ── diagnostics ─────────────────────────────────────────────────────────────

/** Counted from the live rule store, not from what we believe we wrote. */
async function liveRuleCounts() {
  const counts = { dynamic: 0, session: 0, regex: 0 };
  const dnr = api?.declarativeNetRequest;
  if (!hasModifyHeaders() || !dnr) return counts;
  const dynamic = await guard('read dynamic rules', () => dnr.getDynamicRules());
  const session = typeof dnr.getSessionRules === 'function'
    ? await guard('read session rules', () => dnr.getSessionRules())
    : [];
  const dynamicRules = Array.isArray(dynamic) ? dynamic : [];
  const sessionRules = Array.isArray(session) ? session : [];
  counts.dynamic = dynamicRules.length;
  counts.session = sessionRules.length;
  counts.regex = dynamicRules.concat(sessionRules)
    .filter((rule) => !!rule?.condition?.regexFilter).length;
  return counts;
}

export async function getDiagnostics() {
  const state = await readState();
  const profile = getActiveProfile(state);
  const report = lastReport ?? await readPersistedReport();
  const engine = engineName();
  const counts = await liveRuleCounts();
  const headerCount = profile ? profile.headers.filter(isHeaderApplicable).length : 0;

  return {
    engine,
    engineLabel: ENGINE_LABELS[engine],
    enabled: state.enabled,
    activeProfileId: profile?.id ?? null,
    activeProfileName: profile?.name ?? '',
    activeTabOnly: !!profile?.activeTabOnly,
    activeTabId: report?.activeTabId ?? null,
    headerCount,
    ruleCount: engine === 'declarativeNetRequest'
      ? counts.dynamic + counts.session
      : (report?.ruleCount ?? headerCount),
    dynamicRuleCount: counts.dynamic,
    sessionRuleCount: counts.session,
    regexRuleCount: counts.regex,
    logging: {
      enabled: !!state.settings.logMatches,
      limit: state.settings.logLimit,
    },
    warnings: Array.isArray(report?.warnings) ? report.warnings : [],
    errors: Array.isArray(report?.errors) ? report.errors : [],
    appliedAt: report?.appliedAt ?? null,
    capabilities: {
      isGecko,
      declarativeNetRequest: hasDeclarativeNetRequest(),
      modifyHeaders: hasModifyHeaders(),
      blockingWebRequest: hasBlockingWebRequest(),
    },
  };
}

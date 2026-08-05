/**
 * The Gecko fallback: blocking webRequest.
 *
 * A blocking listener has to answer synchronously, so it cannot read storage.
 * The listeners are attached once and read a snapshot that the storage
 * subscription refreshes. Until the first snapshot arrives, requests pass
 * through untouched — a fraction of a second on a cold start, and preferable
 * to holding every request while storage is read.
 */
import { api, hasBlockingWebRequest } from '../lib/browser.js';
import { getActiveProfile, isHeaderApplicable, isUnmodifiableHeader } from '../lib/model.js';
import { patternError, effectiveInclude } from '../lib/matcher.js';
import { matchingHeaders, shouldLog, recordMatch } from './log.js';

const ALL_REQUESTS = { urls: ['<all_urls>'] };

let installed = false;
let snapshot = null;

// ── header arithmetic ───────────────────────────────────────────────────────

function lower(name) {
  return String(name ?? '').toLowerCase();
}

/** Gecko may hand back a binaryValue instead of a string value. */
function textValue(entry) {
  return typeof entry.value === 'string' ? entry.value : '';
}

/** Whether the bytes the browser handed over can be read, and rewritten, as text. */
function isText(entry) {
  return typeof entry.value === 'string' && entry.binaryValue === undefined;
}

/**
 * Apply set, append and remove to one header list. Returns a new list, or null
 * when nothing would change — returning null lets the listener answer with
 * nothing at all, which is measurably cheaper for the browser.
 */
/** Every copy of the field goes. Returns null when there was nothing to remove. */
function removeHeader(list, name) {
  const kept = list.filter((entry) => lower(entry.name) !== name);
  return kept.length === list.length ? null : kept;
}

/**
 * Append onto the copy already in the list. Returns null when the existing value
 * is bytes we cannot read as text — joining onto those would throw the original
 * away, which is worse than not appending at all.
 */
function appendHeader(list, header, name, at) {
  // Cookies are the one field that may never be comma-joined.
  if (name === 'set-cookie') return [...list, { name: header.name, value: header.value }];
  if (!isText(list[at])) return null;
  const existing = list[at].value;
  // A header the browser sent empty has nothing to separate, and ', tr' is not a
  // legal field value.
  const joined = existing ? `${existing}, ${header.value}` : header.value;
  const out = [...list];
  out[at] = { name: out[at].name, value: joined };
  return out;
}

/**
 * One value wins, so any duplicate of the same field goes. Returns null when the
 * list already says exactly this and nothing would change.
 */
function setHeader(list, header, name) {
  const existing = list.filter((entry) => lower(entry.name) === name);
  if (existing.length === 1 && existing[0].binaryValue === undefined &&
    textValue(existing[0]) === header.value) {
    return null;
  }
  const out = list.filter((entry) => lower(entry.name) !== name);
  out.push({ name: header.name, value: header.value });
  return out;
}

/** One operation against the list so far, or null when it would change nothing. */
function applyOne(list, header) {
  const name = lower(header.name);
  if (header.operation === 'remove') return removeHeader(list, name);
  const at = list.findIndex((entry) => lower(entry.name) === name);
  if (header.operation === 'append' && at !== -1) return appendHeader(list, header, name, at);
  if (at === -1) return [...list, { name: header.name, value: header.value }];
  return setHeader(list, header, name);
}

function applyOperations(list, headers) {
  let out = list.map((entry) => ({ ...entry }));
  let changed = false;
  for (const header of headers) {
    // The browser owns these. declarativeNetRequest ignores them too, so
    // skipping keeps both engines observably identical.
    if (isUnmodifiableHeader(header.name)) continue;
    const next = applyOne(out, header);
    if (next) {
      out = next;
      changed = true;
    }
  }
  return changed ? out : null;
}

// ── listeners ───────────────────────────────────────────────────────────────

function matchFor(details, target) {
  const snap = snapshot;
  if (!snap) return null;
  return matchingHeaders(snap.state, {
    url: details.url,
    type: details.type,
    tabId: details.tabId,
    target,
    activeTabId: snap.activeTabId,
  });
}

function logMatch(details, target, matched) {
  if (!snapshot || !shouldLog(snapshot.state)) return;
  recordMatch({
    url: details.url,
    method: details.method,
    type: details.type,
    tabId: details.tabId,
    target,
  }, matched.profile, matched.headers);
}

// A rule that matches is logged even when the header already held the wanted
// value, so the log answers "did my rule match" rather than "did the bytes
// change".
function onBeforeSendHeaders(details) {
  const matched = matchFor(details, 'request');
  if (!matched) return undefined;
  logMatch(details, 'request', matched);
  const requestHeaders = applyOperations(details.requestHeaders ?? [], matched.headers);
  return requestHeaders ? { requestHeaders } : undefined;
}

function onHeadersReceived(details) {
  const matched = matchFor(details, 'response');
  if (!matched) return undefined;
  logMatch(details, 'response', matched);
  const responseHeaders = applyOperations(details.responseHeaders ?? [], matched.headers);
  return responseHeaders ? { responseHeaders } : undefined;
}

/**
 * 'extraHeaders' is what makes cookie, referer and CORS headers visible, but
 * asking for it where the browser does not declare it throws.
 */
function specFor(optionsEnum, listOption) {
  const spec = ['blocking', listOption];
  if (optionsEnum && 'EXTRA_HEADERS' in optionsEnum) spec.push('extraHeaders');
  return spec;
}

/**
 * Idempotent and synchronous: the service worker calls this at the top level
 * so the listeners exist before the first request of a cold start.
 */
export function installWebRequest() {
  if (installed) return true;
  const wr = api?.webRequest;
  if (!wr?.onBeforeSendHeaders || !wr?.onHeadersReceived) return false;
  // Chrome throws on a blocking listener instead of ignoring the option, and a
  // throw here would happen while the worker is still registering listeners.
  if (!hasBlockingWebRequest()) return false;
  try {
    wr.onBeforeSendHeaders.addListener(
      onBeforeSendHeaders,
      ALL_REQUESTS,
      specFor(wr.OnBeforeSendHeadersOptions, 'requestHeaders'),
    );
    wr.onHeadersReceived.addListener(
      onHeadersReceived,
      ALL_REQUESTS,
      specFor(wr.OnHeadersReceivedOptions, 'responseHeaders'),
    );
  } catch (err) {
    console.error('[nod-header] webRequest listeners refused:', err);
    return false;
  }
  installed = true;
  return true;
}

// ── apply ───────────────────────────────────────────────────────────────────

function collectPatternWarnings(profile, warnings) {
  const seen = new Set();
  const check = (pattern) => {
    if (seen.has(pattern)) return;
    seen.add(pattern);
    const problem = patternError(pattern);
    if (problem) warnings.push(`The pattern ${pattern} is not valid, so it matches nothing: ${problem}`);
  };
  for (const pattern of profile.include) check(pattern);
  for (const pattern of profile.exclude) check(pattern);
  for (const header of profile.headers) {
    for (const pattern of effectiveInclude(header, profile)) check(pattern);
  }
}

/**
 * There is no rule store here — "applying" is publishing a fresh snapshot for
 * the listeners to read.
 */
export async function applyWebRequestRules(state, options) {
  const warnings = [];
  const errors = [];

  if (!installWebRequest()) {
    errors.push('This browser does not let an extension change request headers.');
  }

  const activeTabId = typeof options?.activeTabId === 'number' ? options.activeTabId : null;
  const profile = state.enabled ? getActiveProfile(state) : null;

  /**
   * An exclude the engine cannot run would silently widen the profile, so the
   * whole profile stops applying until it is fixed — the same call rules.js
   * makes for the declarative engine. Publishing a paused state is what makes
   * the listeners honour it, since they only read this snapshot.
   */
  const brokenExclude = profile
    ? (profile.exclude.find((pattern) => patternError(pattern)) ?? null)
    : null;

  snapshot = brokenExclude ? { state: { ...state, enabled: false }, activeTabId } : { state, activeTabId };

  const headers = profile && !brokenExclude ? profile.headers.filter(isHeaderApplicable) : [];
  if (profile) collectPatternWarnings(profile, warnings);
  if (brokenExclude) {
    warnings.push(`The exclude pattern ${brokenExclude} cannot be used, so this profile is not being applied until it is fixed.`);
  }
  if (profile?.activeTabOnly && activeTabId === null) {
    warnings.push('No active tab was found, so the active-tab headers are not being sent.');
  }

  return {
    engine: 'webRequest',
    ruleCount: headers.length,
    dynamicRuleCount: 0,
    sessionRuleCount: 0,
    regexRuleCount: 0,
    warnings,
    errors,
  };
}

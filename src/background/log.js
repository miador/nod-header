/**
 * The matched-request log, and the per-request match test both engines share.
 *
 * Every network request passes through here twice — once on the way out, once
 * on the way back — so both halves have to be cheap: compiled patterns are
 * memoised across requests, and entries are batched instead of written one at
 * a time. Entries are stored newest first, which is the order the options page
 * shows them in.
 */
import { hasModifyHeaders } from '../lib/browser.js';
import { APPENDABLE_REQUEST_HEADERS, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../lib/constants.js';
import { newId, getActiveProfile, isHeaderApplicable } from '../lib/model.js';
import { compilePatterns, matchesAny, isRe2Safe, effectiveInclude, effectiveResourceTypes } from '../lib/matcher.js';
import { readState, readLog, writeLog, clearLog } from '../lib/storage.js';

// ── pattern cache ───────────────────────────────────────────────────────────

/**
 * Recompiling a regular expression for every request is the one thing that
 * would make this engine feel slow, so compiled lists are keyed by their
 * source text. The cache is dropped wholesale when it grows; the working set
 * is one profile, so it refills in a handful of requests.
 *
 * The key has to be lossless: joining the patterns would let ['a', 'b'] and
 * ['a\nb'] share an entry, and one profile would then be matched with another
 * profile's compiled patterns.
 */
const MAX_CACHED_LISTS = 200;
const compiledLists = new Map();

/**
 * declarativeNetRequest matches with RE2, so rules.js skips any pattern RE2
 * cannot compile. When that engine is live the same patterns have to be
 * invisible here, or the log would credit a header the browser never sent —
 * and an ignored exclude would hide a header that really was sent. The
 * fallback engine matches with real JavaScript regular expressions and keeps
 * all of them.
 */
const re2Only = hasModifyHeaders();

function compiledFor(patterns) {
  const key = JSON.stringify(patterns);
  let entry = compiledLists.get(key);
  if (!entry) {
    const result = compilePatterns(patterns);
    let compiled = result.compiled;
    if (re2Only) compiled = compiled.filter((item) => isRe2Safe(item.source));
    // A pattern the live engine will not run is a pattern this profile no longer
    // fully describes. The count lets the exclude side fail closed.
    entry = { compiled, dropped: result.errors.length + (result.compiled.length - compiled.length) };
    if (compiledLists.size >= MAX_CACHED_LISTS) compiledLists.clear();
    compiledLists.set(key, entry);
  }
  return entry;
}

/** An empty include list means every URL. */
function includeMatches(url, patterns) {
  if (!patterns.length) return true;
  return matchesAny(url, compiledFor(patterns).compiled);
}

/**
 * An empty exclude list loses nothing, but an exclude the engine cannot run
 * loses everything: rules.js refuses to apply the profile at all in that case,
 * so the fallback engine and the log have to agree, or one would send a header
 * the other reports as blocked.
 */
function excludeMatches(url, patterns) {
  if (!patterns.length) return false;
  const { compiled, dropped } = compiledFor(patterns);
  if (dropped) return true;
  return matchesAny(url, compiled);
}

/**
 * Chrome only accepts an append on a fixed list of request headers, so rules.js
 * drops the others. The fallback engine has no such limit, which is why this is
 * gated on the declarative engine being the live one — otherwise the log would
 * credit a header Chrome never sent.
 */
function appendIsAllowed(header) {
  if (!re2Only) return true;
  if (header.operation !== 'append' || header.target === 'response') return true;
  return APPENDABLE_REQUEST_HEADERS.includes(String(header.name).toLowerCase());
}

/** An empty resource-type list means every type. */
function typeMatches(type, types) {
  if (!types.length) return true;
  return types.includes(type);
}

// ── match test ──────────────────────────────────────────────────────────────

/**
 * Two rows saying the same thing are one rule. rules.js collapses them before
 * the declarative engine sees them, so the fallback engine and the log have to
 * collapse them too, or the same value would be appended twice.
 */
function dedupe(headers) {
  const seen = new Set();
  return headers.filter((header) => {
    const key = JSON.stringify([header.name.toLowerCase(), header.operation, header.value]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Which headers of the active profile apply to one request.
 * `request` is { url, type, tabId, target, activeTabId }.
 * Returns { profile, headers } or null. This is the single definition of
 * "applies" for the fallback engine and for the log, so both agree with the
 * rules the DNR engine compiles.
 */
export function matchingHeaders(state, request) {
  if (!state?.enabled) return null;
  const profile = getActiveProfile(state);
  if (!profile) return null;

  if (profile.activeTabOnly) {
    const activeTabId = request.activeTabId;
    if (typeof activeTabId !== 'number' || request.tabId !== activeTabId) return null;
  }

  // Exclude wins over include, for every header in the profile.
  if (excludeMatches(request.url, profile.exclude)) return null;

  const headers = dedupe(profile.headers.filter((header) => (
    header.target === request.target &&
    isHeaderApplicable(header) &&
    appendIsAllowed(header) &&
    includeMatches(request.url, effectiveInclude(header, profile)) &&
    typeMatches(request.type, effectiveResourceTypes(header, profile))
  )));

  return headers.length ? { profile, headers } : null;
}

// ── settings hints ──────────────────────────────────────────────────────────

let loggingHint = null;
let limitHint = DEFAULT_LOG_LIMIT;
let primingRead = null;

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 10), MAX_LOG_LIMIT);
}

/**
 * Primed on every worker start and refreshed by the storage subscription, so
 * the request observers can decide to do nothing without awaiting a read.
 */
export function setLogSettings(state) {
  loggingHint = shouldLog(state);
  limitHint = clampLimit(state?.settings?.logLimit);
}

/**
 * Cheap answer for the hot path: "not known to be off". A request can be the
 * very event that woke the worker, before any state has been read, so an
 * unprimed hint has to let the caller through to the real check rather than
 * silently drop the first requests of every cold start.
 */
export function logEnabled() {
  return loggingHint !== false;
}

/**
 * The state a request observer should log against. Once the hint is primed this
 * is a cached read; before that, a cold start arrives as a burst of requests
 * that would each fire their own storage read, so they share one and prime the
 * hint with it.
 */
export function logState() {
  if (loggingHint !== null) return readState();
  if (!primingRead) {
    primingRead = readState().then((state) => {
      setLogSettings(state);
      primingRead = null;
      return state;
    });
  }
  return primingRead;
}

/** Authoritative answer, from a state you already hold. */
export function shouldLog(state) {
  return !!(state?.enabled && state.settings?.logMatches);
}

// ── ring buffer ─────────────────────────────────────────────────────────────

const FLUSH_AFTER_MS = 500;
const FLUSH_AT_ENTRIES = 25;

let queue = [];
let timer = null;
let chain = Promise.resolve();

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushLog();
  }, FLUSH_AFTER_MS);
}

function cancelTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

/** Queue one matched request. Nothing touches storage until a flush. */
export function recordMatch(request, profile, headers) {
  queue.push({
    id: newId(),
    at: Date.now(),
    url: request.url,
    method: request.method ?? '',
    type: request.type ?? 'other',
    tabId: typeof request.tabId === 'number' ? request.tabId : -1,
    target: request.target,
    profileId: profile.id,
    profileName: profile.name,
    headers: headers.map((header) => ({
      name: header.name,
      value: header.operation === 'remove' ? '' : header.value,
      operation: header.operation,
      // Per header as well as per entry: the options table chips each row.
      target: header.target,
    })),
  });
  if (queue.length >= FLUSH_AT_ENTRIES) {
    void flushLog();
    return;
  }
  schedule();
}

/** Match, then queue. Returns the match so a caller can reuse it. */
export function logRequest(state, request) {
  if (!shouldLog(state)) return null;
  const matched = matchingHeaders(state, request);
  if (!matched) return null;
  recordMatch(request, matched.profile, matched.headers);
  return matched;
}

/**
 * Writes are serialised so two flushes cannot read the same log and each
 * write back a half of the new entries.
 */
function flushLog() {
  if (!queue.length) return chain;
  const batch = queue.reverse();
  queue = [];
  cancelTimer();
  const limit = limitHint;
  chain = chain.then(async () => {
    const existing = await readLog();
    await writeLog(batch.concat(existing).slice(0, limit));
  }).catch((err) => {
    console.error('[nod-header] log flush failed:', err);
  });
  return chain;
}

export async function getLogEntries() {
  await flushLog();
  return readLog();
}

export async function clearLogEntries() {
  queue = [];
  cancelTimer();
  chain = chain.then(() => clearLog()).catch((err) => {
    console.error('[nod-header] log clear failed:', err);
  });
  await chain;
}

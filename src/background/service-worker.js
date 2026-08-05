/**
 * The background worker.
 *
 * An MV3 service worker is shut down whenever it goes idle and started again by
 * the next event, so every listener is registered synchronously at the top
 * level of this file and nothing important is kept in a variable. State is read
 * from storage on demand; the module-level values below are caches that a fresh
 * worker refills from storage on its way up.
 */
import { api, isGecko, hasModifyHeaders, guard } from '../lib/browser.js';
import { MSG } from '../lib/constants.js';
import { readState, writeState, updateState, onStateChanged } from '../lib/storage.js';
import { getActiveProfile, isHeaderApplicable } from '../lib/model.js';
import { applyRules, applyRulesNow, getDiagnostics, queryActiveTabId } from './engine.js';
import { installWebRequest } from './engine-webrequest.js';
import { refreshBadge } from './badge.js';
import { setLogSettings, logEnabled, logState, logRequest, getLogEntries, clearLogEntries } from './log.js';

const TOGGLE_COMMAND = 'toggle-enabled';
const ALL_REQUESTS = { urls: ['<all_urls>'] };

/** Cache, not state: only the log reads it, and a stale value costs one entry. */
let activeTabId = null;

// ── status ──────────────────────────────────────────────────────────────────

/**
 * The one-line answer the popup's status bar shows. `state` matches the dot
 * states in popup.css: on, idle, paused, error.
 */
function statusFor(state, diagnostics) {
  const profile = getActiveProfile(state);
  const count = profile ? profile.headers.filter(isHeaderApplicable).length : 0;

  if (diagnostics.errors.length) {
    return { state: 'error', text: 'Rules are not being applied', detail: diagnostics.errors[0], count };
  }
  if (diagnostics.engine === 'none') {
    return {
      state: 'error',
      text: 'Rules are not being applied',
      detail: 'This browser does not let an extension change request headers.',
      count,
    };
  }
  if (!state.enabled) {
    return {
      state: 'paused',
      text: 'Paused',
      detail: 'No headers are being sent. Turn Nod Header on to apply this profile.',
      count,
    };
  }
  if (count === 0) {
    return {
      state: 'idle',
      text: 'No headers to apply',
      detail: 'Add a header name and value to start sending it.',
      count,
    };
  }
  const headers = count === 1 ? '1 header' : `${count} headers`;
  const detail = diagnostics.warnings.length
    ? diagnostics.warnings[0]
    : `${profile.name} is sending ${headers}.`;
  return { state: 'on', text: 'Rules active', detail, count };
}

// ── messages ────────────────────────────────────────────────────────────────

/**
 * Pages send { type, ...payload }, or the bare message string when there is no
 * payload. Every branch answers, so no sender is left waiting.
 */
async function handleMessage(type, message) {
  switch (type) {
    case MSG.GET_SNAPSHOT: {
      const state = await readState();
      const diagnostics = await getDiagnostics();
      return { state, status: statusFor(state, diagnostics), diagnostics };
    }
    case MSG.SET_STATE: {
      // Writing an absent state would normalise into a fresh default and take
      // every profile with it, so refuse instead.
      if (!message.state || typeof message.state !== 'object') {
        return { error: 'That change was not saved because it arrived without any settings.' };
      }
      const state = await writeState(message.state);
      setLogSettings(state);
      void applyRules();
      return { ok: true, state };
    }
    case MSG.SET_ENABLED: {
      const state = await updateState((draft) => {
        draft.enabled = !!message.enabled;
      });
      setLogSettings(state);
      // The master switch is a deliberate act: answer only once it has taken
      // effect, so the popup never reports on while rules are still off.
      await applyRulesNow();
      await refreshBadge(state);
      return { ok: true, state };
    }
    case MSG.GET_LOG:
      return { entries: await getLogEntries() };
    case MSG.CLEAR_LOG:
      await clearLogEntries();
      return { ok: true };
    case MSG.GET_DIAGNOSTICS:
      return { diagnostics: await getDiagnostics() };
    default:
      return { error: `Nod Header does not understand the message "${String(type)}".` };
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

async function onInstalled(details) {
  // Reading and writing back normalises an older schema or a partial write.
  const state = await updateState((draft) => draft);
  setLogSettings(state);
  await applyRulesNow();
  await refreshBadge(state);
  if (details?.reason === 'install' && typeof api.runtime.openOptionsPage === 'function') {
    await guard('open options page', () => api.runtime.openOptionsPage());
  }
}

async function onStartup() {
  const state = await readState();
  setLogSettings(state);
  await applyRulesNow();
  await refreshBadge(state);
}

async function toggleEnabled() {
  const state = await updateState((draft) => {
    draft.enabled = !draft.enabled;
  });
  setLogSettings(state);
  await applyRulesNow();
  await refreshBadge(state);
}

// ── tabs ────────────────────────────────────────────────────────────────────

async function onTabActivated(tabId) {
  activeTabId = typeof tabId === 'number' ? tabId : null;
  const state = await readState();
  await refreshBadge(state);
  // Active-tab rules name a tab id, so a different tab needs new rules.
  if (getActiveProfile(state)?.activeTabOnly) await applyRules();
}

async function onTabUpdated(tabId, tab) {
  const state = await readState();
  await refreshBadge(state);
  if (!tab?.active) return;
  const changedTab = activeTabId !== tabId;
  activeTabId = tabId;
  if (changedTab && getActiveProfile(state)?.activeTabOnly) await applyRules();
}

/** Focusing another window changes the active tab without firing onActivated. */
async function onWindowFocused() {
  const state = await readState();
  if (!getActiveProfile(state)?.activeTabOnly) return;
  activeTabId = await queryActiveTabId(state);
  await applyRules();
}

// ── request log ─────────────────────────────────────────────────────────────

/**
 * With the declarativeNetRequest engine the browser rewrites headers without
 * telling us, so these non-blocking observers exist only to feed the log. They
 * do as little as possible before deciding to stop.
 */
async function observe(details, target) {
  if (!logEnabled()) return;
  const state = await logState();
  const profile = getActiveProfile(state);
  if (profile?.activeTabOnly && typeof activeTabId !== 'number') {
    // Two observers can race to fill this in and they will agree on the answer.
    // Even if they did not, this is the log's cache and not something a rule is
    // built from: being wrong costs one entry the wrong tab id.
    // eslint-disable-next-line require-atomic-updates
    activeTabId = await queryActiveTabId(state);
  }
  logRequest(state, {
    url: details.url,
    method: details.method,
    type: details.type,
    tabId: details.tabId,
    target,
    activeTabId,
  });
}

function observeRequestHeaders(details) {
  void observe(details, 'request');
}

function observeResponseHeaders(details) {
  void observe(details, 'response');
}

/**
 * The observers see every request in every tab, which is far more than a
 * switched-off log is worth, so they are attached and detached as the setting
 * flips instead of living for the whole worker. The listeners are top-level
 * declarations so removeListener can name the same function that was added.
 */
let observing = false;

function syncLogObservers(state) {
  // The fallback engine logs from its own blocking listeners, so an observer
  // there would double-count.
  const wanted = hasModifyHeaders() && !!state?.settings?.logMatches;
  if (wanted === observing) return;
  const beforeSend = api.webRequest?.onBeforeSendHeaders;
  const received = api.webRequest?.onHeadersReceived;
  try {
    if (wanted) {
      beforeSend?.addListener(observeRequestHeaders, ALL_REQUESTS);
      received?.addListener(observeResponseHeaders, ALL_REQUESTS);
    } else {
      beforeSend?.removeListener(observeRequestHeaders);
      received?.removeListener(observeResponseHeaders);
    }
  } catch (err) {
    // A browser or a profile that withholds webRequest costs the log and
    // nothing else.
    console.error('[nod-header] request log unavailable:', err);
    return;
  }
  observing = wanted;
}

// ── startup ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  const state = await readState();
  setLogSettings(state);
  syncLogObservers(state);
  await refreshBadge(state);
  if (getActiveProfile(state)?.activeTabOnly) {
    activeTabId = await queryActiveTabId(state);
  }
  // The fallback engine holds its rules in memory, so a fresh worker has to
  // publish them again. The declarative rule store survived on its own.
  if (!hasModifyHeaders()) await applyRules();
}

// ── registration ────────────────────────────────────────────────────────────
// Everything below runs synchronously on every worker start, before any await,
// so the event that woke this worker still finds its listener.

api.runtime.onInstalled.addListener((details) => {
  void onInstalled(details);
});

api.runtime.onStartup.addListener(() => {
  void onStartup();
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = typeof message === 'string' ? message : message?.type;
  const reply = handleMessage(type, typeof message === 'object' && message ? message : {}).catch(
    (err) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
  // Gecko delivers the answer by resolving the promise the listener returns;
  // returning true there closes the channel before sendResponse can fire.
  if (isGecko) return reply;
  void reply.then(sendResponse);
  return true;
});

onStateChanged((state) => {
  setLogSettings(state);
  syncLogObservers(state);
  void applyRules();
  void refreshBadge(state);
});

if (api.tabs?.onActivated) {
  api.tabs.onActivated.addListener((info) => {
    void onTabActivated(info?.tabId);
  });
}

if (api.tabs?.onUpdated) {
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // A tab fires onUpdated for favicons and titles too; only navigation and
    // load completion can change what the badge or the rules should say.
    if (!changeInfo?.url && changeInfo?.status !== 'complete') return;
    void onTabUpdated(tabId, tab);
  });
}

if (api.windows?.onFocusChanged) {
  api.windows.onFocusChanged.addListener(() => {
    void onWindowFocused();
  });
}

if (api.commands?.onCommand) {
  api.commands.onCommand.addListener((command) => {
    if (command !== TOGGLE_COMMAND) return;
    void toggleEnabled();
  });
}

// The log's observers are not registered here: bootstrap and the storage
// subscription attach them only while logging is on.
if (!hasModifyHeaders()) {
  // The fallback engine's blocking listeners have to be in place before the
  // first request, which can arrive before bootstrap finishes.
  installWebRequest();
}

void bootstrap();

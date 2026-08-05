/**
 * One namespace for every browser.
 *
 * Firefox exposes the promise-based `browser.*` namespace; Chrome and Edge
 * expose `chrome.*`, which returns promises for the MV3 APIs this extension
 * uses. Preferring `browser` keeps Firefox on its native promises instead of
 * its callback-shaped `chrome` alias.
 */
export const api = globalThis.browser ?? globalThis.chrome;

/** True on Gecko, where blocking webRequest is still available in MV3. */
export const isGecko = typeof globalThis.browser !== 'undefined' && !!api?.runtime?.getBrowserInfo;

/** Runtime feature probes — the background engine picks a strategy from these. */
export function hasDeclarativeNetRequest() {
  return !!(api?.declarativeNetRequest?.updateDynamicRules);
}

export function hasModifyHeaders() {
  const t = api?.declarativeNetRequest?.RuleActionType;
  // Chrome exposes the enum; Firefox 128+ does too. Fall back to assuming
  // support when the enum is missing but the API is present.
  return hasDeclarativeNetRequest() && (!t || 'MODIFY_HEADERS' in t);
}

export function hasBlockingWebRequest() {
  // Chrome still lists BLOCKING in the generated enum under MV3, where the
  // webRequestBlocking permission cannot be granted, so the enum only answers
  // the question on Gecko.
  return isGecko &&
    !!(api?.webRequest?.onBeforeSendHeaders) &&
    !!api?.webRequest?.OnBeforeSendHeadersOptions?.BLOCKING;
}

/** `chrome.runtime.lastError` is set instead of rejecting on some old paths. */
export function lastError() {
  const err = api?.runtime?.lastError;
  return err ? new Error(err.message) : null;
}

/**
 * Chrome and Firefox both reject on failure for the APIs we call, but a
 * rejected promise inside a service-worker event handler is easy to lose.
 * This keeps failures visible without crashing the worker.
 */
export async function guard(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[nod-header] ${label}:`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

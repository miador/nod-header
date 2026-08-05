/**
 * Persistence. `storage.local` is the source of truth; every page reads the
 * same key and listens for changes, so two open surfaces never drift apart.
 */
import { api } from './browser.js';
import { STATE_KEY, LOG_KEY } from './constants.js';
import { normalizeState } from './model.js';

let cache = null;
let writeChain = Promise.resolve();

/**
 * Bumped by anything that makes a read already in flight out of date: a commit,
 * a change event, or an explicit invalidation.
 */
let generation = 0;

export async function readState() {
  if (cache) return cache;
  const start = generation;
  const got = await api.storage.local.get(STATE_KEY);
  const state = normalizeState(got?.[STATE_KEY]);
  // A waking worker's read is real I/O, and a write can land while it is out
  // there. Filling the cache unconditionally would then pin the older state:
  // the commit and the change event both set the fresh one, and this line would
  // overwrite it, leaving every later read — including the one the engine
  // compiles rules from — a revision behind until the next write.
  if (generation !== start) return cache ?? state;
  // The line above is the guard require-atomic-updates is asking for; it cannot
  // see that, because the thing being compared is not the thing being assigned.
  // eslint-disable-next-line require-atomic-updates
  cache = state;
  return cache;
}

/**
 * Every write — including the read half of a read-modify-write — runs inside
 * one queue. Reading outside the queue is what loses an edit: two callers would
 * both read the same base state and the second would overwrite the first.
 */
function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function commit(state) {
  cache = state;
  generation += 1;
  try {
    await api.storage.local.set({ [STATE_KEY]: state });
  } catch (err) {
    console.error('[nod-header] write failed:', err);
    throw err;
  }
  return state;
}

export function writeState(next) {
  return enqueue(() => commit(normalizeState(next)));
}

/** Read-modify-write against the freshest state, serialised with every write. */
export function updateState(mutator) {
  return enqueue(async () => {
    const current = await readState();
    const draft = structuredClone(current);
    const result = mutator(draft);
    return commit(normalizeState(result === undefined ? draft : result));
  });
}

/** Called by the change listener so the next read does not serve stale data. */
export function invalidateCache() {
  cache = null;
  generation += 1;
}

/**
 * Subscribe to state changes made anywhere (another page, the worker).
 * Returns an unsubscribe function.
 */
export function onStateChanged(handler) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes[STATE_KEY]) return;
    cache = normalizeState(changes[STATE_KEY].newValue);
    generation += 1;
    handler(cache);
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}

export function onLogChanged(handler) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes[LOG_KEY]) return;
    handler(changes[LOG_KEY].newValue ?? []);
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}

export async function readLog() {
  const got = await api.storage.local.get(LOG_KEY);
  return Array.isArray(got?.[LOG_KEY]) ? got[LOG_KEY] : [];
}

export async function writeLog(entries) {
  await api.storage.local.set({ [LOG_KEY]: entries });
}

export async function clearLog() {
  await api.storage.local.remove(LOG_KEY);
}

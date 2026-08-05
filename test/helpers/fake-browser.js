/**
 * A stand-in for the slice of `chrome.*` the spine touches: storage.local and
 * storage.onChanged.
 *
 * The namespace object is built once and then reused, because src/lib/browser.js
 * captures the namespace at module load. Handing out a fresh object on a second
 * install would leave every already-loaded module talking to a dead fake.
 */

const AREA = 'local';

const state = {
  store: {},
  listeners: [],
  calls: { get: 0, set: 0, remove: 0 },
};

let namespace = null;
let handle = null;

/** Values cross the boundary as copies, so a test cannot mutate what is stored. */
const copy = (value) => (value === undefined ? undefined : structuredClone(value));

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function pick(keys, defaults) {
  const out = {};
  for (const key of keys) {
    if (has(state.store, key)) out[key] = copy(state.store[key]);
    else if (defaults && has(defaults, key)) out[key] = copy(defaults[key]);
  }
  return out;
}

function dispatch(changes, areaName = AREA) {
  for (const listener of state.listeners.slice()) listener(copy(changes), areaName);
}

function buildNamespace() {
  return {
    storage: {
      local: {
        async get(query) {
          state.calls.get += 1;
          if (query === undefined || query === null) return copy(state.store);
          if (typeof query === 'string') return pick([query], null);
          if (Array.isArray(query)) return pick(query.map(String), null);
          if (typeof query === 'object') return pick(Object.keys(query), query);
          return {};
        },

        async set(items) {
          state.calls.set += 1;
          if (!items || typeof items !== 'object') {
            throw new TypeError('storage.local.set expects an object of key-value pairs');
          }
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            const existed = has(state.store, key);
            const oldValue = existed ? state.store[key] : undefined;
            state.store[key] = copy(value);
            changes[key] = existed
              ? { oldValue: copy(oldValue), newValue: copy(state.store[key]) }
              : { newValue: copy(state.store[key]) };
          }
          dispatch(changes);
        },

        async remove(query) {
          state.calls.remove += 1;
          const keys = Array.isArray(query) ? query.map(String) : [String(query)];
          const changes = {};
          for (const key of keys) {
            if (!has(state.store, key)) continue;
            changes[key] = { oldValue: copy(state.store[key]) };
            delete state.store[key];
          }
          if (Object.keys(changes).length) dispatch(changes);
        },
      },

      onChanged: {
        addListener(listener) {
          if (typeof listener === 'function' && !state.listeners.includes(listener)) {
            state.listeners.push(listener);
          }
        },
        removeListener(listener) {
          const at = state.listeners.indexOf(listener);
          if (at >= 0) state.listeners.splice(at, 1);
        },
        hasListener(listener) {
          return state.listeners.includes(listener);
        },
        dispatch,
      },
    },
  };
}

function buildHandle() {
  return {
    get chrome() {
      return namespace;
    },
    calls: state.calls,

    /** Write straight to the backing object, without firing onChanged. */
    seed(items) {
      for (const [key, value] of Object.entries(items || {})) state.store[key] = copy(value);
      return handle;
    },

    snapshot() {
      return copy(state.store);
    },

    value(key) {
      return copy(state.store[key]);
    },

    keys() {
      return Object.keys(state.store);
    },

    listenerCount() {
      return state.listeners.length;
    },

    dispatch,

    reset(initial) {
      state.store = {};
      state.listeners.length = 0;
      state.calls.get = 0;
      state.calls.set = 0;
      state.calls.remove = 0;
      if (initial) handle.seed(initial);
      return handle;
    },
  };
}

export function installFakeBrowser(initial) {
  if (!namespace) namespace = buildNamespace();
  if (!handle) handle = buildHandle();
  handle.reset(initial);
  globalThis.chrome = namespace;
  return handle;
}

/** Drop stored data, listeners and call counts so one test cannot leak into the next. */
export function resetFakeBrowser(initial) {
  if (!handle) return installFakeBrowser(initial);
  return handle.reset(initial);
}

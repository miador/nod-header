import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeBrowser, resetFakeBrowser } from './helpers/fake-browser.js';
import { STATE_KEY, LOG_KEY, SCHEMA_VERSION } from '../src/lib/constants.js';

// src/lib/browser.js captures the namespace at module load, so the fake has to be
// installed before storage.js — or browser.js itself — is pulled in.
const fake = installFakeBrowser();
const storage = await import('../src/lib/storage.js');
// Two tests below hold storage.get open on purpose, which needs the namespace itself.
const { api } = await import('../src/lib/browser.js');

/** A state whose profile name says which revision it is. */
const named = (name) => ({
  enabled: true,
  activeProfileId: 'p1',
  profiles: [{ id: 'p1', name, headers: [{ id: 'h1', name: 'X-Api-Key', value: 'abc' }] }],
});

const devState = {
  enabled: true,
  activeProfileId: 'p1',
  profiles: [{ id: 'p1', name: 'Dev', headers: [{ id: 'h1', name: 'X-Api-Key', value: 'abc' }] }],
};

beforeEach(() => {
  resetFakeBrowser();
  storage.invalidateCache();
});

describe('readState', () => {
  test('returns a valid default when nothing is stored', async () => {
    const state = await storage.readState();
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.enabled, true);
    assert.equal(state.profiles.length, 1);
    assert.equal(state.activeProfileId, state.profiles[0].id);
    assert.equal(state.settings.theme, 'light');
  });

  test('does not write the default back', async () => {
    await storage.readState();
    assert.deepEqual(fake.keys(), []);
    assert.equal(fake.calls.set, 0);
  });

  test('repairs whatever is stored', async () => {
    fake.seed({ [STATE_KEY]: { profiles: 'junk', settings: { theme: 'neon' } } });
    const state = await storage.readState();
    assert.equal(state.profiles.length, 1);
    assert.equal(state.settings.theme, 'light');
  });

  test('a read still in flight does not overwrite a newer state', async () => {
    // A waking service worker reads from real storage while the popup is still
    // writing. If the late read fills the cache anyway, the engine compiles
    // rules from the older state and stays a revision behind until the next
    // write — silently, because nothing reports it.
    fake.seed({ [STATE_KEY]: named('OLD') });

    const realGet = api.storage.local.get.bind(api.storage.local);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    api.storage.local.get = async (query) => {
      const value = await realGet(query);
      await held;
      return value;
    };

    try {
      const inFlight = storage.readState();
      await storage.writeState(named('NEW'));
      release();
      await inFlight;
    } finally {
      api.storage.local.get = realGet;
    }

    assert.equal((await storage.readState()).profiles[0].name, 'NEW');
    const stored = await realGet(STATE_KEY);
    assert.equal(stored[STATE_KEY].profiles[0].name, 'NEW');
  });

  test('a read in flight across an invalidation is not cached', async () => {
    fake.seed({ [STATE_KEY]: named('OLD') });

    const realGet = api.storage.local.get.bind(api.storage.local);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    api.storage.local.get = async (query) => {
      const value = await realGet(query);
      await held;
      return value;
    };

    try {
      const inFlight = storage.readState();
      // Something outside changed the store and said so.
      fake.seed({ [STATE_KEY]: named('NEWER') });
      storage.invalidateCache();
      release();
      // The in-flight read may return what it read; it must not pin it.
      await inFlight;
    } finally {
      api.storage.local.get = realGet;
    }

    assert.equal((await storage.readState()).profiles[0].name, 'NEWER');
  });
});

describe('writeState', () => {
  test('round-trips through storage', async () => {
    await storage.writeState(devState);
    assert.deepEqual(fake.keys(), [STATE_KEY]);

    storage.invalidateCache();
    const read = await storage.readState();
    assert.equal(read.activeProfileId, 'p1');
    assert.equal(read.profiles[0].name, 'Dev');
    assert.equal(read.profiles[0].headers[0].value, 'abc');
  });

  test('resolves with the normalised state it stored', async () => {
    const written = await storage.writeState({ profiles: [], activeProfileId: 'gone' });
    assert.equal(written.schemaVersion, SCHEMA_VERSION);
    assert.equal(written.profiles.length, 1);
    assert.equal(written.activeProfileId, written.profiles[0].id);
    assert.deepEqual(fake.value(STATE_KEY), written);
  });

  test('normalises junk instead of storing it', async () => {
    await storage.writeState(null);
    const stored = fake.value(STATE_KEY);
    assert.equal(stored.schemaVersion, SCHEMA_VERSION);
    assert.equal(stored.profiles.length, 1);
  });

  test('what is stored cannot be changed through the object it handed back', async () => {
    const written = await storage.writeState(devState);
    written.profiles[0].name = 'Tampered';
    written.profiles[0].headers.push({ name: 'X-Sneaky', value: '1' });
    assert.equal(fake.value(STATE_KEY).profiles[0].name, 'Dev');
    assert.equal(fake.value(STATE_KEY).profiles[0].headers.length, 1);
  });
});

describe('updateState', () => {
  test('applies a mutator that changes the draft in place', async () => {
    await storage.writeState(devState);
    const result = await storage.updateState((draft) => {
      draft.enabled = false;
      draft.profiles[0].headers[0].value = 'xyz';
    });
    assert.equal(result.enabled, false);
    assert.equal(result.profiles[0].headers[0].value, 'xyz');
    assert.equal(fake.value(STATE_KEY).enabled, false);
    assert.equal(fake.value(STATE_KEY).profiles[0].headers[0].value, 'xyz');
  });

  test('accepts a mutator that returns a new object', async () => {
    await storage.writeState(devState);
    const result = await storage.updateState((draft) => ({ ...draft, enabled: false }));
    assert.equal(result.enabled, false);
    assert.equal(result.profiles[0].name, 'Dev');
    assert.equal(fake.value(STATE_KEY).enabled, false);
  });

  test('normalises what the mutator returns', async () => {
    await storage.writeState(devState);
    const result = await storage.updateState(() => ({ profiles: [{ id: 'p2', name: 42 }] }));
    assert.equal(result.profiles[0].name, 'Default');
    assert.equal(result.activeProfileId, 'p2');
    assert.equal(result.schemaVersion, SCHEMA_VERSION);
  });

  test('starts from a default state when nothing is stored yet', async () => {
    const result = await storage.updateState((draft) => {
      draft.profiles[0].name = 'First run';
    });
    assert.equal(result.profiles[0].name, 'First run');
    assert.equal(fake.value(STATE_KEY).profiles[0].name, 'First run');
  });
});

describe('cache', () => {
  test('a second read is served without touching storage', async () => {
    const first = await storage.readState();
    assert.equal(fake.calls.get, 1);
    const second = await storage.readState();
    assert.equal(fake.calls.get, 1);
    assert.equal(second, first);
  });

  test('a write primes the cache, so the next read stays local', async () => {
    await storage.writeState(devState);
    const before = fake.calls.get;
    assert.equal((await storage.readState()).profiles[0].name, 'Dev');
    assert.equal(fake.calls.get, before);
  });

  test('invalidateCache forces a re-read and picks up an out-of-band change', async () => {
    await storage.readState();
    fake.seed({ [STATE_KEY]: { activeProfileId: 'p9', profiles: [{ id: 'p9', name: 'Out of band' }] } });

    assert.equal((await storage.readState()).profiles[0].name, 'Default');
    assert.equal(fake.calls.get, 1);

    storage.invalidateCache();
    assert.equal((await storage.readState()).profiles[0].name, 'Out of band');
    assert.equal(fake.calls.get, 2);
  });
});

describe('onStateChanged', () => {
  test('fires with a normalised state', async () => {
    const seen = [];
    const off = storage.onStateChanged((state) => seen.push(state));

    fake.dispatch({ [STATE_KEY]: { oldValue: null, newValue: { profiles: 'junk' } } }, 'local');

    assert.equal(seen.length, 1);
    assert.equal(seen[0].schemaVersion, SCHEMA_VERSION);
    assert.equal(seen[0].profiles.length, 1);
    assert.equal(seen[0].activeProfileId, seen[0].profiles[0].id);
    off();
  });

  test('fires when another surface writes, and leaves the cache fresh', async () => {
    const seen = [];
    const off = storage.onStateChanged((state) => seen.push(state));

    await storage.writeState(devState);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].profiles[0].name, 'Dev');
    const before = fake.calls.get;
    assert.equal((await storage.readState()).profiles[0].name, 'Dev');
    assert.equal(fake.calls.get, before);
    off();
  });

  test('ignores another storage area and another key', () => {
    const seen = [];
    const off = storage.onStateChanged((state) => seen.push(state));

    fake.dispatch({ [STATE_KEY]: { newValue: {} } }, 'sync');
    fake.dispatch({ [LOG_KEY]: { newValue: [] } }, 'local');

    assert.equal(seen.length, 0);
    off();
  });

  test('the returned function detaches the listener', () => {
    const seen = [];
    const off = storage.onStateChanged((state) => seen.push(state));
    assert.equal(fake.listenerCount(), 1);

    fake.dispatch({ [STATE_KEY]: { newValue: {} } }, 'local');
    assert.equal(seen.length, 1);

    off();
    assert.equal(fake.listenerCount(), 0);

    fake.dispatch({ [STATE_KEY]: { newValue: {} } }, 'local');
    assert.equal(seen.length, 1);
  });
});

describe('onLogChanged', () => {
  test('fires with the new entries and falls back to an empty list', async () => {
    const seen = [];
    const off = storage.onLogChanged((entries) => seen.push(entries));

    await storage.writeLog([{ id: 'e1' }]);
    await storage.clearLog();

    assert.deepEqual(seen, [[{ id: 'e1' }], []]);
    off();
  });

  test('ignores another storage area, and detaches', () => {
    const seen = [];
    const off = storage.onLogChanged((entries) => seen.push(entries));

    fake.dispatch({ [LOG_KEY]: { newValue: [1] } }, 'sync');
    assert.equal(seen.length, 0);

    off();
    assert.equal(fake.listenerCount(), 0);
    fake.dispatch({ [LOG_KEY]: { newValue: [1] } }, 'local');
    assert.equal(seen.length, 0);
  });
});

describe('the request log', () => {
  test('reads as an empty list when nothing is stored', async () => {
    assert.deepEqual(await storage.readLog(), []);
  });

  test('reads as an empty list when the stored value is not a list', async () => {
    fake.seed({ [LOG_KEY]: 'nope' });
    assert.deepEqual(await storage.readLog(), []);
  });

  test('round-trips entries', async () => {
    const entries = [{ id: 'e1', url: 'https://example.com/' }, { id: 'e2', url: 'https://b.dev/' }];
    await storage.writeLog(entries);
    assert.deepEqual(await storage.readLog(), entries);
  });

  test('is not cached, so a fresh write is visible at once', async () => {
    await storage.writeLog([{ id: 'e1' }]);
    await storage.writeLog([{ id: 'e2' }]);
    assert.deepEqual(await storage.readLog(), [{ id: 'e2' }]);
  });

  test('clearLog drops the key', async () => {
    await storage.writeLog([{ id: 'e1' }]);
    await storage.clearLog();
    assert.equal(fake.keys().includes(LOG_KEY), false);
    assert.deepEqual(await storage.readLog(), []);
  });

  test('clearLog on an empty store is quiet', async () => {
    await storage.clearLog();
    assert.deepEqual(await storage.readLog(), []);
  });

  test('entries cannot be changed through the array that was written', async () => {
    const entries = [{ id: 'e1' }];
    await storage.writeLog(entries);
    entries[0].id = 'tampered';
    entries.push({ id: 'e2' });
    assert.deepEqual(await storage.readLog(), [{ id: 'e1' }]);
  });
});

describe('serialised writes', () => {
  test('two writes fired without awaiting the first both land, in order', async () => {
    const seen = [];
    fake.chrome.storage.onChanged.addListener((changes) => {
      if (changes[STATE_KEY]) seen.push(changes[STATE_KEY].newValue.profiles[0].name);
    });
    await storage.writeState(devState);

    const first = storage.updateState((draft) => {
      draft.profiles[0].name = 'First';
    });
    const second = storage.updateState((draft) => {
      draft.profiles[0].name = 'Second';
    });
    await Promise.all([first, second]);

    assert.deepEqual(seen, ['Dev', 'First', 'Second']);
    assert.equal(fake.calls.set, 3);
    assert.equal(fake.value(STATE_KEY).profiles[0].name, 'Second');
  });

  test('updates that do not overlap keep every mutation', async () => {
    await storage.writeState(devState);

    await storage.updateState((draft) => {
      draft.profiles[0].name = 'Renamed';
    });
    await storage.updateState((draft) => {
      draft.enabled = false;
    });

    const stored = fake.value(STATE_KEY);
    assert.equal(stored.profiles[0].name, 'Renamed');
    assert.equal(stored.enabled, false);
  });

  /**
   * updateState joins the write chain before it reads, so a second call cannot
   * clone a snapshot that the first is about to replace. Without that, the later
   * write silently discards the earlier mutation.
   */
  test('two concurrent updateState calls keep both mutations', async () => {
    await storage.writeState(devState);

    const rename = storage.updateState((draft) => {
      draft.profiles[0].name = 'Renamed';
    });
    const disable = storage.updateState((draft) => {
      draft.enabled = false;
    });
    await Promise.all([rename, disable]);

    const stored = fake.value(STATE_KEY);
    assert.equal(stored.profiles[0].name, 'Renamed');
    assert.equal(stored.enabled, false);
  });

  test('a queue of interleaved writes and updates lands in order and stays valid', async () => {
    await storage.writeState(devState);

    await Promise.all([
      storage.updateState((draft) => {
        draft.profiles[0].name = 'Renamed';
      }),
      storage.updateState((draft) => {
        draft.enabled = false;
      }),
      storage.updateState((draft) => {
        draft.profiles[0].headers.push({ name: 'X-Late', value: '1' });
      }),
    ]);

    const stored = fake.value(STATE_KEY);
    assert.equal(stored.enabled, false);
    assert.equal(stored.profiles[0].name, 'Renamed');
    assert.equal(stored.profiles[0].headers.at(-1).name, 'X-Late');
    assert.equal(stored.schemaVersion, SCHEMA_VERSION);
    assert.equal(stored.activeProfileId, 'p1');
  });

  test('a mutator that throws does not stall the queue', async () => {
    await storage.writeState(devState);

    await assert.rejects(storage.updateState(() => {
      throw new Error('boom');
    }), /boom/);

    await storage.updateState((draft) => {
      draft.enabled = false;
    });
    assert.equal(fake.value(STATE_KEY).enabled, false);
  });
});

describe('the fake itself', () => {
  test('get accepts a key, a list of keys and nothing at all', async () => {
    fake.seed({ a: 1, b: { deep: [1, 2] } });
    assert.deepEqual(await fake.chrome.storage.local.get('a'), { a: 1 });
    assert.deepEqual(await fake.chrome.storage.local.get('missing'), {});
    assert.deepEqual(await fake.chrome.storage.local.get(['a', 'missing']), { a: 1 });
    assert.deepEqual(await fake.chrome.storage.local.get(), { a: 1, b: { deep: [1, 2] } });
    assert.deepEqual(await fake.chrome.storage.local.get({ a: 'default', c: 'default' }),
      { a: 1, c: 'default' });
  });

  test('stored values are cloned on the way in and on the way out', async () => {
    const value = { list: [1] };
    await fake.chrome.storage.local.set({ a: value });
    value.list.push(2);

    const first = await fake.chrome.storage.local.get('a');
    assert.deepEqual(first.a, { list: [1] });

    first.a.list.push(3);
    const second = await fake.chrome.storage.local.get('a');
    assert.deepEqual(second.a, { list: [1] });
  });

  test('set reports oldValue only once a key exists', async () => {
    const seen = [];
    fake.chrome.storage.onChanged.addListener((changes, area) => seen.push([changes, area]));

    await fake.chrome.storage.local.set({ a: 1 });
    await fake.chrome.storage.local.set({ a: 2 });
    await fake.chrome.storage.local.remove('a');
    await fake.chrome.storage.local.remove('a');

    assert.deepEqual(seen, [
      [{ a: { newValue: 1 } }, 'local'],
      [{ a: { oldValue: 1, newValue: 2 } }, 'local'],
      [{ a: { oldValue: 2 } }, 'local'],
    ]);
  });

  test('reset clears the store, the listeners and the counters', async () => {
    fake.seed({ a: 1 });
    fake.chrome.storage.onChanged.addListener(() => {});
    await fake.chrome.storage.local.get('a');

    resetFakeBrowser();

    assert.deepEqual(fake.keys(), []);
    assert.equal(fake.listenerCount(), 0);
    assert.equal(fake.calls.get, 0);
    assert.equal(fake.calls.set, 0);
    assert.equal(fake.calls.remove, 0);
  });

  test('installing again keeps the namespace storage.js already captured', () => {
    const before = globalThis.chrome;
    const again = installFakeBrowser({ a: 1 });
    assert.equal(again.chrome, before);
    assert.equal(globalThis.chrome, before);
    assert.deepEqual(again.value('a'), 1);
  });
});

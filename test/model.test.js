import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newId,
  isValidHeaderName,
  isValidHeaderValue,
  isUnmodifiableHeader,
  createHeader,
  createProfile,
  createSettings,
  createState,
  normalizeState,
  getActiveProfile,
  isHeaderApplicable,
  countApplicableHeaders,
  headerProblem,
  cloneProfile,
  nextProfileColor,
  uniqueProfileName,
} from '../src/lib/model.js';
import {
  SCHEMA_VERSION,
  PROFILE_COLORS,
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  MAX_PROFILES,
  MAX_HEADERS_PER_PROFILE,
} from '../src/lib/constants.js';

describe('newId', () => {
  test('hands out distinct non-empty ids', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) ids.add(newId());
    assert.equal(ids.size, 200);
    for (const id of ids) assert.equal(typeof id, 'string');
    for (const id of ids) assert.ok(id.length > 0);
  });
});

describe('isValidHeaderName', () => {
  test('accepts RFC 7230 tokens', () => {
    assert.equal(isValidHeaderName('X-Api-Key'), true);
    assert.equal(isValidHeaderName('authorization'), true);
    assert.equal(isValidHeaderName("!#$%&'*+-.^_`|~0123abcXYZ"), true);
  });

  test('rejects a space, a colon and an empty string', () => {
    assert.equal(isValidHeaderName('X Api Key'), false);
    assert.equal(isValidHeaderName('X-Api-Key: v'), false);
    assert.equal(isValidHeaderName('X-Api-Key:'), false);
    assert.equal(isValidHeaderName(''), false);
  });

  test('rejects separators, control characters and non-strings', () => {
    for (const bad of ['a(b', 'a)b', 'a,b', 'a;b', 'a/b', 'a@b', 'a=b', 'a[b', 'a"b', 'a\tb', 'a\nb']) {
      assert.equal(isValidHeaderName(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
    assert.equal(isValidHeaderName(undefined), false);
    assert.equal(isValidHeaderName(null), false);
    assert.equal(isValidHeaderName(42), false);
    assert.equal(isValidHeaderName(['X-A']), false);
  });

  test('rejects a name longer than 256 characters', () => {
    assert.equal(isValidHeaderName('a'.repeat(256)), true);
    assert.equal(isValidHeaderName('a'.repeat(257)), false);
  });
});

describe('isValidHeaderValue', () => {
  test('accepts an empty value and ordinary text', () => {
    assert.equal(isValidHeaderValue(''), true);
    assert.equal(isValidHeaderValue('Bearer abc.def'), true);
    assert.equal(isValidHeaderValue('a: b; c=d, e'), true);
  });

  test('rejects carriage return, newline and NUL', () => {
    assert.equal(isValidHeaderValue('a\rb'), false);
    assert.equal(isValidHeaderValue('a\nb'), false);
    assert.equal(isValidHeaderValue('a\r\nb'), false);
    assert.equal(isValidHeaderValue('trailing\n'), false);
    assert.equal(isValidHeaderValue('a\0b'), false);
  });

  test('rejects non-strings and an over-long value', () => {
    assert.equal(isValidHeaderValue(undefined), false);
    assert.equal(isValidHeaderValue(null), false);
    assert.equal(isValidHeaderValue(7), false);
    assert.equal(isValidHeaderValue('a'.repeat(8192)), true);
    assert.equal(isValidHeaderValue('a'.repeat(8193)), false);
  });
});

describe('isUnmodifiableHeader', () => {
  test('matches the browser-controlled names case-insensitively', () => {
    assert.equal(isUnmodifiableHeader('Host'), true);
    assert.equal(isUnmodifiableHeader('CONTENT-LENGTH'), true);
    assert.equal(isUnmodifiableHeader('connection'), true);
    assert.equal(isUnmodifiableHeader('X-Api-Key'), false);
    assert.equal(isUnmodifiableHeader(undefined), false);
    assert.equal(isUnmodifiableHeader(null), false);
  });
});

describe('createHeader', () => {
  test('fills every default', () => {
    const header = createHeader();
    assert.equal(typeof header.id, 'string');
    assert.ok(header.id.length > 0);
    assert.equal(header.enabled, true);
    assert.equal(header.name, '');
    assert.equal(header.value, '');
    assert.equal(header.target, 'request');
    assert.equal(header.operation, 'set');
    assert.equal(header.comment, '');
    assert.deepEqual(header.include, []);
    assert.deepEqual(header.resourceTypes, []);
    assert.deepEqual(Object.keys(header).sort(), [
      'comment', 'enabled', 'id', 'include', 'name', 'operation', 'resourceTypes', 'target', 'value',
    ]);
  });

  test('keeps good input', () => {
    const header = createHeader({
      id: 'h1',
      enabled: false,
      name: 'X-Api-Key',
      value: 'abc',
      target: 'response',
      operation: 'append',
      comment: 'why',
      include: ['example.com'],
      resourceTypes: ['script', 'xmlhttprequest'],
    });
    assert.equal(header.id, 'h1');
    assert.equal(header.enabled, false);
    assert.equal(header.name, 'X-Api-Key');
    assert.equal(header.value, 'abc');
    assert.equal(header.target, 'response');
    assert.equal(header.operation, 'append');
    assert.equal(header.comment, 'why');
    assert.deepEqual(header.include, ['example.com']);
    assert.deepEqual(header.resourceTypes, ['script', 'xmlhttprequest']);
  });

  test('coerces junk input', () => {
    const header = createHeader({
      id: 99,
      enabled: 'yes',
      name: 123,
      value: { a: 1 },
      target: 'trailer',
      operation: 'delete',
      comment: null,
      include: 42,
      resourceTypes: ['script', 'bogus', 7],
    });
    assert.notEqual(header.id, 99);
    assert.equal(typeof header.id, 'string');
    assert.equal(header.enabled, true);
    assert.equal(header.name, '');
    assert.equal(header.value, '');
    assert.equal(header.target, 'request');
    assert.equal(header.operation, 'set');
    assert.equal(header.comment, '');
    assert.deepEqual(header.include, []);
    assert.deepEqual(header.resourceTypes, ['script']);
  });

  test('splits a newline-separated include string and trims the entries', () => {
    const header = createHeader({ include: 'example.com\n  *.dev.local  \n\n' });
    assert.deepEqual(header.include, ['example.com', '*.dev.local']);
  });

  test('drops blank entries from an include array', () => {
    const header = createHeader({ include: [' example.com ', '', '   ', null, 'b.com'] });
    assert.deepEqual(header.include, ['example.com', 'b.com']);
  });

  test('splits a multi-line entry inside an include array', () => {
    const header = createHeader({ include: ['a.example.com\nb.example.com', ' c.com '] });
    assert.deepEqual(header.include, ['a.example.com', 'b.example.com', 'c.com']);
  });
});

describe('createProfile', () => {
  test('fills every default, including one blank header to edit', () => {
    const profile = createProfile();
    assert.equal(typeof profile.id, 'string');
    assert.equal(profile.name, 'Default');
    assert.equal(profile.color, PROFILE_COLORS[0]);
    assert.equal(profile.headers.length, 1);
    assert.equal(profile.headers[0].name, '');
    assert.deepEqual(profile.include, []);
    assert.deepEqual(profile.exclude, []);
    assert.deepEqual(profile.resourceTypes, []);
    assert.equal(profile.activeTabOnly, false);
    assert.deepEqual(Object.keys(profile).sort(), [
      'activeTabOnly', 'color', 'exclude', 'headers', 'id', 'include', 'name', 'resourceTypes',
    ]);
  });

  test('coerces junk input', () => {
    const profile = createProfile({
      id: null,
      name: 42,
      color: 'rebeccapurple',
      headers: 'nope',
      include: ['a.com', ''],
      exclude: 'b.com\nc.com',
      resourceTypes: ['image', 'nope'],
      activeTabOnly: 'true',
    });
    assert.equal(typeof profile.id, 'string');
    assert.ok(profile.id.length > 0);
    assert.equal(profile.name, 'Default');
    assert.equal(profile.color, PROFILE_COLORS[0]);
    assert.equal(profile.headers.length, 1);
    assert.deepEqual(profile.include, ['a.com']);
    assert.deepEqual(profile.exclude, ['b.com', 'c.com']);
    assert.deepEqual(profile.resourceTypes, ['image']);
    assert.equal(profile.activeTabOnly, false);
  });

  test('falls back to Default for a blank name and truncates a long one', () => {
    assert.equal(createProfile({ name: '' }).name, 'Default');
    assert.equal(createProfile({ name: 'x'.repeat(80) }).name, 'x'.repeat(60));
  });

  test('normalises the headers it is handed and keeps an empty list empty', () => {
    const profile = createProfile({ headers: [{ name: 'X-A', target: 'nope' }, { name: 'X-B' }] });
    assert.equal(profile.headers.length, 2);
    assert.equal(profile.headers[0].target, 'request');
    assert.equal(profile.headers[1].name, 'X-B');
    assert.notEqual(profile.headers[0].id, profile.headers[1].id);
    assert.deepEqual(createProfile({ headers: [] }).headers, []);
  });

  test('caps the headers at MAX_HEADERS_PER_PROFILE', () => {
    const many = Array.from({ length: MAX_HEADERS_PER_PROFILE + 10 }, (_, i) => ({ name: `X-${i}` }));
    assert.equal(createProfile({ headers: many }).headers.length, MAX_HEADERS_PER_PROFILE);
  });
});

describe('createSettings', () => {
  test('fills defaults, with request logging off', () => {
    assert.deepEqual(createSettings(), {
      logMatches: false,
      logLimit: DEFAULT_LOG_LIMIT,
      theme: 'light',
      showBadge: true,
      confirmDestructive: true,
      showTargetTag: true,
    });
  });

  test('clamps the log limit and rejects an unknown theme', () => {
    assert.equal(createSettings({ logLimit: 0 }).logLimit, 10);
    assert.equal(createSettings({ logLimit: 250.7 }).logLimit, 250);
    assert.equal(createSettings({ logLimit: MAX_LOG_LIMIT + 5000 }).logLimit, MAX_LOG_LIMIT);
    assert.equal(createSettings({ logLimit: 'abc' }).logLimit, DEFAULT_LOG_LIMIT);
    assert.equal(createSettings({ theme: 'neon' }).theme, 'light');
    assert.equal(createSettings({ theme: 'dark' }).theme, 'dark');
    assert.equal(createSettings({ theme: 'system' }).theme, 'system');
    assert.equal(createSettings({ logMatches: 'yes' }).logMatches, false);
    assert.equal(createSettings({ logMatches: true }).logMatches, true);
    assert.equal(createSettings({ showBadge: false }).showBadge, false);
  });
});

describe('createState', () => {
  test('builds a usable state from nothing', () => {
    const state = createState();
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.enabled, true);
    assert.equal(state.profiles.length, 1);
    assert.equal(state.activeProfileId, state.profiles[0].id);
    assert.equal(state.settings.logLimit, DEFAULT_LOG_LIMIT);
  });

  test('keeps a stored activeProfileId that still exists', () => {
    const state = createState({ profiles: [{ id: 'a' }, { id: 'b' }], activeProfileId: 'b' });
    assert.equal(state.activeProfileId, 'b');
  });

  test('falls back to the first profile when the stored id is missing', () => {
    for (const missing of ['gone', undefined, null, 7]) {
      const state = createState({ profiles: [{ id: 'a' }, { id: 'b' }], activeProfileId: missing });
      assert.equal(state.activeProfileId, 'a');
      assert.equal(getActiveProfile(state).id, 'a');
    }
  });

  test('creates a Default profile when the profiles list is unusable', () => {
    for (const profiles of [[], undefined, null, 'nope', 42, {}]) {
      const state = createState({ profiles });
      assert.equal(state.profiles.length, 1);
      assert.equal(state.profiles[0].name, 'Default');
      assert.equal(state.activeProfileId, state.profiles[0].id);
    }
  });

  test('caps the profiles at MAX_PROFILES', () => {
    const many = Array.from({ length: MAX_PROFILES + 5 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    assert.equal(createState({ profiles: many }).profiles.length, MAX_PROFILES);
  });

  test('honours a stored master switch', () => {
    assert.equal(createState({ enabled: false }).enabled, false);
    assert.equal(createState({ enabled: 'no' }).enabled, true);
  });
});

describe('normalizeState', () => {
  const assertValid = (state) => {
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(typeof state.enabled, 'boolean');
    assert.ok(Array.isArray(state.profiles));
    assert.ok(state.profiles.length >= 1);
    assert.ok(state.profiles.some((p) => p.id === state.activeProfileId));
    assert.equal(typeof state.settings.logLimit, 'number');
  };

  test('repairs null, undefined, a string, a number and an array', () => {
    for (const raw of [null, undefined, '', 'state', 0, 42, [], ['x'], true]) {
      const state = normalizeState(raw);
      assertValid(state);
      assert.equal(state.profiles.length, 1, `expected one profile for ${JSON.stringify(raw)}`);
    }
  });

  test('repairs a state whose profiles array is empty', () => {
    const state = normalizeState({ schemaVersion: 1, enabled: false, profiles: [], activeProfileId: 'gone' });
    assertValid(state);
    assert.equal(state.enabled, false);
    assert.equal(state.profiles.length, 1);
    assert.equal(state.profiles[0].name, 'Default');
  });

  test('repairs a partial state and keeps what was usable', () => {
    const state = normalizeState({
      profiles: [{ id: 'p1', name: 'Dev', headers: [{ name: 'X-A', value: '1' }] }],
      settings: { theme: 'dark' },
    });
    assertValid(state);
    assert.equal(state.profiles[0].name, 'Dev');
    assert.equal(state.profiles[0].headers[0].value, '1');
    assert.equal(state.settings.theme, 'dark');
    assert.equal(state.settings.logMatches, false);
  });

  test('does not hand back the object it was given', () => {
    const raw = { profiles: [{ id: 'p1', name: 'Dev' }] };
    const state = normalizeState(raw);
    assert.notEqual(state, raw);
    assert.notEqual(state.profiles[0], raw.profiles[0]);
  });
});

describe('getActiveProfile', () => {
  test('returns the active profile, or the first one when the id has drifted', () => {
    const state = createState({ profiles: [{ id: 'a' }, { id: 'b' }], activeProfileId: 'b' });
    assert.equal(getActiveProfile(state).id, 'b');
    state.activeProfileId = 'gone';
    assert.equal(getActiveProfile(state).id, 'a');
  });
});

describe('isHeaderApplicable', () => {
  test('needs the switch on', () => {
    assert.equal(isHeaderApplicable(createHeader({ enabled: false, name: 'X-A', value: '1' })), false);
    assert.equal(isHeaderApplicable(createHeader({ enabled: true, name: 'X-A', value: '1' })), true);
  });

  test('needs a valid name', () => {
    assert.equal(isHeaderApplicable(createHeader({ name: '', value: '1' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'X Api', value: '1' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'X-Api:', value: '1' })), false);
  });

  test('needs a value for set and append, but not for remove', () => {
    assert.equal(isHeaderApplicable(createHeader({ name: 'X-A', value: '', operation: 'set' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'X-A', value: '', operation: 'append' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'X-A', value: '', operation: 'remove' })), true);
    assert.equal(isHeaderApplicable(createHeader({ name: 'X-A', value: '1', operation: 'set' })), true);
  });

  test('rejects a browser-controlled name, which neither engine can change', () => {
    assert.equal(isHeaderApplicable(createHeader({ name: 'Host', value: 'x.dev' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'CONTENT-LENGTH', value: '10' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'connection', operation: 'remove' })), false);
    assert.equal(isHeaderApplicable(createHeader({ name: 'Proxy-Authorization', value: 'x' })), false);
  });
});

describe('countApplicableHeaders', () => {
  const state = createState({
    profiles: [
      {
        id: 'p1',
        headers: [
          { name: 'X-A', value: '1' },
          { name: 'X-B', value: '2', enabled: false },
          { name: 'X-C', value: '' },
          { name: 'X-D', value: '', operation: 'remove' },
          { name: 'bad name', value: '3' },
        ],
      },
      { id: 'p2', headers: [{ name: 'X-Z', value: '9' }] },
    ],
    activeProfileId: 'p1',
  });

  test('counts only the applicable headers of the active profile', () => {
    assert.equal(countApplicableHeaders(state), 2);
    assert.equal(countApplicableHeaders({ ...state, activeProfileId: 'p2' }), 1);
  });

  test('honours the master switch', () => {
    assert.equal(countApplicableHeaders({ ...state, enabled: false }), 0);
  });

  test('is zero for a profile with no headers', () => {
    assert.equal(countApplicableHeaders(createState({ profiles: [{ id: 'p1', headers: [] }] })), 0);
  });
});

describe('headerProblem', () => {
  const nameProblem = 'Header names may only contain letters, digits and ! # $ % & \' * + - . ^ _ ` | ~';

  test('stays quiet for an untouched row and a good header', () => {
    assert.equal(headerProblem(createHeader()), null);
    assert.equal(headerProblem(createHeader({ name: 'X-Api-Key', value: 'abc' })), null);
    assert.equal(headerProblem(createHeader({ name: 'X-Api-Key', operation: 'remove' })), null);
  });

  test('explains an invalid name', () => {
    assert.equal(headerProblem(createHeader({ name: 'X Api Key', value: 'a' })), nameProblem);
    assert.equal(headerProblem(createHeader({ name: 'X-Api-Key:', value: 'a' })), nameProblem);
  });

  test('explains a value with a line break', () => {
    const message = 'Header values cannot contain line breaks.';
    assert.equal(headerProblem({ ...createHeader({ name: 'X-A' }), value: 'a\nb' }), message);
    assert.equal(headerProblem({ ...createHeader({ name: 'X-A' }), value: 'a\rb' }), message);
  });

  test('explains a browser-controlled name, using the name as typed', () => {
    assert.equal(
      headerProblem(createHeader({ name: 'Host', value: 'x.dev' })),
      'The browser controls Host — extensions cannot change it.',
    );
    assert.equal(
      headerProblem(createHeader({ name: 'content-length', value: '10' })),
      'The browser controls content-length — extensions cannot change it.',
    );
  });

  test('asks for a value when set or append has none', () => {
    const message = 'Add a value, or switch the operation to Remove.';
    assert.equal(headerProblem(createHeader({ name: 'X-A', operation: 'set' })), message);
    assert.equal(headerProblem(createHeader({ name: 'X-A', operation: 'append' })), message);
  });

  test('warns that append only works on a fixed list of request headers', () => {
    assert.equal(
      headerProblem(createHeader({ name: 'X-A', value: '1', operation: 'append' })),
      'The browser only allows Append on a fixed list of request headers, '
        + 'and X-A is not one of them. Use Set instead.',
    );
    assert.equal(headerProblem(createHeader({ name: 'Accept-Language', value: 'tr', operation: 'append' })), null);
    assert.equal(headerProblem(createHeader({ name: 'ACCEPT', value: '*/*', operation: 'append' })), null);
  });

  test('leaves a response append alone, and never masks an earlier problem', () => {
    assert.equal(
      headerProblem(createHeader({ name: 'X-A', value: '1', operation: 'append', target: 'response' })),
      null,
    );
    assert.equal(headerProblem(createHeader({ name: 'X A', value: '1', operation: 'append' })), nameProblem);
    assert.equal(
      headerProblem(createHeader({ name: 'X-A', operation: 'append' })),
      'Add a value, or switch the operation to Remove.',
    );
  });
});

describe('uniqueProfileName', () => {
  const profiles = [
    createProfile({ id: 'p1', name: 'Dev' }),
    createProfile({ id: 'p2', name: 'Staging' }),
  ];

  test('returns the wanted name when it is free', () => {
    assert.equal(uniqueProfileName(profiles, 'Production'), 'Production');
  });

  test('suffixes a collision', () => {
    assert.equal(uniqueProfileName(profiles, 'Dev'), 'Dev 2');
  });

  test('compares case-insensitively but keeps the casing that was asked for', () => {
    assert.equal(uniqueProfileName(profiles, 'DEV'), 'DEV 2');
    assert.equal(uniqueProfileName(profiles, 'dev'), 'dev 2');
    assert.equal(uniqueProfileName(profiles, 'sTaGiNg'), 'sTaGiNg 2');
  });

  test('keeps counting past an existing suffix', () => {
    const taken = [...profiles, createProfile({ id: 'p3', name: 'Dev 2' })];
    assert.equal(uniqueProfileName(taken, 'Dev'), 'Dev 3');
  });

  test('ignores the profile being renamed', () => {
    assert.equal(uniqueProfileName(profiles, 'Dev', 'p1'), 'Dev');
    assert.equal(uniqueProfileName(profiles, 'Dev', 'p2'), 'Dev 2');
  });

  test('falls back to Profile for a blank name, and trims', () => {
    assert.equal(uniqueProfileName([], ''), 'Profile');
    assert.equal(uniqueProfileName([], '   '), 'Profile');
    assert.equal(uniqueProfileName([], null), 'Profile');
    assert.equal(uniqueProfileName([], '  Dev  '), 'Dev');
  });

  test('truncates to the 60 characters a profile name can hold', () => {
    assert.equal(uniqueProfileName([], 'x'.repeat(80)), 'x'.repeat(60));
  });
});

describe('nextProfileColor', () => {
  test('picks the first unused colour', () => {
    assert.equal(nextProfileColor([]), PROFILE_COLORS[0]);
    assert.equal(nextProfileColor([createProfile({ color: PROFILE_COLORS[0] })]), PROFILE_COLORS[1]);
    const used = PROFILE_COLORS.slice(0, 3).map((color) => createProfile({ color }));
    assert.equal(nextProfileColor(used), PROFILE_COLORS[3]);
  });

  test('reuses colours once every one is taken', () => {
    const all = PROFILE_COLORS.map((color) => createProfile({ color }));
    assert.equal(nextProfileColor(all), PROFILE_COLORS[all.length % PROFILE_COLORS.length]);
    assert.ok(PROFILE_COLORS.includes(nextProfileColor(all)));
  });
});

describe('cloneProfile', () => {
  const source = createProfile({
    id: 'p1',
    name: 'Dev',
    color: PROFILE_COLORS[2],
    headers: [{ id: 'h1', name: 'X-A', value: '1' }, { id: 'h2', name: 'X-B', value: '2' }],
    include: ['example.com'],
    exclude: ['admin.example.com'],
    resourceTypes: ['script'],
    activeTabOnly: true,
  });

  test('gives the copy and every header a fresh id', () => {
    const copy = cloneProfile(source);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.headers.length, 2);
    assert.notEqual(copy.headers[0].id, 'h1');
    assert.notEqual(copy.headers[1].id, 'h2');
    assert.notEqual(copy.headers[0].id, copy.headers[1].id);
    assert.equal(source.headers[0].id, 'h1');
  });

  test('carries the settings across and names the copy', () => {
    const copy = cloneProfile(source);
    assert.equal(copy.name, 'Dev copy');
    assert.equal(copy.color, PROFILE_COLORS[2]);
    assert.deepEqual(copy.include, ['example.com']);
    assert.deepEqual(copy.exclude, ['admin.example.com']);
    assert.deepEqual(copy.resourceTypes, ['script']);
    assert.equal(copy.activeTabOnly, true);
    assert.deepEqual(copy.headers.map((h) => [h.name, h.value]), [['X-A', '1'], ['X-B', '2']]);
  });

  test('accepts a name for the copy', () => {
    assert.equal(cloneProfile(source, 'Dev 2').name, 'Dev 2');
  });

  test('shares nothing mutable with the source', () => {
    const copy = cloneProfile(source);
    copy.headers[0].value = 'changed';
    copy.include.push('other.com');
    assert.equal(source.headers[0].value, '1');
    assert.deepEqual(source.include, ['example.com']);
  });
});

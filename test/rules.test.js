import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRules,
  describeRule,
  MAX_UNSAFE_DYNAMIC_RULES,
  MAX_REGEX_RULES,
} from '../src/lib/rules.js';
import { compilePattern } from '../src/lib/matcher.js';
import { createHeader, createProfile, createState } from '../src/lib/model.js';
import {
  RULE_ID_BASE,
  ALLOW_RULE_PRIORITY,
  MODIFY_RULE_PRIORITY,
  RESOURCE_TYPES,
} from '../src/lib/constants.js';

// ---------------------------------------------------------------- fixtures

/** A state whose active profile is the one described by `patch`. */
function stateWith(patch = {}, statePatch = {}) {
  const profile = createProfile({ id: 'p1', name: 'Test', headers: [], ...patch });
  return createState({ activeProfileId: 'p1', profiles: [profile], ...statePatch });
}

const header = (patch) => createHeader(patch);

const RULE_KEYS = ['id', 'priority', 'action', 'condition'];
const CONDITION_KEYS = [
  'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'resourceTypes', 'tabIds',
];
const ENTRY_KEYS = ['header', 'operation', 'value'];

/** Chrome rejects the whole update on an unknown property, so guard the shape. */
function assertValidRule(rule) {
  assert.deepEqual(Object.keys(rule).sort(), [...RULE_KEYS].sort());
  assert.ok(Number.isInteger(rule.id) && rule.id >= 1, `id ${rule.id} must be a positive integer`);
  assert.ok(Number.isInteger(rule.priority) && rule.priority >= 1);
  assert.ok(['modifyHeaders', 'allow'].includes(rule.action.type));

  for (const key of Object.keys(rule.condition)) {
    assert.ok(CONDITION_KEYS.includes(key), `unexpected condition key ${key}`);
  }
  assert.equal(typeof rule.condition.isUrlFilterCaseSensitive, 'boolean');
  assert.ok(
    !('urlFilter' in rule.condition) || !('regexFilter' in rule.condition),
    'only one of urlFilter or regexFilter may be set'
  );
  assert.ok('urlFilter' in rule.condition || 'regexFilter' in rule.condition);
  // Omitting resourceTypes means every type except main_frame, so it is always
  // explicit, and an empty array is not a legal value.
  assert.ok(Array.isArray(rule.condition.resourceTypes), 'resourceTypes must always be present');
  assert.ok(rule.condition.resourceTypes.length > 0, 'resourceTypes must never be empty');
  for (const type of rule.condition.resourceTypes) {
    assert.ok(typeof type === 'string' && type.length > 0, `bad resource type ${type}`);
  }

  if (rule.action.type === 'allow') {
    assert.deepEqual(Object.keys(rule.action), ['type']);
    return;
  }
  const entries = [...(rule.action.requestHeaders || []), ...(rule.action.responseHeaders || [])];
  assert.ok(entries.length > 0, 'a modifyHeaders rule must carry at least one modification');
  for (const entry of entries) {
    for (const key of Object.keys(entry)) assert.ok(ENTRY_KEYS.includes(key), `bad entry key ${key}`);
    assert.ok(['set', 'append', 'remove'].includes(entry.operation));
    assert.equal(entry.header, entry.header.toLowerCase());
    if (entry.operation === 'remove') assert.ok(!('value' in entry));
    else assert.equal(typeof entry.value, 'string');
  }
}

/** Every test runs the shape check, so no case can invent a bad rule quietly. */
function build(state, options) {
  const result = buildRules(state, options);
  assert.ok(Array.isArray(result.dynamic) && Array.isArray(result.session));
  assert.ok(Array.isArray(result.warnings) && Array.isArray(result.regexRuleIds));
  const all = [...result.dynamic, ...result.session];
  all.forEach(assertValidRule);
  const ids = all.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids must be unique');
  return result;
}

const modifyRules = (result) => [...result.dynamic, ...result.session]
  .filter((r) => r.action.type === 'modifyHeaders');
const allowRules = (result) => [...result.dynamic, ...result.session]
  .filter((r) => r.action.type === 'allow');

// ---------------------------------------------------------------- nothing to do

test('a disabled extension produces no rules', () => {
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1' })] }, { enabled: false });
  const result = build(state);
  assert.deepEqual(result.dynamic, []);
  assert.deepEqual(result.session, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.regexRuleIds, []);
});

test('a profile with no headers produces no rules', () => {
  const result = build(stateWith({ headers: [] }));
  assert.deepEqual(result.dynamic, []);
  assert.deepEqual(result.session, []);
});

test('headers that do not apply produce no rules', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-off', value: '1', enabled: false }),
      header({ name: '', value: '1' }),
      header({ name: 'bad name', value: '1' }),
      header({ name: 'x-empty', value: '' }),
    ],
  });
  const result = build(state);
  assert.deepEqual(result.dynamic, []);
  assert.deepEqual(result.session, []);
});

test('only the active profile applies', () => {
  const state = createState({
    activeProfileId: 'p2',
    profiles: [
      createProfile({ id: 'p1', name: 'One', headers: [header({ name: 'x-one', value: '1' })] }),
      createProfile({ id: 'p2', name: 'Two', headers: [header({ name: 'x-two', value: '2' })] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 1);
  assert.deepEqual(result.dynamic[0].action.requestHeaders, [
    { header: 'x-two', operation: 'set', value: '2' },
  ]);
});

// ---------------------------------------------------------------- the basic rule

test('an empty include list yields one rule matching every URL', () => {
  const state = stateWith({ headers: [header({ name: 'X-Api-Key', value: 'abc' })] });
  const result = build(state);

  assert.equal(result.session.length, 0);
  assert.equal(result.dynamic.length, 1);
  const rule = result.dynamic[0];
  assert.equal(rule.id, RULE_ID_BASE);
  assert.equal(rule.priority, MODIFY_RULE_PRIORITY);
  assert.deepEqual(rule.action, {
    type: 'modifyHeaders',
    requestHeaders: [{ header: 'x-api-key', operation: 'set', value: 'abc' }],
  });
  assert.deepEqual(rule.condition, {
    urlFilter: '*',
    isUrlFilterCaseSensitive: false,
    resourceTypes: RESOURCE_TYPES,
  });
  assert.deepEqual(result.regexRuleIds, []);
  assert.deepEqual(result.warnings, []);
});

test('a bare asterisk pattern also uses urlFilter, not a regex slot', () => {
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1', include: ['*'] })] });
  const result = build(state);
  assert.deepEqual(result.dynamic[0].condition, {
    urlFilter: '*',
    isUrlFilterCaseSensitive: false,
    resourceTypes: RESOURCE_TYPES,
  });
  assert.deepEqual(result.regexRuleIds, []);
});

test('remove contributes an entry with no value key', () => {
  const state = stateWith({
    headers: [header({ name: 'Referer', operation: 'remove', value: 'ignored' })],
  });
  const rule = build(state).dynamic[0];
  const entry = rule.action.requestHeaders[0];
  assert.deepEqual(Object.keys(entry), ['header', 'operation']);
  assert.equal(entry.operation, 'remove');
  assert.ok(!('value' in entry));
});

test('append keeps its value', () => {
  const state = stateWith({
    headers: [header({ name: 'Cookie', operation: 'append', value: 'a=1' })],
  });
  const rule = build(state).dynamic[0];
  assert.deepEqual(rule.action.requestHeaders, [
    { header: 'cookie', operation: 'append', value: 'a=1' },
  ]);
});

test('a request append outside the browser allowlist is skipped with a warning', () => {
  const state = stateWith({
    headers: [
      header({ name: 'X-Trace-Id', operation: 'append', value: 'abc' }),
      header({ name: 'Accept', operation: 'append', value: 'text/plain' }),
    ],
  });
  const result = build(state);
  // One rejected append would fail the whole atomic update, so it never ships.
  assert.equal(result.dynamic.length, 1);
  assert.deepEqual(result.dynamic[0].action.requestHeaders, [
    { header: 'accept', operation: 'append', value: 'text/plain' },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('X-Trace-Id'), result.warnings[0]);
  assert.ok(result.warnings[0].includes('append'), result.warnings[0]);
});

test('the append allowlist applies to request headers only', () => {
  const state = stateWith({
    headers: [header({ name: 'X-Trace-Id', operation: 'append', value: 'abc', target: 'response' })],
  });
  const result = build(state);
  assert.deepEqual(result.dynamic[0].action.responseHeaders, [
    { header: 'x-trace-id', operation: 'append', value: 'abc' },
  ]);
  assert.deepEqual(result.warnings, []);
});

test('a browser-controlled header produces no rule', () => {
  const state = stateWith({
    headers: [
      header({ name: 'Host', value: 'evil.example' }),
      header({ name: 'Content-Length', value: '0' }),
      header({ name: 'x-ok', value: '1' }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 1);
  assert.deepEqual(result.dynamic[0].action.requestHeaders, [
    { header: 'x-ok', operation: 'set', value: '1' },
  ]);
});

// ---------------------------------------------------------------- grouping

test('two headers sharing include, resource types and target land in one rule', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-a', value: '1', include: ['example.com'] }),
      header({ name: 'x-b', value: '2', include: ['example.com'] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 1);
  assert.deepEqual(result.dynamic[0].action.requestHeaders, [
    { header: 'x-a', operation: 'set', value: '1' },
    { header: 'x-b', operation: 'set', value: '2' },
  ]);
});

test('request and response changes for one condition share a single rule', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-req', value: '1', target: 'request' }),
      header({ name: 'x-res', value: '2', target: 'response' }),
      header({ name: 'x-frame-options', target: 'response', operation: 'remove' }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 1);
  const action = result.dynamic[0].action;
  assert.deepEqual(action.requestHeaders, [{ header: 'x-req', operation: 'set', value: '1' }]);
  assert.deepEqual(action.responseHeaders, [
    { header: 'x-res', operation: 'set', value: '2' },
    { header: 'x-frame-options', operation: 'remove' },
  ]);
});

test('a rule omits the header array it does not use', () => {
  const state = stateWith({ headers: [header({ name: 'x-res', value: '1', target: 'response' })] });
  const action = build(state).dynamic[0].action;
  assert.ok(!('requestHeaders' in action));
  assert.deepEqual(Object.keys(action), ['type', 'responseHeaders']);
});

test('different include lists produce different rules', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-a', value: '1', include: ['a.example'] }),
      header({ name: 'x-b', value: '2', include: ['b.example'] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 2);
  assert.deepEqual(result.dynamic.map((r) => r.condition.regexFilter), [
    compilePattern('a.example').source,
    compilePattern('b.example').source,
  ]);
});

test('the same include list in a different order is still one group', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-a', value: '1', include: ['a.example', 'b.example'] }),
      header({ name: 'x-b', value: '2', include: ['b.example', 'a.example'] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 2);
  for (const rule of result.dynamic) assert.equal(rule.action.requestHeaders.length, 2);
});

test('one rule per include pattern', () => {
  const state = stateWith({
    headers: [header({ name: 'x-a', value: '1', include: ['a.example', 'b.example', 'c.example'] })],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 3);
  assert.deepEqual(result.dynamic.map((r) => r.id), [RULE_ID_BASE, RULE_ID_BASE + 1, RULE_ID_BASE + 2]);
  for (const rule of result.dynamic) {
    assert.deepEqual(rule.action.requestHeaders, [{ header: 'x-a', operation: 'set', value: '1' }]);
  }
});

test('duplicate include patterns do not produce duplicate rules', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-a', value: '1', include: ['dup.example', 'dup.example'] }),
      header({ name: 'x-a', value: '1', include: ['dup.example'] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 1);
  assert.deepEqual(result.dynamic[0].action.requestHeaders, [
    { header: 'x-a', operation: 'set', value: '1' },
  ]);
});

test('a header falls back to the profile include list', () => {
  const state = stateWith({
    include: ['shop.example'],
    headers: [
      header({ name: 'x-a', value: '1' }),
      header({ name: 'x-b', value: '2', include: ['api.example'] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 2);
  assert.deepEqual(result.dynamic.map((r) => r.condition.regexFilter), [
    compilePattern('shop.example').source,
    compilePattern('api.example').source,
  ]);
});

// ---------------------------------------------------------------- conditions

test('a real pattern becomes a regexFilter that matches the compiled source', () => {
  const patterns = ['example.com', 'https://api.example.com/*', '/^https:\\/\\/x\\.test\\//i'];
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1', include: patterns })] });
  const result = build(state);
  assert.equal(result.dynamic.length, 3);
  result.dynamic.forEach((rule, i) => {
    assert.equal(rule.condition.regexFilter, compilePattern(patterns[i]).source);
    assert.ok(!('urlFilter' in rule.condition));
  });
  assert.deepEqual(result.regexRuleIds, result.dynamic.map((r) => r.id));
});

test('resource types come from the header, then the profile, then every type', () => {
  const state = stateWith({
    resourceTypes: ['main_frame'],
    headers: [
      header({ name: 'x-a', value: '1' }),
      header({ name: 'x-b', value: '2', resourceTypes: ['xmlhttprequest', 'script'] }),
    ],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 2);
  assert.deepEqual(result.dynamic[0].condition.resourceTypes, ['main_frame']);
  assert.deepEqual(result.dynamic[1].condition.resourceTypes, ['xmlhttprequest', 'script']);

  // An omitted list would mean every type but main_frame, so the page load the
  // user cares about most would never get the header.
  const bare = build(stateWith({ headers: [header({ name: 'x-a', value: '1' })] }));
  assert.deepEqual(bare.dynamic[0].condition.resourceTypes, RESOURCE_TYPES);
  assert.ok(bare.dynamic[0].condition.resourceTypes.includes('main_frame'));
});

test('every type means the vocabulary the caller supplies', () => {
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1' })] });
  // Firefox has no webtransport or webbundle, and one unknown value would make
  // it reject the whole rule.
  const gecko = ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'];
  const result = build(state, { allResourceTypes: gecko });
  assert.deepEqual(result.dynamic[0].condition.resourceTypes, gecko);
});

test('a supplied vocabulary never overrides a narrowed list', () => {
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1', resourceTypes: ['script'] })] });
  const result = build(state, { allResourceTypes: ['main_frame', 'script'] });
  assert.deepEqual(result.dynamic[0].condition.resourceTypes, ['script']);
});

test('an unusable vocabulary falls back to the built-in list', () => {
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1' })] });
  for (const supplied of [undefined, [], ['', null, undefined], 'main_frame', {}]) {
    const result = build(state, { allResourceTypes: supplied });
    assert.deepEqual(result.dynamic[0].condition.resourceTypes, RESOURCE_TYPES);
  }
});

test('a regex without the i flag stays case sensitive', () => {
  const patterns = [
    '/^https:\\/\\/API\\.example\\.com\\//',
    '/^https:\\/\\/api\\.example\\.org\\//i',
    'host.example',
    'https://*.glob.example/*',
  ];
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1', include: patterns })] });
  const result = build(state);
  // matcher.js is the single source of truth: DNR must match the same URLs the
  // fallback engine and the request log do.
  assert.deepEqual(result.dynamic.map((r) => r.condition.isUrlFilterCaseSensitive), [
    true, false, false, false,
  ]);
});

test('resource types split otherwise identical headers into separate rules', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-a', value: '1', resourceTypes: ['script'] }),
      header({ name: 'x-b', value: '2', resourceTypes: ['image'] }),
    ],
  });
  assert.equal(build(state).dynamic.length, 2);
});

// ---------------------------------------------------------------- excludes

test('every exclude pattern adds an allow rule that outranks the changes', () => {
  const state = stateWith({
    resourceTypes: ['main_frame'],
    exclude: ['no.example', 'skip.example'],
    headers: [header({ name: 'x-a', value: '1' })],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 3);

  const allows = allowRules(result);
  assert.equal(allows.length, 2);
  assert.ok(ALLOW_RULE_PRIORITY > MODIFY_RULE_PRIORITY);
  const modifyTypes = modifyRules(result)[0].condition.resourceTypes;
  assert.deepEqual(modifyTypes, ['main_frame']);
  for (const rule of allows) {
    assert.equal(rule.priority, ALLOW_RULE_PRIORITY);
    assert.deepEqual(rule.action, { type: 'allow' });
    // Every type, so the allow rule is a superset of every modify rule in the
    // batch: an exclude has to win for every header in the profile.
    assert.deepEqual(rule.condition.resourceTypes, RESOURCE_TYPES);
    for (const type of modifyTypes) assert.ok(rule.condition.resourceTypes.includes(type));
  }
  assert.deepEqual(allows.map((r) => r.condition.regexFilter), [
    compilePattern('no.example').source,
    compilePattern('skip.example').source,
  ]);
});

test('duplicate exclude patterns add only one allow rule', () => {
  const state = stateWith({
    exclude: ['no.example', 'no.example'],
    headers: [header({ name: 'x-a', value: '1' })],
  });
  assert.equal(allowRules(build(state)).length, 1);
});

test('excludes alone produce nothing when no header applies', () => {
  const state = stateWith({ exclude: ['no.example'], headers: [] });
  const result = build(state);
  assert.deepEqual(result.dynamic, []);
  assert.deepEqual(result.session, []);
});

// ---------------------------------------------------------------- tab scoping

test('activeTabOnly routes every rule to session with the tab id', () => {
  const state = stateWith({
    activeTabOnly: true,
    exclude: ['no.example'],
    headers: [header({ name: 'x-a', value: '1' })],
  });
  const result = build(state, { activeTabId: 42 });
  assert.deepEqual(result.dynamic, []);
  assert.equal(result.session.length, 2);
  for (const rule of result.session) assert.deepEqual(rule.condition.tabIds, [42]);
  assert.equal(modifyRules(result).length, 1);
  assert.equal(allowRules(result).length, 1);
});

test('activeTabOnly without a tab id sends nothing at all', () => {
  const state = stateWith({
    activeTabOnly: true,
    exclude: ['no.example'],
    headers: [header({ name: 'Authorization', value: 'Bearer secret' })],
  });
  for (const options of [{}, { activeTabId: null }, { activeTabId: undefined }, { activeTabId: 1.5 }, undefined]) {
    const result = build(state, options);
    // Falling back to a dynamic rule would carry the header into every tab.
    assert.deepEqual(result.dynamic, []);
    assert.deepEqual(result.session, []);
    assert.deepEqual(result.warnings, [
      'No active tab was found, so the active-tab headers are not being sent.',
    ]);
  }
});

test('a profile that is not tab scoped never carries tabIds', () => {
  const state = stateWith({ headers: [header({ name: 'x-a', value: '1' })] });
  const result = build(state, { activeTabId: 7 });
  assert.equal(result.session.length, 0);
  assert.ok(!('tabIds' in result.dynamic[0].condition));
});

// ---------------------------------------------------------------- bad patterns

test('a pattern RE2 cannot match is skipped with a warning naming it', () => {
  const state = stateWith({
    headers: [header({ name: 'x-a', value: '1', include: ['/foo(?=bar)/', 'ok.example'] })],
  });
  const result = build(state);
  assert.equal(result.dynamic.length, 1);
  assert.equal(result.dynamic[0].condition.regexFilter, compilePattern('ok.example').source);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('/foo(?=bar)/'), result.warnings[0]);
  assert.ok(/RE2/.test(result.warnings[0]), result.warnings[0]);
});

test('lookbehind and backreferences are skipped too', () => {
  const state = stateWith({
    headers: [header({ name: 'x-a', value: '1', include: ['/(?<=a)b/', '/(a)\\1/'] })],
  });
  const result = build(state);
  assert.deepEqual(result.dynamic, []);
  assert.equal(result.warnings.length, 2);
});

test('an unparsable pattern is skipped with a warning', () => {
  const state = stateWith({
    headers: [header({ name: 'x-a', value: '1', include: ['/(unclosed/'] })],
  });
  const result = build(state);
  assert.deepEqual(result.dynamic, []);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('/(unclosed/'), result.warnings[0]);
});

test('the same bad pattern warns once', () => {
  const state = stateWith({
    headers: [
      header({ name: 'x-a', value: '1', include: ['/foo(?=bar)/'] }),
      header({ name: 'x-b', value: '2', include: ['/foo(?=bar)/'], resourceTypes: ['script'] }),
    ],
  });
  assert.equal(build(state).warnings.length, 1);
});

test('an unusable exclude fails closed: the whole profile stops applying', () => {
  const state = stateWith({
    include: ['example.com'],
    exclude: ['/^https:\\/\\/(?!api\\.)admin\\.example\\.com\\//'],
    headers: [header({ name: 'Authorization', value: 'Bearer secret' })],
  });
  const result = build(state);
  // Shipping the include without the exclude would send the credential to the
  // one host the user ruled out.
  assert.deepEqual(result.dynamic, []);
  assert.deepEqual(result.session, []);
  assert.equal(modifyRules(result).length, 0);
  assert.equal(allowRules(result).length, 0);
  const named = result.warnings.find((w) => w.includes('is not being applied'));
  assert.ok(named, result.warnings.join(' | '));
  assert.ok(named.includes('(?!api\\.)'), named);
});

test('an unparsable exclude fails closed too', () => {
  const state = stateWith({
    exclude: ['ok.example', '/(unclosed/'],
    headers: [header({ name: 'x-a', value: '1' })],
  });
  const result = build(state);
  assert.deepEqual(result.dynamic, []);
  assert.deepEqual(result.session, []);
  assert.ok(result.warnings.some((w) => w.includes('/(unclosed/')), result.warnings.join(' | '));
  assert.ok(result.warnings.some((w) => w.includes('is not being applied')));
});

// ---------------------------------------------------------------- the cap

test('rules beyond the unsafe cap are trimmed and the warning names the count', () => {
  const include = [];
  for (let i = 0; i < MAX_UNSAFE_DYNAMIC_RULES + 100; i += 1) include.push(`host${i}.example`);
  const state = stateWith({
    exclude: ['no.example', 'skip.example'],
    headers: [header({ name: 'x-a', value: '1', include })],
  });
  const result = build(state);

  // The two excludes are kept, so 102 of the 5102 candidates lose their slot to
  // the unsafe cap, and the regex ceiling then trims what is left to 1000.
  const capped = result.warnings.find((w) => w.includes('header rules at a time'));
  assert.ok(capped, result.warnings.join(' | '));
  assert.ok(capped.includes('Dropped 102'), capped);

  assert.equal(result.dynamic.length, MAX_REGEX_RULES);
  assert.equal(result.session.length, 0);
  assert.equal(allowRules(result).length, 2);
  assert.equal(modifyRules(result).length, MAX_REGEX_RULES - 2);

  const ids = result.dynamic.map((r) => r.id);
  assert.equal(new Set(ids).size, MAX_REGEX_RULES);
  assert.equal(Math.min(...ids), RULE_ID_BASE);
  assert.equal(Math.max(...ids), RULE_ID_BASE + MAX_REGEX_RULES - 1);
});

test('regex rules beyond the ceiling are trimmed, excludes keeping their slots', () => {
  const include = [];
  for (let i = 0; i < 1200; i += 1) include.push(`host${i}.example`);
  const state = stateWith({
    exclude: ['no.example'],
    headers: [header({ name: 'x-a', value: '1', include })],
  });
  const result = build(state);
  // Submitting 1201 regex rules would make Chrome refuse the batch, leaving no
  // headers applied at all.
  assert.equal(result.dynamic.length, MAX_REGEX_RULES);
  assert.equal(result.regexRuleIds.length, MAX_REGEX_RULES);
  assert.equal(allowRules(result).length, 1);
  assert.equal(modifyRules(result).length, MAX_REGEX_RULES - 1);
  const dropped = result.warnings.find((w) => w.includes('URL patterns'));
  assert.ok(dropped, result.warnings.join(' | '));
  assert.ok(dropped.includes('Dropped 201'), dropped);
});

// ---------------------------------------------------------------- describeRule

test('describeRule reads as one sentence', () => {
  const state = stateWith({
    headers: [
      header({ name: 'X-Api-Key', value: 'abc', resourceTypes: ['xmlhttprequest', 'main_frame'] }),
      header({ name: 'Referer', operation: 'remove', resourceTypes: ['main_frame', 'xmlhttprequest'] }),
      header({
        name: 'X-Frame-Options',
        operation: 'remove',
        target: 'response',
        resourceTypes: ['xmlhttprequest', 'main_frame'],
      }),
    ],
  });
  const rule = build(state).dynamic[0];
  assert.equal(
    describeRule(rule),
    'Set request x-api-key, remove request referer, remove response x-frame-options on every URL (XHR / fetch, Page)'
  );
});

test('describeRule names the pattern, and the tab scope', () => {
  const state = stateWith({
    activeTabOnly: true,
    headers: [header({ name: 'x-a', value: '1', include: ['api.example'] })],
  });
  const rule = build(state, { activeTabId: 9 }).session[0];
  const source = compilePattern('api.example').source;
  assert.equal(describeRule(rule), `Set request x-a on /${source}/, active tab only`);
});

test('describeRule explains an allow rule', () => {
  const state = stateWith({
    exclude: ['no.example'],
    headers: [header({ name: 'x-a', value: '1' })],
  });
  const rule = allowRules(build(state))[0];
  const source = compilePattern('no.example').source;
  assert.equal(describeRule(rule), `Leave headers untouched on /${source}/`);
});

test('describeRule never throws on a rule it did not build', () => {
  assert.equal(describeRule(null), '');
  assert.equal(describeRule({}), 'Change nothing on every URL');
  assert.equal(
    describeRule({ action: { type: 'modifyHeaders' }, condition: { urlFilter: '||api.test' } }),
    'Change nothing on ||api.test'
  );
});

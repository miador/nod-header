import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportPayload, serialize, suggestFilename, parseImport } from '../src/lib/portable.js';
import { createState, createProfile, createHeader } from '../src/lib/model.js';
import { urlMatchesFilters } from '../src/lib/matcher.js';
import { buildRules } from '../src/lib/rules.js';
import {
  EXPORT_FORMAT, EXPORT_VERSION, MAX_PROFILES, MAX_HEADERS_PER_PROFILE, PROFILE_COLORS,
} from '../src/lib/constants.js';

/** Fixed instants: one for exportedAt (UTC), one built locally for filenames. */
const NOW_UTC = new Date('2026-07-29T12:34:56.000Z');
const NOW_LOCAL = new Date(2026, 6, 29, 12, 0, 0);

function sampleState() {
  return createState({
    profiles: [
      createProfile({
        id: 'p-dev',
        name: 'Development API',
        color: PROFILE_COLORS[1],
        include: ['api.example.com'],
        exclude: ['/^https:\\/\\/api\\.example\\.com\\/health/'],
        resourceTypes: ['xmlhttprequest'],
        headers: [
          createHeader({ id: 'h-1', name: 'Authorization', value: 'Bearer dev', comment: 'local only' }),
          createHeader({ id: 'h-2', name: 'X-Trace', value: 'off', enabled: false }),
          createHeader({ id: 'h-3', name: 'Server', operation: 'remove', target: 'response' }),
        ],
      }),
      createProfile({
        id: 'p-prod',
        name: 'Production read only',
        activeTabOnly: true,
        headers: [createHeader({ id: 'h-4', name: 'X-Env', value: 'prod' })],
      }),
    ],
    activeProfileId: 'p-dev',
  });
}

const stripIds = (profile) => ({
  ...profile,
  id: undefined,
  headers: profile.headers.map((h) => ({ ...h, id: undefined })),
});

const mentions = (warnings, needle) => warnings.some((w) => w.includes(needle));

/**
 * A ModHeader export, in the shape the extension really writes: a bare array of
 * profiles, the first using the newer *Filters arrays and the second the older
 * `filters` array.
 */
function modHeaderExport() {
  return [
    {
      title: 'Development API',
      shortTitle: 'D',
      version: 2,
      alwaysOn: true,
      hideComment: false,
      appendMode: false,
      color: '#ffc107',
      textColor: '#000000',
      headers: [
        { enabled: true, name: 'Authorization', value: 'Bearer dev-token', comment: 'local only' },
        { enabled: false, name: 'X-Debug', value: '1', comment: '' },
        { enabled: true, name: 'X-Empty', value: '', comment: '' },
      ],
      respHeaders: [
        { enabled: true, name: 'Access-Control-Allow-Origin', value: '*', comment: '' },
      ],
      urlFilters: [
        { enabled: true, urlRegex: 'https://api\\.example\\.com/.*' },
        { enabled: false, urlRegex: 'https://disabled\\.example\\.com/.*' },
      ],
      excludeUrlFilters: [
        { enabled: true, urlRegex: 'https://api\\.example\\.com/health' },
      ],
      resourceFilters: [
        { enabled: true, resourceType: ['xmlhttprequest', 'main_frame'] },
      ],
      tabFilters: [{ enabled: true, tabId: 42 }],
      tabGroupFilters: [{ enabled: true, tabGroupId: 7 }],
    },
    {
      title: 'Legacy staging',
      version: 1,
      appendMode: 'comma',
      headers: [
        { enabled: true, name: 'X-Forwarded-For', value: '10.0.0.1' },
        { enabled: true, name: null, value: 'lost' },
      ],
      respHeaders: [],
      filters: [
        { enabled: true, type: 'urls', urlRegex: '^https://staging\\.example\\.com/' },
        { enabled: true, type: 'excludeUrls', urlRegex: 'https://staging\\.example\\.com/static/.*' },
        { enabled: true, type: 'types', resourceType: ['script', 'stylesheet'] },
        { enabled: false, type: 'urls', urlRegex: 'https://off\\.example\\.com/.*' },
        { enabled: true, type: 'tabId', tabId: 3 },
      ],
    },
    {
      shortTitle: 'Cookies only',
      version: 2,
      headers: [{ enabled: true, name: 'X-Only-Short', value: 'yes' }],
      respHeaders: [],
      cookieHeaders: [{ enabled: true, name: 'session', value: 'abc' }],
      filters: [{ enabled: true, type: 'urls', urlPattern: 'https://*.short.example/*' }],
    },
  ];
}

test('exportPayload stamps the format, version and the supplied instant', () => {
  const payload = exportPayload(sampleState(), { now: NOW_UTC });
  assert.equal(payload.format, EXPORT_FORMAT);
  assert.equal(payload.version, EXPORT_VERSION);
  assert.equal(payload.exportedAt, '2026-07-29T12:34:56.000Z');
  assert.equal(payload.profiles.length, 2);
  assert.equal('settings' in payload, false);
});

test('exportPayload leaves ids out of the file', () => {
  const payload = exportPayload(sampleState(), { now: NOW_UTC });
  for (const profile of payload.profiles) {
    assert.equal('id' in profile, false);
    for (const header of profile.headers) assert.equal('id' in header, false);
  }
});

test('exportPayload keeps the full profile shape', () => {
  const [profile] = exportPayload(sampleState(), { profileIds: ['p-dev'], now: NOW_UTC }).profiles;
  assert.deepEqual(Object.keys(profile).sort(), [
    'activeTabOnly', 'color', 'exclude', 'headers', 'include', 'name', 'resourceTypes',
  ]);
  assert.deepEqual(profile.include, ['api.example.com']);
  assert.deepEqual(profile.resourceTypes, ['xmlhttprequest']);
  assert.equal(profile.headers.length, 3);
  assert.deepEqual(Object.keys(profile.headers[0]).sort(), [
    'comment', 'enabled', 'include', 'name', 'operation', 'resourceTypes', 'target', 'value',
  ]);
});

test('exportPayload narrows to the requested profiles and keeps state order', () => {
  const payload = exportPayload(sampleState(), { profileIds: ['p-prod', 'p-dev'], now: NOW_UTC });
  assert.deepEqual(payload.profiles.map((p) => p.name), ['Development API', 'Production read only']);

  const one = exportPayload(sampleState(), { profileIds: ['p-prod'], now: NOW_UTC });
  assert.deepEqual(one.profiles.map((p) => p.name), ['Production read only']);
});

test('exportPayload treats an empty or missing profileIds list as everything', () => {
  assert.equal(exportPayload(sampleState(), { profileIds: [], now: NOW_UTC }).profiles.length, 2);
  assert.equal(exportPayload(sampleState(), { now: NOW_UTC }).profiles.length, 2);
});

test('exportPayload includes settings only when asked', () => {
  const state = sampleState();
  state.settings.theme = 'dark';
  state.settings.logLimit = 42;
  const payload = exportPayload(state, { includeSettings: true, now: NOW_UTC });
  assert.equal(payload.settings.theme, 'dark');
  assert.equal(payload.settings.logLimit, 42);
  assert.deepEqual(Object.keys(payload.settings).sort(), [
    'confirmDestructive', 'logLimit', 'logMatches', 'showBadge', 'showTargetTag', 'theme',
  ]);
});

test('exportPayload survives a state with no profiles', () => {
  const payload = exportPayload({}, { now: NOW_UTC });
  assert.deepEqual(payload.profiles, []);
});

test('exportPayload falls back to the current time without options.now', () => {
  const before = Date.now();
  const payload = exportPayload(sampleState());
  const stamped = new Date(payload.exportedAt).getTime();
  assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000);
});

test('serialize writes indented JSON with a trailing newline', () => {
  const out = serialize(exportPayload(sampleState(), { now: NOW_UTC }));
  assert.ok(out.endsWith('}\n'));
  assert.ok(out.includes('\n  "format": "nod-header"'));
  assert.deepEqual(JSON.parse(out).version, EXPORT_VERSION);
});

test('a full export round trips through serialize and parseImport', () => {
  const state = sampleState();
  const text = serialize(exportPayload(state, { includeSettings: true, now: NOW_UTC }));
  const result = parseImport(text);

  assert.equal(result.source, 'nod-header');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.profiles.map(stripIds), state.profiles.map(stripIds));
  assert.deepEqual(result.settings, state.settings);
});

test('round tripped ids are fresh, so an import cannot overwrite a stored profile', () => {
  const state = sampleState();
  const result = parseImport(serialize(exportPayload(state, { now: NOW_UTC })));
  assert.notEqual(result.profiles[0].id, 'p-dev');
  assert.notEqual(result.profiles[0].headers[0].id, 'h-1');
  assert.ok(result.profiles[0].id);
});

test('parseImport rejects text that is not JSON', () => {
  assert.throws(() => parseImport('{ "profiles": [ '), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /not valid JSON/);
    return true;
  });
  assert.throws(() => parseImport(''), /not valid JSON/);
  assert.throws(() => parseImport('<html>nope</html>'), /not valid JSON/);
});

test('parseImport rejects JSON that holds no profile', () => {
  assert.throws(() => parseImport('[]'), /holds no profiles/);
  assert.throws(() => parseImport('null'), /holds no profiles/);
  assert.throws(() => parseImport('42'), /holds no profiles/);
  assert.throws(() => parseImport('"a string"'), /holds no profiles/);
  assert.throws(() => parseImport('{}'), /holds no profiles/);
  assert.throws(() => parseImport('[1, 2, 3]'), /holds no profiles/);
  assert.throws(() => parseImport('{"format":"nod-header","version":1,"profiles":[]}'), /holds no profiles/);
});

test('parseImport error messages never apologise', () => {
  for (const text of ['not json', '[]']) {
    let message = '';
    try {
      parseImport(text);
    } catch (err) {
      message = err.message;
    }
    assert.doesNotMatch(message, /sorry|oops|unfortunately|!/i);
  }
});

test('parseImport reads a bare array of our own profiles', () => {
  const payload = exportPayload(sampleState(), { now: NOW_UTC });
  const result = parseImport(JSON.stringify(payload.profiles));
  assert.equal(result.source, 'nod-header');
  assert.equal(result.settings, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.profiles.map((p) => p.name), ['Development API', 'Production read only']);
  assert.equal(result.profiles[0].headers[2].operation, 'remove');
  assert.equal(result.profiles[0].headers[2].target, 'response');
  assert.equal(result.profiles[1].activeTabOnly, true);
});

test('parseImport reads a single profile object', () => {
  const [profile] = exportPayload(sampleState(), { profileIds: ['p-dev'], now: NOW_UTC }).profiles;
  const result = parseImport(JSON.stringify(profile));
  assert.equal(result.source, 'nod-header');
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].name, 'Development API');
  assert.deepEqual(result.profiles[0].include, ['api.example.com']);
});

test('parseImport warns when the envelope has no format field', () => {
  const payload = exportPayload(sampleState(), { now: NOW_UTC });
  delete payload.format;
  const result = parseImport(JSON.stringify(payload));
  assert.equal(result.source, 'nod-header');
  assert.ok(mentions(result.warnings, 'no format field'));
  assert.equal(result.profiles.length, 2);
});

test('parseImport reports an unknown format but still reads the profiles', () => {
  const payload = exportPayload(sampleState(), { now: NOW_UTC });
  payload.format = 'some-other-tool';
  const result = parseImport(JSON.stringify(payload));
  assert.equal(result.source, 'unknown');
  assert.ok(mentions(result.warnings, 'some-other-tool'));
  assert.equal(result.profiles.length, 2);
});

test('parseImport skips entries that are not profiles and keeps the rest', () => {
  const [profile] = exportPayload(sampleState(), { profileIds: ['p-dev'], now: NOW_UTC }).profiles;
  const result = parseImport(JSON.stringify([profile, 'junk', 7, null]));
  assert.equal(result.profiles.length, 1);
  assert.ok(mentions(result.warnings, 'does not look like a profile'));
});

test('parseImport repairs invalid fields through the model', () => {
  const result = parseImport(JSON.stringify([{
    name: '   Repaired   ',
    color: 'not-a-colour',
    include: ' api.example.com \n\n other.example \n',
    resourceTypes: ['xmlhttprequest', 'nonsense'],
    activeTabOnly: 'yes',
    headers: [{ name: 'X-One', value: 7, target: 'sideways', operation: 'destroy' }],
  }]));
  const [profile] = result.profiles;
  assert.equal(profile.name, 'Repaired');
  assert.equal(profile.color, PROFILE_COLORS[0]);
  assert.deepEqual(profile.include, ['api.example.com', 'other.example']);
  assert.deepEqual(profile.resourceTypes, ['xmlhttprequest']);
  assert.equal(profile.activeTabOnly, false);
  assert.equal(profile.headers[0].value, '7');
  assert.equal(profile.headers[0].target, 'request');
  assert.equal(profile.headers[0].operation, 'set');
});

test('parseImport reads settings from the envelope and ignores a broken one', () => {
  const payload = exportPayload(sampleState(), { includeSettings: true, now: NOW_UTC });
  payload.settings = { theme: 'dark', logLimit: 5, showBadge: false, nonsense: 1 };
  const result = parseImport(JSON.stringify(payload));
  assert.equal(result.settings.theme, 'dark');
  assert.equal(result.settings.logLimit, 10, 'a too-small limit is clamped by the model');
  assert.equal(result.settings.showBadge, false);
  assert.equal('nonsense' in result.settings, false);

  payload.settings = 'nope';
  assert.equal(parseImport(JSON.stringify(payload)).settings, null);
});

test('parseImport caps a file that holds more profiles than we allow', () => {
  const many = [];
  for (let i = 0; i < MAX_PROFILES + 3; i += 1) {
    many.push({ name: `Profile ${i}`, headers: [{ name: 'X-N', value: String(i) }] });
  }
  const result = parseImport(JSON.stringify(many));
  assert.equal(result.profiles.length, MAX_PROFILES);
  assert.ok(mentions(result.warnings, `kept the first ${MAX_PROFILES}`));
});

test('parseImport reads a realistic ModHeader export', () => {
  const result = parseImport(JSON.stringify(modHeaderExport()));
  assert.equal(result.source, 'modheader');
  assert.equal(result.settings, null);
  assert.deepEqual(result.profiles.map((p) => p.name), [
    'Development API', 'Legacy staging', 'Cookies only',
  ]);
});

test('ModHeader request headers come before response headers', () => {
  const [profile] = parseImport(JSON.stringify(modHeaderExport())).profiles;
  assert.deepEqual(profile.headers.map((h) => [h.name, h.target, h.operation, h.enabled]), [
    ['Authorization', 'request', 'set', true],
    ['X-Debug', 'request', 'set', false],
    ['X-Empty', 'request', 'set', true],
    ['Access-Control-Allow-Origin', 'response', 'set', true],
  ]);
  assert.equal(profile.headers[0].comment, 'local only');
  assert.equal(profile.headers[2].value, '', 'a name with no value stays a set');
});

test('ModHeader urlFilters become slash-wrapped regexes, imported verbatim', () => {
  // ModHeader hands its urlRegex to declarativeNetRequest as a regexFilter,
  // which searches anywhere in the URL. Anchoring it on the way in would stop a
  // filter people really write from matching anything at all.
  const [profile] = parseImport(JSON.stringify(modHeaderExport())).profiles;
  assert.deepEqual(profile.include, ['/https:\\/\\/api\\.example\\.com\\/.*/']);
  assert.deepEqual(profile.exclude, ['/https:\\/\\/api\\.example\\.com\\/health/']);
  const [source] = profile.include;
  assert.ok(new RegExp(source.slice(1, -1)).test('https://api.example.com/v1/users'));
});

test('a ModHeader filter that omits the scheme still matches a real URL', () => {
  // The regression this guards: anchoring turned every such filter into one that
  // matches nothing, because a URL begins with its scheme.
  const result = parseImport(JSON.stringify([{
    title: 'Dev',
    headers: [{ enabled: true, name: 'X-A', value: '1' }],
    urlFilters: [{ enabled: true, urlRegex: 'localhost:3000/.*' }],
  }]));
  const [pattern] = result.profiles[0].include;
  assert.equal(pattern, '/localhost:3000\\/.*/');
  assert.ok(new RegExp(pattern.slice(1, -1)).test('http://localhost:3000/api'));
});

test('ModHeader resourceFilters become resource types', () => {
  const [profile] = parseImport(JSON.stringify(modHeaderExport())).profiles;
  assert.deepEqual(profile.resourceTypes, ['xmlhttprequest', 'main_frame']);
});

test('the older ModHeader filters array maps every filter type', () => {
  const profile = parseImport(JSON.stringify(modHeaderExport())).profiles[1];
  assert.deepEqual(profile.include, ['/^https:\\/\\/staging\\.example\\.com\\//']);
  assert.deepEqual(profile.exclude, ['/https:\\/\\/staging\\.example\\.com\\/static\\/.*/']);
  assert.deepEqual(profile.resourceTypes, ['script', 'stylesheet']);
});

test('an anchor the author wrote is preserved exactly once', () => {
  const profile = parseImport(JSON.stringify(modHeaderExport())).profiles[1];
  assert.ok(profile.include[0].startsWith('/^https'));
  assert.equal(profile.include[0].includes('^^'), false);
});

test('a ModHeader alternation is imported as written, branches intact', () => {
  const result = parseImport(JSON.stringify([{
    title: 'Either',
    headers: [{ enabled: true, name: 'X-A', value: '1' }],
    respHeaders: [],
    urlFilters: [
      { enabled: true, urlRegex: 'https://a\\.test/.*|https://b\\.test/.*' },
      { enabled: true, urlRegex: '^https://c\\.test/|https://d\\.test/' },
    ],
  }]));
  const [first, second] = result.profiles[0].include;
  assert.equal(first, '/https:\\/\\/a\\.test\\/.*|https:\\/\\/b\\.test\\/.*/');
  assert.equal(second, '/^https:\\/\\/c\\.test\\/|https:\\/\\/d\\.test\\//');

  // Both branches match, exactly as they did in ModHeader.
  const re = new RegExp(first.slice(1, -1));
  assert.equal(re.test('https://a.test/x'), true);
  assert.equal(re.test('https://b.test/x'), true);
});

test('a pipe inside a character class is not treated as an alternation', () => {
  const result = parseImport(JSON.stringify([{
    title: 'Class',
    headers: [{ enabled: true, name: 'X-A', value: '1' }],
    respHeaders: [],
    urlFilters: [{ enabled: true, urlRegex: 'https://a\\.test/[a|b]/.*' }],
  }]));
  assert.equal(result.profiles[0].include[0], '/https:\\/\\/a\\.test\\/[a|b]\\/.*/');
});

test('disabled ModHeader filters are dropped', () => {
  const [first, second] = parseImport(JSON.stringify(modHeaderExport())).profiles;
  assert.equal(first.include.some((p) => p.includes('disabled')), false);
  assert.equal(second.include.some((p) => p.includes('off.example')), false);
});

test('ModHeader appendMode comma turns every header into an append', () => {
  const profile = parseImport(JSON.stringify(modHeaderExport())).profiles[1];
  assert.deepEqual(profile.headers.map((h) => h.operation), ['append']);
  assert.equal(profile.headers[0].name, 'X-Forwarded-For');
});

test('appendMode true also appends, and a falsy appendMode sets', () => {
  const append = parseImport(JSON.stringify([{
    title: 'Append', appendMode: true, headers: [{ enabled: true, name: 'X-A', value: '1' }], respHeaders: [],
  }])).profiles[0];
  assert.equal(append.headers[0].operation, 'append');

  const set = parseImport(JSON.stringify([{
    title: 'Set', appendMode: '', headers: [{ enabled: true, name: 'X-A', value: '1' }], respHeaders: [],
  }])).profiles[0];
  assert.equal(set.headers[0].operation, 'set');
});

test('a header with a null name is skipped with a warning, not a throw', () => {
  const result = parseImport(JSON.stringify(modHeaderExport()));
  const profile = result.profiles[1];
  assert.deepEqual(profile.headers.map((h) => h.name), ['X-Forwarded-For']);
  assert.ok(mentions(result.warnings, 'no name'));
  assert.ok(mentions(result.warnings, 'Legacy staging'));
});

test('an unnamed header row is dropped quietly', () => {
  const result = parseImport(JSON.stringify([{
    name: 'Drafting',
    headers: [{ enabled: true, name: '', value: '' }, { enabled: true, name: 'X-Real', value: '1' }],
  }]));
  assert.deepEqual(result.profiles[0].headers.map((h) => h.name), ['X-Real']);
  assert.deepEqual(result.warnings, []);
});

test('a header entry that is not an object is skipped with a warning', () => {
  const result = parseImport(JSON.stringify([{
    name: 'Odd', headers: ['X-Nope', { name: 'X-Real', value: '1' }],
  }]));
  assert.deepEqual(result.profiles[0].headers.map((h) => h.name), ['X-Real']);
  assert.ok(mentions(result.warnings, 'not a header'));
});

test('ModHeader tab and tab group filters are dropped with a warning', () => {
  const result = parseImport(JSON.stringify(modHeaderExport()));
  const dropped = result.warnings.filter((w) => w.includes('tab filters'));
  assert.equal(dropped.length, 2, 'one for the newer arrays, one for the older filters entry');
  assert.ok(mentions(result.warnings, 'Development API'));
  assert.ok(mentions(result.warnings, 'active tab'));
});

test('ModHeader cookie changes are dropped with a warning', () => {
  const result = parseImport(JSON.stringify(modHeaderExport()));
  assert.ok(mentions(result.warnings, 'cookie changes'));
  assert.ok(mentions(result.warnings, 'Cookies only'));
});

test('a ModHeader profile with only a shortTitle is named after it', () => {
  const profile = parseImport(JSON.stringify(modHeaderExport())).profiles[2];
  assert.equal(profile.name, 'Cookies only');
  assert.deepEqual(profile.headers.map((h) => h.name), ['X-Only-Short']);
});

test('the older ModHeader urlPattern maps onto our glob syntax', () => {
  const profile = parseImport(JSON.stringify(modHeaderExport())).profiles[2];
  assert.deepEqual(profile.include, ['https://*.short.example/*']);
});

test('a nameless ModHeader profile still imports under a readable name', () => {
  const result = parseImport(JSON.stringify([{
    headers: [{ enabled: true, name: 'X-A', value: '1' }], respHeaders: [],
  }]));
  assert.equal(result.source, 'modheader');
  assert.equal(result.profiles[0].name, 'Imported profile');
});

test('a single ModHeader profile object is recognised', () => {
  const result = parseImport(JSON.stringify(modHeaderExport()[0]));
  assert.equal(result.source, 'modheader');
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].name, 'Development API');
});

test('duplicate ModHeader filters collapse to one pattern', () => {
  const result = parseImport(JSON.stringify([{
    title: 'Dupes',
    headers: [{ enabled: true, name: 'X-A', value: '1' }],
    respHeaders: [],
    urlFilters: [
      { enabled: true, urlRegex: 'https://a\\.test/.*' },
      { enabled: true, urlRegex: 'https://a\\.test/.*' },
    ],
    resourceFilters: [
      { enabled: true, resourceType: ['script'] },
      { enabled: true, resourceType: ['script', 'image'] },
    ],
  }]));
  assert.equal(result.profiles[0].include.length, 1);
  assert.deepEqual(result.profiles[0].resourceTypes, ['script', 'image']);
});

test('every imported ModHeader profile is a valid profile', () => {
  for (const profile of parseImport(JSON.stringify(modHeaderExport())).profiles) {
    assert.deepEqual(profile, createProfile(profile));
  }
});

test('repeated warnings are reported once', () => {
  const result = parseImport(JSON.stringify([{
    name: 'Many bad rows',
    headers: [
      { enabled: true, name: null, value: '1' },
      { enabled: true, name: null, value: '2' },
      { enabled: true, name: null, value: '3' },
      { enabled: true, name: 'X-Real', value: 'ok' },
    ],
  }]));
  assert.deepEqual(result.profiles[0].headers.map((h) => h.name), ['X-Real']);
  assert.equal(result.warnings.length, 1);
  assert.ok(mentions(result.warnings, 'no name'));
});

test('a ModHeader urlRegex that cannot compile is kept and reported, never discarded', () => {
  const result = parseImport(JSON.stringify([{
    title: 'T',
    headers: [{ name: 'X-A', value: '1' }],
    filters: [{ type: 'urls', urlRegex: 'example.com/(v1' }],
  }]));
  // Kept on purpose. An include list with nothing in it means every URL, so
  // discarding the only filter the file carried would widen this profile rather
  // than narrow it.
  assert.deepEqual(result.profiles[0].include, ['/example.com\\/(v1/']);
  const warning = result.warnings.find((w) => w.includes('URL filter'));
  assert.ok(warning, result.warnings.join(' | '));
  assert.ok(warning.includes('"T"'), warning);
  assert.ok(/regular expression/.test(warning), warning);
  assert.ok(/every URL/.test(warning), warning);
});

test('an unusable ModHeader exclude is kept and reported too', () => {
  const result = parseImport(JSON.stringify([{
    title: 'Excluding',
    headers: [{ name: 'X-A', value: '1' }],
    excludeUrlFilters: [{ urlRegex: 'a(b' }, { urlRegex: 'ok\\.example/' }],
  }]));
  // An exclude nobody can run stops the whole profile in both engines, which is
  // the point: the alternative is sending headers to the host it named.
  assert.deepEqual(result.profiles[0].exclude, ['/a(b/', '/ok\\.example\\//']);
  assert.ok(mentions(result.warnings, '"Excluding"'));
});

test('an include Nod Header cannot use never leaves the profile matching every URL', () => {
  // The case this guards: a shared ModHeader profile scoped to one internal host,
  // carrying an Authorization header, whose URL filter this extension refuses.
  // Dropping the filter used to turn it into a profile that sent that credential
  // to every site the browser visited, with a urlFilter of "*" to match.
  const result = parseImport(JSON.stringify([{
    title: 'Staging',
    headers: [{ name: 'Authorization', value: 'Bearer secret' }],
    filters: [{ type: 'urls', urlRegex: 'staging\\.internal/(v1|v2)+/' }],
  }]));
  const profile = result.profiles[0];
  assert.notDeepEqual(profile.include, []);
  for (const url of ['https://staging.internal/v1/', 'https://example.com/', 'https://evil.tld/']) {
    assert.equal(urlMatchesFilters(url, profile.include, profile.exclude), false, url);
  }
  // And the rule compiler emits nothing rather than a rule for every URL.
  const state = createState({ profiles: [profile], activeProfileId: profile.id });
  assert.deepEqual(buildRules(state).dynamic, []);
});

test('a filter carrying both a pattern and a regex keeps the narrower regex', () => {
  const result = parseImport(JSON.stringify([{
    title: 'Both',
    headers: [{ name: 'X-A', value: '1' }],
    filters: [{
      type: 'urls',
      urlPattern: 'https://*.example.com/*',
      urlRegex: 'https://api\\.example\\.com/v1/.*',
    }],
  }]));
  assert.deepEqual(result.profiles[0].include, ['/https:\\/\\/api\\.example\\.com\\/v1\\/.*/']);
  assert.ok(mentions(result.warnings, 'both a pattern and a regular expression'));
  assert.ok(mentions(result.warnings, '"Both"'));
});

test('a filter with both fields falls back to the pattern when the regex is unusable', () => {
  const result = parseImport(JSON.stringify([{
    title: 'Fallback',
    headers: [{ name: 'X-A', value: '1' }],
    filters: [{ type: 'urls', urlPattern: 'https://*.example.com/*', urlRegex: '(' }],
  }]));
  assert.deepEqual(result.profiles[0].include, ['https://*.example.com/*']);
  assert.ok(mentions(result.warnings, 'URL filter'));
});

test('an imported profile with too many headers reports the count it dropped', () => {
  const headers = [];
  for (let i = 0; i < MAX_HEADERS_PER_PROFILE + 4; i += 1) {
    headers.push({ name: `X-N-${i}`, value: String(i) });
  }
  const result = parseImport(JSON.stringify([{ name: 'Crowded', headers }]));
  assert.equal(result.profiles[0].headers.length, MAX_HEADERS_PER_PROFILE);
  assert.ok(mentions(result.warnings, 'Dropped 4 headers'));
  assert.ok(mentions(result.warnings, '"Crowded"'));

  const modheader = parseImport(JSON.stringify([{ title: 'Crowded MH', headers }]));
  assert.ok(mentions(modheader.warnings, 'Dropped 4 headers'));
  assert.ok(mentions(modheader.warnings, '"Crowded MH"'));
});

test('appendMode alone marks a ModHeader profile, so an append stays an append', () => {
  const result = parseImport(JSON.stringify([{
    appendMode: 'comma',
    headers: [{ name: 'X-A', value: '1' }],
  }]));
  assert.equal(result.source, 'modheader');
  assert.equal(result.profiles[0].headers[0].operation, 'append');
});

test('cookie, set-cookie and tab lists alone mark a ModHeader profile', () => {
  for (const key of ['cookieHeaders', 'setCookieHeaders', 'tabFilters', 'tabGroupFilters']) {
    const result = parseImport(JSON.stringify([{
      headers: [{ name: 'X-A', value: '1' }],
      [key]: [{ enabled: true, name: 'session', value: 'abc' }],
    }]));
    assert.equal(result.source, 'modheader', key);
  }
});

test('only a field this extension writes claims the nod-header format', () => {
  const own = parseImport(JSON.stringify([{
    name: 'Ours', headers: [{ name: 'X-A', value: '1', operation: 'remove' }],
  }]));
  assert.equal(own.source, EXPORT_FORMAT);

  const flagged = parseImport(JSON.stringify([{ name: 'Ours', activeTabOnly: true, headers: [] }]));
  assert.equal(flagged.source, EXPORT_FORMAT);

  // A bare name and a header name could have come from anywhere, so claiming a
  // format would be a guess. The profiles are still read.
  const plain = parseImport(JSON.stringify([{ name: 'Plain', headers: [{ name: 'X-A', value: '1' }] }]));
  assert.equal(plain.source, 'unknown');
  assert.deepEqual(plain.profiles.map((p) => p.name), ['Plain']);
  assert.deepEqual(plain.warnings, []);
});

test('the missing-format warning names the shape that was actually read', () => {
  const modheader = parseImport(JSON.stringify({
    profiles: [{ title: 'MH', headers: [{ name: 'X-A', value: '1' }] }],
  }));
  assert.equal(modheader.source, 'modheader');
  assert.ok(mentions(modheader.warnings, 'no format field'));
  assert.ok(mentions(modheader.warnings, 'a ModHeader export'));

  const plain = parseImport(JSON.stringify({
    profiles: [{ name: 'Plain', headers: [{ name: 'X-A', value: '1' }] }],
  }));
  assert.ok(mentions(plain.warnings, 'a plain list of profiles'));

  const own = parseImport(JSON.stringify({
    profiles: [{ name: 'Ours', activeTabOnly: false, headers: [] }],
  }));
  assert.ok(mentions(own.warnings, 'one of its own exports'));
});

test('suggestFilename names a single-profile export after the profile', () => {
  const name = suggestFilename(sampleState(), { profileIds: ['p-dev'], now: NOW_LOCAL });
  assert.equal(name, 'nod-header-development-api-2026-07-29.json');
});

test('suggestFilename drops the profile name from a full export', () => {
  assert.equal(suggestFilename(sampleState(), { now: NOW_LOCAL }), 'nod-header-2026-07-29.json');
  assert.equal(
    suggestFilename(sampleState(), { profileIds: ['p-dev', 'p-prod'], now: NOW_LOCAL }),
    'nod-header-2026-07-29.json',
  );
});

test('suggestFilename produces a filesystem-safe slug', () => {
  const state = createState({
    profiles: [createProfile({ id: 'p1', name: '  Staging / QA: "v2" *fast*  ' })],
  });
  const name = suggestFilename(state, { profileIds: ['p1'], now: NOW_LOCAL });
  assert.equal(name, 'nod-header-staging-qa-v2-fast-2026-07-29.json');
  assert.match(name, /^[a-z0-9.-]+$/);
});

test('suggestFilename falls back when a name has no usable characters', () => {
  const state = createState({ profiles: [createProfile({ id: 'p1', name: '???' })] });
  assert.equal(
    suggestFilename(state, { profileIds: ['p1'], now: NOW_LOCAL }),
    'nod-header-2026-07-29.json',
  );
});

test('suggestFilename pads single digit months and days', () => {
  assert.equal(
    suggestFilename(sampleState(), { now: new Date(2027, 0, 5, 12, 0, 0) }),
    'nod-header-2027-01-05.json',
  );
});

test('suggestFilename ignores an unusable now', () => {
  const today = suggestFilename(sampleState(), { now: 'not a date' });
  assert.match(today, /^nod-header-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(today, suggestFilename(sampleState(), {}));
});

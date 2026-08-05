/**
 * Export and import. Pure functions with no browser APIs, so the options page
 * and `node --test` exercise exactly the same code.
 */
import { EXPORT_FORMAT, EXPORT_VERSION, MAX_PROFILES, MAX_HEADERS_PER_PROFILE } from './constants.js';
import { createProfile, createSettings } from './model.js';
import { patternError } from './matcher.js';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v) => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

const quote = (label) => `"${label}"`;

/** A bad or missing timestamp still has to produce a filename, so fall back to now. */
function toDate(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** Local calendar day, so the filename matches the date the user sees. */
function dateStamp(now) {
  const date = toDate(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A non-empty profileIds list narrows the export; anything else takes every profile. */
function selectProfiles(state, options) {
  const all = Array.isArray(state?.profiles) ? state.profiles : [];
  const ids = Array.isArray(options.profileIds) ? options.profileIds.filter(Boolean) : [];
  if (!ids.length) return all;
  return all.filter((p) => ids.includes(p.id));
}

/**
 * Ids stay out of the file. They are local storage keys, so shipping them would
 * let an imported profile collide with one the recipient already has.
 */
function exportProfile(profile) {
  return {
    name: profile.name,
    color: profile.color,
    headers: (Array.isArray(profile.headers) ? profile.headers : []).map((h) => ({
      enabled: h.enabled,
      name: h.name,
      value: h.value,
      target: h.target,
      operation: h.operation,
      comment: h.comment,
      include: [...(h.include ?? [])],
      resourceTypes: [...(h.resourceTypes ?? [])],
    })),
    include: [...(profile.include ?? [])],
    exclude: [...(profile.exclude ?? [])],
    resourceTypes: [...(profile.resourceTypes ?? [])],
    activeTabOnly: profile.activeTabOnly === true,
  };
}

export function exportPayload(state, options = {}) {
  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: toDate(options.now).toISOString(),
    profiles: selectProfiles(state, options).map(exportProfile),
  };
  if (options.includeSettings) payload.settings = createSettings(state?.settings);
  return payload;
}

export function serialize(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Lowercase, hyphenated, ASCII only — safe on every filesystem we ship to. */
function slugify(value) {
  const dashed = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  // Walking the ends rather than `/^-+|-+$/g`: the trailing `-+$` backtracks
  // quadratically, and the slice above is the only thing keeping that cheap.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === '-') start += 1;
  while (end > start && dashed[end - 1] === '-') end -= 1;
  return dashed.slice(start, end);
}

export function suggestFilename(state, options = {}) {
  const profiles = selectProfiles(state, options);
  const slug = profiles.length === 1 ? slugify(profiles[0].name) : '';
  const stamp = dateStamp(options.now);
  return slug ? `nod-header-${slug}-${stamp}.json` : `nod-header-${stamp}.json`;
}

const NOT_JSON = 'That file is not valid JSON. Check that the download finished, then export it again.';
const UNRECOGNISED = 'That file holds no profiles. Nod Header reads its own export files, '
  + 'a list of profiles, and ModHeader exports.';

/**
 * ModHeader fields this mapping accounts for, taken from a real v2 export and
 * from the ModHeader popup source:
 *   title, shortTitle                     -> name
 *   headers[]                             -> target request
 *   respHeaders[]                         -> target response
 *   header { enabled, name, value, comment }
 *   appendMode true | 'comma' | 'append'  -> operation append
 *   filters[] { enabled, type, urlRegex, urlPattern, resourceType }
 *     type 'urls' -> include, 'excludeUrls' -> exclude,
 *     'types' / 'resourceTypes' -> resourceTypes, tab types -> dropped
 *   urlFilters[], excludeUrlFilters[], resourceFilters[]  (newer exports)
 *   tabFilters[], tabGroupFilters[]       -> dropped with a warning
 *   cookieHeaders[], setCookieHeaders[]   -> dropped with a warning
 * Ignored on purpose: version, alwaysOn, hideComment, textColor, csvHeaders,
 * urlReplacements, and anything else we do not recognise.
 */
const MODHEADER_TITLES = ['title', 'shortTitle'];

const MODHEADER_LISTS = ['respHeaders', 'filters', 'urlFilters', 'excludeUrlFilters',
  'resourceFilters', 'tabFilters', 'tabGroupFilters', 'cookieHeaders', 'setCookieHeaders'];

/** Fields only ModHeader writes. `appendMode` decides whether a header appends. */
function isModHeaderShape(entry) {
  if (MODHEADER_TITLES.some((key) => typeof entry[key] === 'string')) return true;
  if (MODHEADER_LISTS.some((key) => Array.isArray(entry[key]))) return true;
  return entry.appendMode !== undefined;
}

/** Fields only this extension writes. A ModHeader header carries none of them. */
function isOwnShape(entry) {
  if (entry.activeTabOnly !== undefined) return true;
  const headers = Array.isArray(entry.headers) ? entry.headers : [];
  return headers.some((h) => isPlainObject(h) && (h.target !== undefined || h.operation !== undefined));
}

/**
 * `modheader` and `own` are claims about the source; `profile` is a shape we can
 * read either way, such as a hand-written list of names and headers. Every
 * ModHeader signal is checked before any of ours, because a ModHeader profile
 * also carries `name`-like and `headers` fields.
 */
function profileKind(entry) {
  if (!isPlainObject(entry)) return null;
  if (isModHeaderShape(entry)) return 'modheader';
  if (isOwnShape(entry)) return 'own';
  if (typeof entry.name === 'string' || Array.isArray(entry.headers)) return 'profile';
  if (Array.isArray(entry.include) || Array.isArray(entry.exclude)) return 'profile';
  return null;
}

/**
 * createProfile keeps the first MAX_HEADERS_PER_PROFILE headers and says nothing,
 * so the count has to be compared here or the rest go missing in silence.
 */
function buildProfile(patch, wanted, label, warnings) {
  const profile = createProfile(patch);
  const dropped = wanted - profile.headers.length;
  if (dropped > 0) {
    warnings.push(`Dropped ${dropped} headers from ${quote(label)}. A profile holds at most `
      + `${MAX_HEADERS_PER_PROFILE} headers.`);
  }
  return profile;
}

/** Only an explicit `enabled: false` drops a filter, so hand-written files still work. */
function enabledEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => isPlainObject(entry) && entry.enabled !== false);
}

/**
 * ModHeader matches its urlRegex unanchored: it hands the expression to
 * declarativeNetRequest as a regexFilter, which searches anywhere in the URL.
 * Anchoring it here would be silently destructive — a filter people really
 * write, such as `localhost:3000/.*` or `example\.com`, would stop matching
 * every URL, because a URL starts with its scheme. So the source is imported
 * verbatim and only the delimiter is escaped.
 */
function wrapRegex(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      out += c + (source[i + 1] ?? '');
      i += 1;
      continue;
    }
    out += c === '/' ? '\\/' : c;
  }
  return `/${out}/`;
}

/**
 * urlPattern is ModHeader's older glob field and maps straight onto our globs.
 * One filter carrying both fields is ambiguous, so the regex wins: it is the
 * narrower of the two, and importing the wider one would change headers on URLs
 * the exported profile left alone. If one of the two cannot be compiled the other
 * is used instead.
 *
 * When neither can be, the unusable one is kept rather than thrown away. This is
 * the direction that fails closed, and it is the opposite of what it looks like:
 * an include list with nothing in it means *every* URL, so discarding the only
 * filter a file carried would take a profile scoped to one internal host and turn
 * it into one that sends its headers — an Authorization value as often as not —
 * to every site the browser visits, with a `urlFilter: "*"` rule to match and
 * nothing anywhere to warn about it. A pattern that cannot be compiled matches
 * nothing in either engine and nothing in the log, and the options page lists it
 * as needing attention, so keeping it costs a profile that does nothing until it
 * is fixed. That is recoverable; a leaked credential is not.
 */
function pushPattern(list, filter, label, warnings) {
  const glob = trimmed(filter.urlPattern);
  const source = trimmed(filter.urlRegex);
  const ordered = [];
  if (source) ordered.push(wrapRegex(source));
  if (glob) ordered.push(glob);
  if (source && glob) {
    warnings.push(`One URL filter on ${quote(label)} carried both a pattern and a regular `
      + 'expression. Nod Header kept the regular expression.');
  }

  let keep = null;
  let reason = '';
  for (const pattern of ordered) {
    const problem = patternError(pattern);
    if (!problem) {
      if (!list.includes(pattern)) list.push(pattern);
      return;
    }
    if (keep === null) {
      keep = pattern;
      reason = problem;
    }
  }
  if (keep === null) return;
  if (!list.includes(keep)) list.push(keep);
  warnings.push(`Nod Header cannot use the URL filter ${keep} on ${quote(label)}. ${reason} It was `
    + 'kept rather than dropped, so that profile sends nothing until you fix it — dropping it '
    + 'would have left the profile sending its headers to every URL.');
}

function pushTypes(list, filter) {
  const value = filter.resourceType ?? filter.resourceTypes;
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    const type = trimmed(item);
    if (type && !list.includes(type)) list.push(type);
  }
}

function readHeaderName(raw, label, warnings) {
  if (!isPlainObject(raw)) {
    warnings.push(`Skipped an entry in ${quote(label)} that is not a header.`);
    return null;
  }
  if (typeof raw.name === 'string') {
    // An empty name is an unfinished row, not a problem worth reporting.
    return raw.name.trim() || null;
  }
  warnings.push(`Skipped a header in ${quote(label)} because it has no name.`);
  return null;
}

/** ModHeader stores appendMode as false, '', true, 'append' or 'comma'. */
function isAppendMode(mode) {
  if (mode === true) return true;
  const value = trimmed(mode);
  return value !== '' && value !== 'false';
}

function modHeaderHeaders(list, target, append, label, warnings) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const name = readHeaderName(raw, label, warnings);
    if (!name) continue;
    out.push({
      enabled: raw.enabled !== false,
      name,
      value: text(raw.value),
      target,
      // A name with no value still means "set it to empty", never "remove it".
      operation: append ? 'append' : 'set',
      comment: text(raw.comment),
    });
  }
  return out;
}

function fromModHeader(raw, warnings) {
  const label = trimmed(raw.title) || trimmed(raw.shortTitle) || 'Imported profile';
  const append = isAppendMode(raw.appendMode);
  const headers = [
    ...modHeaderHeaders(raw.headers, 'request', append, label, warnings),
    ...modHeaderHeaders(raw.respHeaders, 'response', append, label, warnings),
  ];

  const include = [];
  const exclude = [];
  const resourceTypes = [];
  let droppedTabFilter = false;

  for (const filter of enabledEntries(raw.filters)) {
    switch (filter.type) {
      case 'urls':
        pushPattern(include, filter, label, warnings);
        break;
      case 'excludeUrls':
        pushPattern(exclude, filter, label, warnings);
        break;
      case 'types':
      case 'resourceTypes':
        pushTypes(resourceTypes, filter);
        break;
      case 'tabId':
      case 'tabGroupId':
      case 'tabs':
      case 'tabGroups':
        droppedTabFilter = true;
        break;
      default:
        break;
    }
  }
  for (const filter of enabledEntries(raw.urlFilters)) pushPattern(include, filter, label, warnings);
  for (const filter of enabledEntries(raw.excludeUrlFilters)) pushPattern(exclude, filter, label, warnings);
  for (const filter of enabledEntries(raw.resourceFilters)) pushTypes(resourceTypes, filter);
  if (enabledEntries(raw.tabFilters).length || enabledEntries(raw.tabGroupFilters).length) {
    droppedTabFilter = true;
  }

  if (droppedTabFilter) {
    warnings.push(`Dropped the tab filters on ${quote(label)}. Limit the profile to the active tab instead.`);
  }
  if (enabledEntries(raw.cookieHeaders).length || enabledEntries(raw.setCookieHeaders).length) {
    warnings.push(`Dropped the cookie changes on ${quote(label)}. Add a Cookie or Set-Cookie header instead.`);
  }

  return buildProfile(
    { name: label, color: raw.color, headers, include, exclude, resourceTypes },
    headers.length, label, warnings,
  );
}

function fromOwn(raw, warnings) {
  const label = trimmed(raw.name) || 'Imported profile';
  const headers = [];
  for (const entry of Array.isArray(raw.headers) ? raw.headers : []) {
    const name = readHeaderName(entry, label, warnings);
    if (!name) continue;
    headers.push({
      enabled: entry.enabled !== false,
      name,
      value: text(entry.value),
      target: entry.target,
      operation: entry.operation,
      comment: text(entry.comment),
      include: entry.include,
      resourceTypes: entry.resourceTypes,
    });
  }
  return buildProfile({
    name: label,
    color: raw.color,
    headers,
    include: raw.include,
    exclude: raw.exclude,
    resourceTypes: raw.resourceTypes,
    activeTabOnly: raw.activeTabOnly,
  }, headers.length, label, warnings);
}

function inferSource(sawOwn, sawModHeader) {
  if (sawModHeader && !sawOwn) return 'modheader';
  if (sawOwn && !sawModHeader) return EXPORT_FORMAT;
  return 'unknown';
}

function describeShape(source) {
  if (source === 'modheader') return 'a ModHeader export';
  if (source === EXPORT_FORMAT) return 'one of its own exports';
  return 'a plain list of profiles';
}

/** What the file claims to be, and whether it claimed anything at all. */
function readFormat(format, warnings) {
  if (format === EXPORT_FORMAT) return { declared: EXPORT_FORMAT, noFormat: false };
  // Reported once the entries have been read, so the warning can name the shape
  // they turned out to be.
  if (format === undefined || format === null) return { declared: null, noFormat: true };
  const reported = quote(String(format));
  warnings.push(`That file reports the format ${reported}. Nod Header read the profiles anyway.`);
  return { declared: 'unknown', noFormat: false };
}

/**
 * The profiles and the settings out of whichever wrapper the file used: the
 * export envelope, a bare list, or a single profile on its own.
 */
function readEnvelope(data, warnings) {
  if (isPlainObject(data) && Array.isArray(data.profiles)) {
    return {
      entries: data.profiles,
      rawSettings: data.settings,
      ...readFormat(data.format, warnings),
    };
  }
  const bare = { rawSettings: undefined, declared: null, noFormat: false };
  if (Array.isArray(data)) return { entries: data, ...bare };
  if (isPlainObject(data)) return { entries: [data], ...bare };
  throw new Error(UNRECOGNISED);
}

/** One profile per entry, in whichever dialect that entry turns out to be. */
function readProfiles(entries, warnings) {
  const profiles = [];
  let sawOwn = false;
  let sawModHeader = false;
  for (const entry of entries) {
    const kind = profileKind(entry);
    if (kind === 'modheader') {
      sawModHeader = true;
      profiles.push(fromModHeader(entry, warnings));
    } else if (kind) {
      if (kind === 'own') sawOwn = true;
      profiles.push(fromOwn(entry, warnings));
    } else {
      warnings.push('Skipped an entry that does not look like a profile.');
    }
  }
  return { profiles, sawOwn, sawModHeader };
}

export function parseImport(input) {
  let data;
  try {
    data = JSON.parse(typeof input === 'string' ? input : String(input));
  } catch {
    throw new Error(NOT_JSON);
  }

  const warnings = [];
  const { entries, rawSettings, declared, noFormat } = readEnvelope(data, warnings);
  const { profiles, sawOwn, sawModHeader } = readProfiles(entries, warnings);

  if (!profiles.length) throw new Error(UNRECOGNISED);
  if (profiles.length > MAX_PROFILES) {
    warnings.push(`That file holds ${profiles.length} profiles. Nod Header kept the first ${MAX_PROFILES}.`);
    profiles.length = MAX_PROFILES;
  }

  const source = declared ?? inferSource(sawOwn, sawModHeader);
  if (noFormat) {
    warnings.push(`That file has no format field. Nod Header read it as ${describeShape(source)}.`);
  }

  return {
    profiles,
    settings: isPlainObject(rawSettings) ? createSettings(rawSettings) : null,
    source,
    // Identical warnings carry no extra information, and a list of twenty copies
    // of one line is worse than one line.
    warnings: [...new Set(warnings)],
  };
}

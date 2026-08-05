/**
 * The stored shape, and the pure functions that build and repair it.
 * Nothing here touches a browser API, so it runs under `node --test` as-is.
 */
import {
  SCHEMA_VERSION,
  HEADER_TARGETS,
  HEADER_OPERATIONS,
  RESOURCE_TYPES,
  PROFILE_COLORS,
  UNMODIFIABLE_HEADERS,
  APPENDABLE_REQUEST_HEADERS,
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  MAX_HEADERS_PER_PROFILE,
  MAX_PROFILES,
} from './constants.js';

let idCounter = 0;

export function newId() {
  const rand = globalThis.crypto?.randomUUID?.();
  if (rand) return rand.slice(0, 8) + rand.slice(9, 13);
  idCounter += 1;
  return `id${idCounter.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** RFC 7230 field-name token. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && TOKEN.test(name);
}

/** Header values may not carry control characters or line breaks. */
export function isValidHeaderValue(value) {
  return typeof value === 'string' && value.length <= 8192 && !/[\r\n\0]/.test(value);
}

export function isUnmodifiableHeader(name) {
  return UNMODIFIABLE_HEADERS.includes(String(name || '').toLowerCase());
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/**
 * One pattern per line, whether it arrives as a textarea's value or as a list.
 * An imported list may still hold a pasted multi-line string, and a pattern
 * with a newline in it can never match a URL.
 */
const lines = (v) => str(v).split('\n').map((s) => s.trim()).filter(Boolean);

const strList = (v) => {
  if (Array.isArray(v)) return v.flatMap(lines);
  if (typeof v === 'string') return lines(v);
  return [];
};

const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

const typeList = (v) => strList(v).filter((t) => RESOURCE_TYPES.includes(t));

export function createHeader(patch = {}) {
  return {
    id: str(patch.id) || newId(),
    enabled: bool(patch.enabled, true),
    name: str(patch.name),
    value: str(patch.value),
    target: oneOf(patch.target, HEADER_TARGETS, 'request'),
    operation: oneOf(patch.operation, HEADER_OPERATIONS, 'set'),
    comment: str(patch.comment),
    include: strList(patch.include),
    resourceTypes: typeList(patch.resourceTypes),
  };
}

export function createProfile(patch = {}) {
  const headers = Array.isArray(patch.headers) ? patch.headers.map(createHeader) : [createHeader()];
  return {
    id: str(patch.id) || newId(),
    name: str(patch.name, 'Default').slice(0, 60) || 'Default',
    color: PROFILE_COLORS.includes(patch.color) ? patch.color : PROFILE_COLORS[0],
    headers: headers.slice(0, MAX_HEADERS_PER_PROFILE),
    include: strList(patch.include),
    exclude: strList(patch.exclude),
    resourceTypes: typeList(patch.resourceTypes),
    activeTabOnly: bool(patch.activeTabOnly, false),
  };
}

export function createSettings(patch = {}) {
  const limit = Number(patch.logLimit);
  return {
    // Off by default: logging observes every request in every tab, which is a
    // cost the user has to opt into rather than discover.
    logMatches: bool(patch.logMatches, false),
    logLimit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 10), MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT,
    theme: oneOf(patch.theme, ['light', 'dark', 'system'], 'light'),
    showBadge: bool(patch.showBadge, true),
    confirmDestructive: bool(patch.confirmDestructive, true),
    showTargetTag: bool(patch.showTargetTag, true),
  };
}

export function createState(patch = {}) {
  const profiles = Array.isArray(patch.profiles) && patch.profiles.length
    ? patch.profiles.slice(0, MAX_PROFILES).map(createProfile)
    : [createProfile({ name: 'Default' })];
  const activeProfileId = profiles.some((p) => p.id === patch.activeProfileId)
    ? patch.activeProfileId
    : profiles[0].id;
  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: bool(patch.enabled, true),
    activeProfileId,
    profiles,
    settings: createSettings(patch.settings),
  };
}

/**
 * Repair anything read back from storage: an older schema, a hand-edited
 * import, or a partial write. Always returns a complete, valid state.
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return createState();
  return createState(raw);
}

export function getActiveProfile(state) {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0];
}

/** A header only produces a rule when it is switched on and usable. */
export function isHeaderApplicable(header) {
  if (!header.enabled) return false;
  if (!isValidHeaderName(header.name)) return false;
  // Both engines refuse these, so counting one would report a header that is
  // never sent.
  if (isUnmodifiableHeader(header.name)) return false;
  if (header.operation === 'remove') return true;
  return isValidHeaderValue(header.value) && header.value.length > 0;
}

export function countApplicableHeaders(state) {
  if (!state.enabled) return 0;
  const profile = getActiveProfile(state);
  if (!profile) return 0;
  return profile.headers.filter(isHeaderApplicable).length;
}

/** Human-readable reason a header is inert, or null when it is fine. */
export function headerProblem(header) {
  if (!header.name) return null;
  if (!isValidHeaderName(header.name)) {
    return 'Header names may only contain letters, digits and ! # $ % & \' * + - . ^ _ ` | ~';
  }
  if (!isValidHeaderValue(header.value)) {
    return 'Header values cannot contain line breaks.';
  }
  if (isUnmodifiableHeader(header.name)) {
    return `The browser controls ${header.name} — extensions cannot change it.`;
  }
  if (header.operation !== 'remove' && header.value === '') {
    return 'Add a value, or switch the operation to Remove.';
  }
  if (header.target === 'request' && header.operation === 'append' &&
    !APPENDABLE_REQUEST_HEADERS.includes(header.name.toLowerCase())) {
    return `The browser only allows Append on a fixed list of request headers, and ${header.name} is not one of them. Use Set instead.`;
  }
  return null;
}

export function cloneProfile(profile, name) {
  return createProfile({
    ...profile,
    id: newId(),
    name: name ?? `${profile.name} copy`,
    headers: profile.headers.map((h) => ({ ...h, id: newId() })),
  });
}

export function nextProfileColor(profiles) {
  const used = new Set(profiles.map((p) => p.color));
  return PROFILE_COLORS.find((c) => !used.has(c)) ?? PROFILE_COLORS[profiles.length % PROFILE_COLORS.length];
}

/** Unique profile name, so the dropdown never shows two identical entries. */
export function uniqueProfileName(profiles, wanted, ignoreId = null) {
  const base = (wanted || 'Profile').trim().slice(0, 60) || 'Profile';
  const taken = new Set(profiles.filter((p) => p.id !== ignoreId).map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${newId()}`;
}

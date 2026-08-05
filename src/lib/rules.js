/**
 * Compiles the active profile into declarativeNetRequest rules.
 * Pure: nothing here touches a browser API, so `node --test` runs it as-is.
 */
import {
  RULE_ID_BASE,
  ALLOW_RULE_PRIORITY,
  MODIFY_RULE_PRIORITY,
  APPENDABLE_REQUEST_HEADERS,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
} from './constants.js';
import { getActiveProfile, isHeaderApplicable, isUnmodifiableHeader } from './model.js';
import {
  compilePattern,
  effectiveInclude,
  effectiveResourceTypes,
  isRe2Safe,
} from './matcher.js';

/**
 * Every rule here is a modifyHeaders rule, which declarativeNetRequest counts
 * as unsafe, and unsafe dynamic rules have their own smaller ceiling.
 */
export const MAX_UNSAFE_DYNAMIC_RULES = 5000;

/** Chrome compiles at most this many regexFilter rules per ruleset. */
export const MAX_REGEX_RULES = 1000;

/** The one pattern that needs no regex: it matches every URL. */
const EVERY_URL = '*';

const dedupe = (list) => [...new Set(list)];

const sameEntry = (a, b) =>
  a.header === b.header && a.operation === b.operation && a.value === b.value;

/**
 * The vocabulary has to come from the browser: Firefox knows nothing of
 * webtransport or webbundle, and one unknown value rejects the whole rule.
 * An empty array is not a legal resourceTypes value, so it never gets through.
 */
function resourceVocabulary(supplied) {
  const clean = Array.isArray(supplied)
    ? dedupe(supplied.filter((type) => typeof type === 'string' && type))
    : [];
  return clean.length ? clean : RESOURCE_TYPES;
}

/** Headers the browser cannot carry at all, dropped without a word about it. */
function isApplicableHeader(header) {
  return isHeaderApplicable(header) && !isUnmodifiableHeader(header.name);
}

/** The browser only allows append on a fixed list of request headers. */
function isRefusedAppend(header) {
  return header.target === 'request'
    && header.operation === 'append'
    && !APPENDABLE_REQUEST_HEADERS.includes(header.name.toLowerCase());
}

/** The bucket for this condition, created the first time the condition is seen. */
function groupFor(groups, include, resourceTypes) {
  const key = JSON.stringify([[...include].sort(), [...resourceTypes].sort()]);
  let group = groups.get(key);
  if (!group) {
    group = { include, resourceTypes, requestHeaders: [], responseHeaders: [] };
    groups.set(key, group);
  }
  return group;
}

/**
 * One bucket per condition, not per header, so several headers can ride on a
 * single rule and request plus response changes share one rule slot.
 */
function groupHeaders(profile, warnings) {
  const groups = new Map();
  for (const header of profile.headers) {
    if (!isApplicableHeader(header)) continue;
    if (isRefusedAppend(header)) {
      // The removals and additions travel in one atomic call, so a single
      // rejected entry would leave the whole profile unapplied.
      warnings.push(
        `Skipped the append of ${header.name} — the browser only allows append on a fixed list ` +
        'of request headers. Use Set instead.'
      );
      continue;
    }
    const group = groupFor(
      groups,
      dedupe(effectiveInclude(header, profile)),
      dedupe(effectiveResourceTypes(header, profile))
    );
    const entry = { header: header.name.toLowerCase(), operation: header.operation };
    if (header.operation !== 'remove') entry.value = header.value;
    const bucket = header.target === 'response' ? group.responseHeaders : group.requestHeaders;
    if (!bucket.some((e) => sameEntry(e, entry))) bucket.push(entry);
  }
  return [...groups.values()];
}

/**
 * regexFilter for everything real, so the DNR engine, the webRequest fallback
 * and the request log all decide with the same expression. Returns the reason
 * instead of a condition when the pattern cannot be used, so the caller decides
 * whether to skip it or to abandon the whole profile.
 */
function buildCondition(pattern, resourceTypes, allResourceTypes) {
  const condition = {};
  let caseSensitive = false;
  if (pattern === EVERY_URL) {
    condition.urlFilter = EVERY_URL;
  } else {
    const compiled = compilePattern(pattern);
    if (compiled.error) {
      return { condition: null, error: `Skipped ${pattern} — ${compiled.error}` };
    }
    if (!isRe2Safe(compiled.source)) {
      return {
        condition: null,
        error: `Skipped ${pattern} — Chrome matches URLs with RE2, which has no lookahead, ` +
          'lookbehind or backreferences.',
      };
    }
    condition.regexFilter = compiled.source;
    // matcher.js decides the case sensitivity, and the fallback engine and the
    // request log obey it. DNR has to match the same URLs or the log denies a
    // header the browser really sent.
    caseSensitive = !compiled.flags.includes('i');
  }
  condition.isUrlFilterCaseSensitive = caseSensitive;
  // Never omitted: with no resourceTypes and no excludedResourceTypes a rule
  // matches every type except main_frame, so an empty list would silently spare
  // every top-level page load.
  condition.resourceTypes = resourceTypes.length ? [...resourceTypes] : [...allResourceTypes];
  return { condition, error: null };
}

const signature = (rule) => JSON.stringify([rule.action, rule.condition]);

function pushUnique(list, rule, seen) {
  const key = signature(rule);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(rule);
}

function modifyAction(group) {
  const action = { type: 'modifyHeaders' };
  if (group.requestHeaders.length) action.requestHeaders = group.requestHeaders.map((e) => ({ ...e }));
  if (group.responseHeaders.length) action.responseHeaders = group.responseHeaders.map((e) => ({ ...e }));
  return action;
}

/** One modifyHeaders rule per include pattern. A pattern that cannot be used is
 * a warning and a skip: the rest of the profile still applies. */
function buildModifyRules(groups, allResourceTypes, warnings, seen) {
  const modify = [];
  for (const group of groups) {
    const patterns = group.include.length ? group.include : [EVERY_URL];
    for (const pattern of patterns) {
      const built = buildCondition(pattern, group.resourceTypes, allResourceTypes);
      if (!built.condition) {
        warnings.push(built.error);
        continue;
      }
      pushUnique(modify, {
        id: 0,
        priority: MODIFY_RULE_PRIORITY,
        action: modifyAction(group),
        condition: built.condition,
      }, seen);
    }
  }
  return modify;
}

/**
 * An allow rule outranks the modifyHeaders rules, which is how an exclude
 * pattern wins over every include in the profile. It carries the full
 * resource-type list, so it is a superset of every modify rule in the batch.
 *
 * Returns null when a pattern cannot be used, because shipping the includes
 * without this exclude would send the headers to the very host the user ruled
 * out. A profile that does nothing is recoverable, a leaked credential is not.
 */
function buildAllowRules(profile, allResourceTypes, warnings, seen) {
  const allow = [];
  for (const pattern of dedupe(profile.exclude)) {
    const built = buildCondition(pattern, [], allResourceTypes);
    if (!built.condition) {
      warnings.push(built.error);
      warnings.push(
        `The exclude pattern ${pattern} cannot be used, so this profile is not being applied ` +
        'until it is fixed.'
      );
      return null;
    }
    pushUnique(allow, {
      id: 0,
      priority: ALLOW_RULE_PRIORITY,
      action: { type: 'allow' },
      condition: built.condition,
    }, seen);
  }
  return allow;
}

/**
 * Excludes survive the trim: dropping one would start changing headers on a URL
 * the user ruled out, which is worse than losing a modification.
 */
function trimToRuleLimit(modify, allow, warnings) {
  const total = modify.length + allow.length;
  if (total <= MAX_UNSAFE_DYNAMIC_RULES) return { modify, allow };
  const keptAllow = allow.slice(0, MAX_UNSAFE_DYNAMIC_RULES);
  const keptModify = modify.slice(0, MAX_UNSAFE_DYNAMIC_RULES - keptAllow.length);
  const dropped = total - keptModify.length - keptAllow.length;
  warnings.push(
    `Dropped ${dropped} rules — Chrome applies at most ${MAX_UNSAFE_DYNAMIC_RULES} header ` +
    'rules at a time.'
  );
  return { modify: keptModify, allow: keptAllow };
}

/**
 * Chrome rejects the whole batch above the regex ceiling, so trim instead of
 * submitting rules it will refuse. Excludes are filtered first, which is how
 * they claim their slots ahead of the modifications.
 */
function trimToRegexBudget(modify, allow, warnings) {
  let regexBudget = MAX_REGEX_RULES;
  let dropped = 0;
  const withinRegexBudget = (rule) => {
    if (!rule.condition.regexFilter) return true;
    if (regexBudget > 0) {
      regexBudget -= 1;
      return true;
    }
    dropped += 1;
    return false;
  };
  const keptAllow = allow.filter(withinRegexBudget);
  const keptModify = modify.filter(withinRegexBudget);
  if (dropped) {
    warnings.push(
      `Dropped ${dropped} rules — Chrome compiles at most ${MAX_REGEX_RULES} URL patterns ` +
      'at a time.'
    );
  }
  return { modify: keptModify, allow: keptAllow };
}

export function buildRules(state, options = {}) {
  const result = { dynamic: [], session: [], warnings: [], regexRuleIds: [] };
  if (!state || !state.enabled) return result;

  const profile = getActiveProfile(state);
  if (!profile) return result;

  const allResourceTypes = resourceVocabulary(options.allResourceTypes);
  const warnings = [];
  const finish = () => {
    result.warnings = dedupe(warnings);
    return result;
  };

  const groups = groupHeaders(profile, warnings);
  if (!groups.length) return finish();

  // Fail closed: without a tab id the rules would carry no tabIds condition and
  // apply to every tab, carrying whatever this profile sets everywhere.
  if (profile.activeTabOnly === true && !Number.isInteger(options.activeTabId)) {
    warnings.push('No active tab was found, so the active-tab headers are not being sent.');
    return finish();
  }

  const seen = new Set();
  const modify = buildModifyRules(groups, allResourceTypes, warnings, seen);
  const allow = modify.length ? buildAllowRules(profile, allResourceTypes, warnings, seen) : [];
  if (!allow) return finish();

  const limited = trimToRuleLimit(modify, allow, warnings);
  const kept = trimToRegexBudget(limited.modify, limited.allow, warnings);

  const useSession = profile.activeTabOnly === true;
  const bucket = useSession ? result.session : result.dynamic;
  let id = RULE_ID_BASE;
  for (const rule of [...kept.modify, ...kept.allow]) {
    rule.id = id;
    id += 1;
    if (useSession) rule.condition.tabIds = [options.activeTabId];
    if (rule.condition.regexFilter) result.regexRuleIds.push(rule.id);
    bucket.push(rule);
  }

  return finish();
}

function describeMod(mod, target) {
  return `${mod.operation} ${target} ${mod.header}`;
}

function describeCondition(condition) {
  if (condition.regexFilter) return `/${condition.regexFilter}/`;
  if (condition.urlFilter && condition.urlFilter !== EVERY_URL) return condition.urlFilter;
  return 'every URL';
}

/** One line for the options page, describing a rule the way a user reads it. */
export function describeRule(rule) {
  if (!rule || typeof rule !== 'object') return '';
  const action = rule.action || {};
  const condition = rule.condition || {};

  let text;
  if (action.type === 'allow') {
    text = 'leave headers untouched';
  } else {
    const mods = [
      ...(action.requestHeaders || []).map((m) => describeMod(m, 'request')),
      ...(action.responseHeaders || []).map((m) => describeMod(m, 'response')),
    ];
    text = mods.length ? mods.join(', ') : 'change nothing';
  }

  text += ` on ${describeCondition(condition)}`;
  const applied = condition.resourceTypes || [];
  // A rule that names every type says nothing a reader needs, and every
  // condition now names its types explicitly.
  const narrowed = applied.length && !RESOURCE_TYPES.every((t) => applied.includes(t));
  const types = narrowed ? applied.map((t) => RESOURCE_TYPE_LABELS[t] || t) : [];
  if (types.length) text += ` (${types.join(', ')})`;
  if (Array.isArray(condition.tabIds) && condition.tabIds.length) text += ', active tab only';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

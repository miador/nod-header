/**
 * The declarativeNetRequest engine — the real one, used on Chrome, Edge and
 * any Gecko build that supports modifyHeaders.
 *
 * Rules are replaced, never cleared and re-added: the removals and additions
 * travel in one updateDynamicRules call, so there is no moment in which a
 * request could slip through unmodified.
 */
import { api } from '../lib/browser.js';
import { buildRules } from '../lib/rules.js';

const EMPTY_BUILD = { dynamic: [], session: [], warnings: [], regexRuleIds: [] };

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** rules.js may report a plain string or a { pattern, message } pair. */
function warningText(warning) {
  if (typeof warning === 'string') return warning;
  if (warning?.message && warning?.pattern) return `${warning.message} (${warning.pattern})`;
  return warning?.message ?? String(warning);
}

function countRegex(rules) {
  return rules.filter((rule) => !!rule.condition?.regexFilter).length;
}

/**
 * The resource-type vocabulary this browser accepts. Every condition has to
 * name its types, and an unknown name rejects the whole rule, so the list comes
 * from the live enum rather than from a constant we ship.
 */
function resourceTypeVocabulary(dnr) {
  const values = dnr?.ResourceType ? Object.values(dnr.ResourceType) : [];
  return values.filter((value) => typeof value === 'string' && value);
}

/** rules.js falls back to its own list, so an empty one is never passed on. */
function buildOptions(dnr, options) {
  const merged = { ...options };
  const allResourceTypes = resourceTypeVocabulary(dnr);
  if (allResourceTypes.length) merged.allResourceTypes = allResourceTypes;
  return merged;
}

/**
 * declarativeNetRequest matches with RE2, so a source JavaScript accepts can
 * still be refused. Ask the browser about every regex rule before submitting
 * the batch — one rejected rule fails the whole call.
 */
async function keepSupportedRegex(dnr, rules, regexRuleIds, warnings) {
  if (typeof dnr.isRegexSupported !== 'function') return rules;
  const ids = new Set(Array.isArray(regexRuleIds) ? regexRuleIds : []);
  const checks = await Promise.all(rules.map(async (rule) => {
    const regex = rule.condition?.regexFilter;
    if (!regex || !ids.has(rule.id)) return { rule, ok: true };
    try {
      const result = await dnr.isRegexSupported({
        regex,
        isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
        requireCapturing: false,
      });
      return { rule, ok: result?.isSupported !== false, reason: result?.reason ?? '' };
    } catch (err) {
      return { rule, ok: false, reason: messageOf(err) };
    }
  }));

  const kept = [];
  for (const check of checks) {
    if (check.ok) {
      kept.push(check.rule);
      continue;
    }
    const reason = check.reason ? ` The browser said: ${check.reason}.` : '';
    warnings.push(
      `This browser will not match the pattern ${check.rule.condition.regexFilter}, ` +
      `so it was skipped. Simplify it or use a host or glob pattern instead.${reason}`,
    );
  }
  return kept;
}

/** Replace a whole rule set in one call. */
async function replaceRules(read, write, addRules) {
  const existing = await read();
  const removeRuleIds = (Array.isArray(existing) ? existing : []).map((rule) => rule.id);
  if (!removeRuleIds.length && !addRules.length) return;
  await write({ removeRuleIds, addRules });
}

function checkLimits(dnr, dynamic, session, regexCount, warnings) {
  // A header rule is a modifyHeaders rule, which counts against the smaller
  // unsafe quota, not the 30,000 reserved for allow and block rules.
  const maxUnsafe = dnr.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ?? 5000;
  const maxDynamic = dnr.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000;
  const maxSession = dnr.MAX_NUMBER_OF_SESSION_RULES;
  const maxRegex = dnr.MAX_NUMBER_OF_REGEX_RULES;
  const unsafeCount = dynamic.filter((rule) => rule.action?.type === 'modifyHeaders').length;
  const safeCount = dynamic.length - unsafeCount;
  if (typeof maxUnsafe === 'number' && unsafeCount > maxUnsafe) {
    warnings.push(`This browser allows ${maxUnsafe} header rules and the profile needs ${unsafeCount}. Remove some URL patterns.`);
  }
  if (typeof maxDynamic === 'number' && safeCount > maxDynamic) {
    warnings.push(`This browser allows ${maxDynamic} exclude rules and the profile needs ${safeCount}. Remove some exclude patterns.`);
  }
  if (typeof maxSession === 'number' && session.length > maxSession) {
    warnings.push(`This browser allows ${maxSession} active-tab rules and the profile needs ${session.length}. Remove some URL patterns.`);
  }
  if (typeof maxRegex === 'number' && regexCount > maxRegex) {
    warnings.push(`This browser allows ${maxRegex} pattern rules and the profile needs ${regexCount}. Use fewer URL patterns.`);
  }
}

export async function applyDnrRules(state, options) {
  const dnr = api.declarativeNetRequest;
  const warnings = [];
  const errors = [];

  // A master switch that is off means no rules at all, not fewer rules.
  const built = state.enabled ? buildRules(state, buildOptions(dnr, options)) : EMPTY_BUILD;
  for (const warning of built.warnings ?? []) warnings.push(warningText(warning));

  let dynamic = Array.isArray(built.dynamic) ? built.dynamic : [];
  let session = Array.isArray(built.session) ? built.session : [];
  const regexIds = built.regexRuleIds ?? [];

  dynamic = await keepSupportedRegex(dnr, dynamic, regexIds, warnings);
  session = await keepSupportedRegex(dnr, session, regexIds, warnings);

  const hasSessionRules = typeof dnr.updateSessionRules === 'function' &&
    typeof dnr.getSessionRules === 'function';
  if (!hasSessionRules && session.length) {
    // Applying these as ordinary rules would widen them from one tab to every
    // tab, which could send an authorization header somewhere it was never
    // meant to go. Drop them and say so.
    warnings.push('This browser cannot limit rules to the active tab, so those headers were not applied. Turn off "Active tab only" to use them everywhere.');
    session = [];
  }

  const regexCount = countRegex(dynamic) + countRegex(session);
  checkLimits(dnr, dynamic, session, regexCount, warnings);

  try {
    await replaceRules(
      () => dnr.getDynamicRules(),
      (update) => dnr.updateDynamicRules(update),
      dynamic,
    );
  } catch (err) {
    errors.push(`The rules could not be saved: ${messageOf(err)}`);
  }

  if (hasSessionRules) {
    try {
      await replaceRules(
        () => dnr.getSessionRules(),
        (update) => dnr.updateSessionRules(update),
        session,
      );
    } catch (err) {
      errors.push(`The active-tab rules could not be saved: ${messageOf(err)}`);
    }
  }

  return {
    engine: 'declarativeNetRequest',
    ruleCount: dynamic.length + session.length,
    dynamicRuleCount: dynamic.length,
    sessionRuleCount: session.length,
    regexRuleCount: regexCount,
    warnings,
    errors,
  };
}

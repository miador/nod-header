/**
 * URL pattern matching. The rule compiler, the webRequest fallback engine and
 * the request log all go through here, so a pattern means exactly one thing
 * everywhere in the extension.
 *
 * Three kinds of pattern:
 *   /^https:\/\/api\./i     a JavaScript regular expression, slash-wrapped
 *   https://*.example.com/* a glob, an asterisk matches any run of characters
 *   example.com             a bare host with an optional :port, and any subdomain
 *
 * Pure: nothing here touches a browser API, so it runs under `node --test`.
 */

/** Slash-wrapped, with an optional single `i` flag. */
const REGEX_SHAPE = /^\/(.*)\/(i?)$/s;

/**
 * A slash or asterisk means the user wrote a URL shape, not a host. A colon does
 * too, unless it is a bare trailing port: `localhost:3000` is the single most
 * common thing a developer types, and as a glob it could never match a URL.
 */
const GLOB_HINT = /[/*]|:(?!\d+$)/;

/** A glob with no wildcard and no scheme cannot match a URL, whatever we do. */
const GLOB_SHAPE = /\*|:\/\//;

/**
 * A URL long enough to be a payload rather than an address is matched by its
 * prefix. A pattern with several wildcards backtracks, and the URL side is
 * whatever a page asked for, so the work per request has to have a ceiling.
 */
const MAX_MATCH_LENGTH = 2048;

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
/** The same set minus the asterisk, which a glob turns into `.*` instead. */
const GLOB_META = /[.+?^${}()|[\]\\]/g;

/** Hosts must carry at least one letter or digit to be worth compiling. */
const HOST_SHAPE = /[a-z0-9]/i;

const text = (value) => (typeof value === 'string' ? value : '');

export function patternKind(pattern) {
  const raw = text(pattern).trim();
  if (REGEX_SHAPE.test(raw)) return 'regex';
  if (GLOB_HINT.test(raw)) return 'glob';
  return 'host';
}

export function globToRegexSource(pattern) {
  // Adjacent stars match exactly what one star matches, and each extra `.*`
  // hands the matcher another choice per character of the URL.
  const collapsed = text(pattern).trim().replace(/\*{2,}/g, '*');
  const escaped = collapsed.replace(GLOB_META, '\\$&');
  return `^${escaped.replace(/\*/g, '.*')}$`;
}

/**
 * Leading and trailing dots, stripped by walking the two ends. `/\.+$/` reads
 * better and does the same thing, but it backtracks quadratically on a long run
 * of dots — and a host is user input, so this module refuses that everywhere.
 */
function trimDots(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '.') start += 1;
  while (end > start && value[end - 1] === '.') end -= 1;
  return value.slice(start, end);
}

export function hostToRegexSource(host) {
  const raw = trimDots(text(host).trim());
  const withPort = /^(.*):(\d+)$/.exec(raw);
  const name = (withPort ? withPort[1] : raw).toLowerCase().replace(REGEX_META, '\\$&');
  const port = withPort ? `:${withPort[2]}` : '(?::\\d+)?';
  // Userinfo gets its own group so the label run never has to swallow it, and
  // the label run stops at `@` and cannot cross into the path or query. So
  // `example.com` matches user@api.example.com and the root form example.com.
  // but never notexample.com, example.com.evil.tld or example.com@evil.tld.
  return `^[^:/?#]+://(?:[^/?#]*@)?(?:[^/?#@]*\\.)?${name}\\.?${port}(?:[/?#]|$)`;
}

/** `*`, `+`, `?`, `{n}`, `{n,}` or `{n,m}` at `i`, or null for anything else. */
function quantifierAt(source, i) {
  const ch = source[i];
  if (ch === '*' || ch === '+') return { end: i, repeats: true };
  if (ch === '?') return { end: i, repeats: false };
  if (ch !== '{') return null;
  const brace = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i));
  if (!brace) return null;
  const min = Number(brace[1]);
  let max = min;
  if (brace[2] === '') max = Infinity;
  else if (brace[2] !== undefined) max = Number(brace[2]);
  return { end: i + brace[0].length - 1, repeats: max > 1 };
}

const endsInRepeat = (frame) => frame.quantified || frame.last || frame.group === 'nested';

// One frame per group. `quantified` remembers a finished branch that ended in a
// repeat, `last` the token just read, `group` how the group just closed would
// misbehave if repeated, and `choice` whether a `|` was seen anywhere inside this
// group — including inside a group nested in it, which is why it is passed
// outwards when one closes.
const fresh = () => ({ quantified: false, last: false, group: null, choice: false });

/**
 * The index just past the `[…]` opening at `open`. A `|` in a character class is
 * a literal, so the class is stepped over whole before the choice test below can
 * mistake one for a branch.
 */
function endOfClass(source, open) {
  let i = open + 1;
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i += 1;
    i += 1;
  }
  return i + 1;
}

/** A token that is neither a group nor a quantifier: nothing here can repeat. */
function markLiteral(frame, next) {
  frame.last = false;
  frame.group = null;
  return next;
}

/** Fold the group that just closed into the frame that contained it. */
function closeGroup(stack, inner) {
  const parent = stack.pop() ?? fresh();
  parent.last = false;
  if (endsInRepeat(inner)) parent.group = 'nested';
  else if (inner.choice) parent.group = 'choice';
  else parent.group = null;
  if (inner.choice) parent.choice = true;
  return parent;
}

/** A `|`: the branch that just ended is remembered, the next one starts clean. */
function openBranch(frame) {
  frame.quantified = endsInRepeat(frame);
  frame.choice = true;
  frame.last = false;
  frame.group = null;
}

/**
 * One token, folded into `state`. Returns the index the scan continues from, or
 * -1 once a repeat has been found that makes the pattern unusable — in which case
 * `state.frame.group` holds which of the two shapes it was.
 */
function scanToken(source, at, state) {
  const ch = source[at];
  if (ch === '\\') return markLiteral(state.frame, at + 2);
  if (ch === '[') return markLiteral(state.frame, endOfClass(source, at));
  if (ch === '(') {
    state.stack.push(state.frame);
    state.frame = fresh();
    return at + 1;
  }
  if (ch === ')') {
    state.frame = closeGroup(state.stack, state.frame);
    return at + 1;
  }
  if (ch === '|') {
    openBranch(state.frame);
    return at + 1;
  }
  const quant = quantifierAt(source, at);
  if (!quant) return markLiteral(state.frame, at + 1);
  if (quant.repeats && state.frame.group) return -1;
  state.frame.last = true;
  state.frame.group = null;
  return quant.end + 1;
}

/**
 * A repeat whose body can match the same text two ways costs exponential time in
 * a backtracking engine. Both engines run these expressions against a URL the
 * page chose, and the Gecko fallback runs them inside a blocking listener, so
 * one such pattern in a profile lets any site stall the browser by asking for a
 * long enough URL. `?` and `{0,1}` are always safe: they run the body once.
 *
 * Two shapes are refused, and they are told apart because the rewrite differs:
 *
 *   'nested'  a repeat around a group that itself ends in a repeat, `([a-z]+)+`.
 *             Drop one of the two repeats.
 *   'choice'  a repeat around a group holding a `|`, `(a|a)+`. Overlapping
 *             branches are what costs the time, so `(?:a|b)+` is in fact safe
 *             and is refused anyway: telling the two apart means deciding
 *             whether two branches can match the same text, and the branches can
 *             be groups themselves. Measured, `(a|a)+` and `(x(a|a))+` both take
 *             exponential time while `(?:a|b)+` stays flat — so the choice has to
 *             be seen at any depth, not just at the top of the group, and a
 *             false alarm costs a rewrite to `[ab]+` where a miss costs a browser
 *             that stops answering.
 */
function unsafeRepeat(regexSource) {
  const source = text(regexSource);
  const state = { stack: [], frame: fresh() };
  let at = 0;
  while (at < source.length) {
    const next = scanToken(source, at, state);
    if (next === -1) return state.frame.group;
    at = next;
  }
  return null;
}

/**
 * V8 reports `Invalid regular expression: /src/: reason`. Only the reason is
 * useful next to a field the user is already looking at.
 */
function regexReason(err) {
  const message = err instanceof Error ? err.message : String(err);
  const cut = message.lastIndexOf('/: ');
  if (cut !== -1) return message.slice(cut + 3);
  return message.replace(/^Invalid regular expression:\s*/, '');
}

/**
 * Globs are matched by walking the URL, not by running the compiled regular
 * expression. A regex built from several stars backtracks exponentially — the
 * pattern `*x*x*x…*y` against a long run of x's took 37 seconds at ten groups —
 * and on Gecko this runs inside a blocking listener, so one such pattern would
 * stall every request in the browser. This walk is linear in the URL length.
 * The compiled source is still kept, because declarativeNetRequest needs it and
 * matches with RE2, which cannot backtrack.
 */
function globSegments(pattern) {
  return pattern.toLowerCase().split('*');
}

function globMatches(url, segments) {
  const target = url.toLowerCase();
  const first = segments[0];
  if (segments.length === 1) return target === first;
  if (first && !target.startsWith(first)) return false;

  const last = segments[segments.length - 1];
  if (last && !target.endsWith(last)) return false;

  const end = target.length - last.length;
  let at = first.length;
  if (at > end) return false;

  // Greedy is safe with `*` alone: taking the earliest occurrence of each
  // literal never rules out a match that a later occurrence would have allowed.
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    const found = target.indexOf(segment, at);
    if (found < 0 || found + segment.length > end) return false;
    at = found + segment.length;
  }
  return true;
}

/** Never throws. An unusable pattern comes back with `regex` null and `error` set. */
export function compilePattern(pattern) {
  const raw = text(pattern).trim();
  const result = {
    pattern: raw, kind: patternKind(raw), source: '', flags: '',
    regex: null, segments: null, error: null,
  };

  if (!raw) {
    result.error = 'Enter a URL pattern.';
    return result;
  }

  if (result.kind === 'regex') {
    const parts = REGEX_SHAPE.exec(raw);
    result.source = parts[1];
    result.flags = parts[2] ? 'i' : '';
    if (!result.source) {
      result.error = 'Not a valid regular expression: add an expression between the slashes.';
      return result;
    }
  } else if (result.kind === 'glob') {
    if (!GLOB_SHAPE.test(raw)) {
      result.error = 'Not a URL pattern. Write a glob such as https://example.com/api/*, '
        + 'or a bare host such as example.com.';
      return result;
    }
    result.source = globToRegexSource(raw);
    result.flags = 'i';
    result.segments = globSegments(raw);
  } else {
    if (!HOST_SHAPE.test(raw)) {
      result.error = 'Not a valid host. Enter a host such as example.com.';
      return result;
    }
    result.source = hostToRegexSource(raw);
    result.flags = 'i';
  }

  try {
    result.regex = new RegExp(result.source, result.flags);
  } catch (err) {
    result.error = `Not a valid regular expression: ${regexReason(err)}`;
    return result;
  }

  const unsafe = unsafeRepeat(result.source);
  if (unsafe === 'nested') {
    result.regex = null;
    result.error = 'Not a usable regular expression: a repeat inside a repeat, such as ([a-z]+)+, '
      + 'can take minutes to match a single URL. Remove one of the two repeats.';
  } else if (unsafe === 'choice') {
    result.regex = null;
    result.error = 'Not a usable regular expression: a repeat around a choice, such as (a|a)+, can '
      + 'take minutes to match a single URL. Write the choice as a character class, [ab]+, or move '
      + 'the repeat inside one branch.';
  }
  return result;
}

export function compilePatterns(patterns) {
  let list = [];
  if (Array.isArray(patterns)) list = patterns;
  else if (text(patterns)) list = [patterns];
  const compiled = [];
  const errors = [];
  for (const pattern of list) {
    const entry = compilePattern(pattern);
    if (entry.regex) compiled.push(entry);
    else errors.push({ pattern: entry.pattern, message: entry.error });
  }
  return { compiled, errors };
}

export function patternError(pattern) {
  return compilePattern(pattern).error;
}

export function matchesAny(url, compiled) {
  if (!Array.isArray(compiled) || !compiled.length) return false;
  // A missing URL matches nothing: `*` compiles to `^.*$`, which would happily
  // match the empty string, and a request we cannot see is never a target.
  const raw = text(url);
  if (!raw) return false;
  const target = raw.length > MAX_MATCH_LENGTH ? raw.slice(0, MAX_MATCH_LENGTH) : raw;
  return compiled.some((entry) => {
    if (!entry) return false;
    if (entry.segments) return globMatches(target, entry.segments);
    return !!entry.regex && entry.regex.test(target);
  });
}

/**
 * An empty include list means every URL. A matching exclude always wins, which
 * mirrors the higher-priority `allow` rules the DNR compiler emits.
 */
export function urlMatchesFilters(url, includePatterns, excludePatterns) {
  const exclude = compilePatterns(excludePatterns);
  // An exclude that cannot be compiled has to fail closed. Treating it as
  // absent would widen the profile past what the user asked for, which is how a
  // credential reaches a host they deliberately ruled out.
  if (exclude.errors.length) return false;
  if (matchesAny(url, exclude.compiled)) return false;
  const include = compilePatterns(includePatterns);
  if (!include.compiled.length && !include.errors.length) return true;
  return matchesAny(url, include.compiled);
}

export function effectiveInclude(header, profile) {
  const own = Array.isArray(header?.include) ? header.include : [];
  if (own.length) return own;
  return Array.isArray(profile?.include) ? profile.include : [];
}

export function effectiveResourceTypes(header, profile) {
  const own = Array.isArray(header?.resourceTypes) ? header.resourceTypes : [];
  if (own.length) return own;
  return Array.isArray(profile?.resourceTypes) ? profile.resourceTypes : [];
}

export function urlMatchesProfile(url, profile) {
  return urlMatchesFilters(url, profile?.include, profile?.exclude);
}

/**
 * declarativeNetRequest matches with RE2, which has no backtracking, so a
 * pattern using lookaround or a backreference is rejected by Chrome. Checking
 * the source ourselves lets the compiler warn instead of failing the whole
 * rule update.
 */
/**
 * A backslash-digit is a backreference only once a group with that number
 * exists. Otherwise it is an octal escape, which RE2 accepts. `\k<name>` is
 * always one. Inside a character class neither form is a backreference, and the
 * scan steps over the class whole before this is ever asked.
 */
function isBackreference(source, at, groups) {
  const next = source[at + 1] ?? '';
  if (next >= '1' && next <= '9' && Number(next) <= groups) return true;
  return next === 'k' && source[at + 2] === '<';
}

/**
 * The capturing-group count after the `(` at `at`, or -1 when the group is a
 * lookaround — `(?=`, `(?!`, `(?<=` or `(?<!` — which RE2 cannot express.
 */
function countGroup(source, at, groups) {
  if (source[at + 1] !== '?') return groups + 1;
  const kind = source[at + 2];
  if (kind === '=' || kind === '!') return -1;
  if (kind === '<' && (source[at + 3] === '=' || source[at + 3] === '!')) return -1;
  return groups;
}

export function isRe2Safe(regexSource) {
  const source = text(regexSource);
  let groups = 0;
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === '[') {
      at = endOfClass(source, at);
      continue;
    }
    if (ch === '\\') {
      if (isBackreference(source, at, groups)) return false;
      at += 2;
      continue;
    }
    if (ch === '(') {
      groups = countGroup(source, at, groups);
      if (groups === -1) return false;
    }
    at += 1;
  }
  return true;
}

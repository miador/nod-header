import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  patternKind,
  globToRegexSource,
  hostToRegexSource,
  compilePattern,
  compilePatterns,
  patternError,
  matchesAny,
  urlMatchesFilters,
  effectiveInclude,
  effectiveResourceTypes,
  urlMatchesProfile,
  isRe2Safe,
} from '../src/lib/matcher.js';

/** Compile a pattern and match a URL through it, the way the engines do. */
const hits = (pattern, url) => {
  const compiled = compilePattern(pattern);
  assert.equal(compiled.error, null, `unexpected error for ${pattern}: ${compiled.error}`);
  return compiled.regex.test(url);
};

describe('patternKind', () => {
  test('slash-wrapped patterns are regular expressions', () => {
    assert.equal(patternKind('/^https:\\/\\/api\\./'), 'regex');
    assert.equal(patternKind('/example/i'), 'regex');
    assert.equal(patternKind('/a\\/b/'), 'regex');
    assert.equal(patternKind('/a/b/'), 'regex');
    assert.equal(patternKind('//'), 'regex');
  });

  test('a slash or asterisk makes a glob', () => {
    assert.equal(patternKind('https://*.example.com/*'), 'glob');
    assert.equal(patternKind('*.example.com'), 'glob');
    assert.equal(patternKind('/api/v1'), 'glob');
    assert.equal(patternKind('*'), 'glob');
  });

  test('a colon makes a glob only when it is not a bare trailing port', () => {
    assert.equal(patternKind('*://localhost:*/api/*'), 'glob');
    assert.equal(patternKind('https://example.com'), 'glob');
    assert.equal(patternKind('localhost:abc'), 'glob');
    assert.equal(patternKind('localhost:3000'), 'host');
    assert.equal(patternKind('127.0.0.1:8080'), 'host');
    assert.equal(patternKind('example.com:8443'), 'host');
  });

  test('an unsupported flag is not a regular expression', () => {
    assert.equal(patternKind('/example/g'), 'glob');
    assert.equal(patternKind('/example/gi'), 'glob');
  });

  test('anything else is a bare host', () => {
    assert.equal(patternKind('example.com'), 'host');
    assert.equal(patternKind('localhost'), 'host');
    assert.equal(patternKind('sub.example.co.uk'), 'host');
    assert.equal(patternKind('127.0.0.1'), 'host');
  });

  test('surrounding whitespace does not change the kind', () => {
    assert.equal(patternKind('  /example/i  '), 'regex');
    assert.equal(patternKind('  example.com '), 'host');
  });

  test('a non-string falls back to host', () => {
    assert.equal(patternKind(undefined), 'host');
    assert.equal(patternKind(null), 'host');
    assert.equal(patternKind(42), 'host');
  });
});

describe('globToRegexSource', () => {
  test('escapes every metacharacter except the asterisk', () => {
    assert.equal(globToRegexSource('a.b'), '^a\\.b$');
    assert.equal(globToRegexSource('a?b'), '^a\\?b$');
    assert.equal(globToRegexSource('a+b'), '^a\\+b$');
    assert.equal(globToRegexSource('a(b)c'), '^a\\(b\\)c$');
    assert.equal(globToRegexSource('a[b]c'), '^a\\[b\\]c$');
    assert.equal(globToRegexSource('a{1,2}b'), '^a\\{1,2\\}b$');
    assert.equal(globToRegexSource('a|b'), '^a\\|b$');
    assert.equal(globToRegexSource('a^b$c'), '^a\\^b\\$c$');
    assert.equal(globToRegexSource('a\\b'), '^a\\\\b$');
  });

  test('turns each asterisk into a lazy-free any-run and anchors the result', () => {
    assert.equal(globToRegexSource('*'), '^.*$');
    assert.equal(globToRegexSource('https://*.example.com/*'), '^https://.*\\.example\\.com/.*$');
  });

  test('a run of adjacent asterisks collapses into one', () => {
    assert.equal(globToRegexSource('**'), '^.*$');
    assert.equal(globToRegexSource('https://**.example.com/***'), '^https://.*\\.example\\.com/.*$');
    assert.equal(globToRegexSource('a**b***c'), '^a.*b.*c$');
    // Two stars match what one matches, so the extra `.*` only bought the
    // matcher another choice per character of the URL.
    assert.ok(hits('https://**.example.com/**', 'https://api.example.com/a/b'));
  });

  test('leaves the slash alone so the source stays RE2-friendly', () => {
    assert.equal(globToRegexSource('https://x/y'), '^https://x/y$');
  });

  test('a dot in the pattern is literal, not any character', () => {
    assert.ok(hits('https://example.com/*', 'https://example.com/a'));
    assert.ok(!hits('https://example.com/*', 'https://exampleXcom/a'));
  });

  test('a question mark is literal, so query strings can be targeted', () => {
    assert.ok(hits('*://example.com/api?*', 'https://example.com/api?token=1'));
    assert.ok(!hits('*://example.com/api?*', 'https://example.com/apix'));
  });

  test('the whole URL must match', () => {
    assert.ok(!hits('https://example.com/api', 'https://example.com/api/v1'));
    assert.ok(hits('https://example.com/api*', 'https://example.com/api/v1'));
    assert.ok(!hits('example.com/api*', 'https://example.com/api'));
  });

  test('a glob can match a port and a query string', () => {
    assert.ok(hits('http://localhost:*/graphql*', 'http://localhost:3000/graphql?op=x'));
    assert.ok(!hits('http://localhost:*/graphql*', 'http://localhost:3000/rest'));
  });
});

describe('hostToRegexSource', () => {
  test('matches the host itself on any scheme, port and path', () => {
    assert.ok(hits('example.com', 'https://example.com'));
    assert.ok(hits('example.com', 'https://example.com/'));
    assert.ok(hits('example.com', 'http://example.com/a/b?c=d#e'));
    assert.ok(hits('example.com', 'ws://example.com:8443/socket'));
    assert.ok(hits('example.com', 'https://example.com?q=1'));
    assert.ok(hits('example.com', 'https://example.com#top'));
  });

  test('matches any subdomain, however deep', () => {
    assert.ok(hits('example.com', 'https://api.example.com:8443/x'));
    assert.ok(hits('example.com', 'https://a.b.c.example.com/x'));
    assert.ok(hits('example.com', 'https://user@api.example.com/x'));
  });

  test('does not fall for a confusing suffix or prefix', () => {
    assert.ok(!hits('example.com', 'https://notexample.com/'));
    assert.ok(!hits('example.com', 'https://example.com.evil.tld/'));
    assert.ok(!hits('example.com', 'https://example.common/'));
    assert.ok(!hits('example.com', 'https://myexample.computer/x'));
  });

  test('does not match a host smuggled into userinfo, path or query', () => {
    assert.ok(!hits('example.com', 'https://example.com@evil.tld/'));
    assert.ok(!hits('example.com', 'https://user@example.com.evil.tld/'));
    assert.ok(!hits('example.com', 'https://x@example.com@evil.tld/'));
    assert.ok(!hits('example.com', 'https://evil.tld/example.com'));
    assert.ok(!hits('example.com', 'https://evil.tld/?next=https://example.com'));
    assert.ok(!hits('example.com', 'https://evil.tld#example.com'));
  });

  test('userinfo in front of the host does not hide it', () => {
    assert.ok(hits('example.com', 'https://user@example.com/x'));
    assert.ok(hits('example.com', 'https://user:pw@example.com/x'));
    assert.ok(hits('example.com', 'https://user@api.example.com/x'));
    assert.ok(hits('example.com', 'https://user@example.com'));
  });

  test('the root form of a host, with the trailing dot, still matches', () => {
    assert.ok(hits('example.com', 'https://example.com./'));
    assert.ok(hits('example.com', 'https://api.example.com./x'));
    assert.ok(hits('example.com', 'https://example.com.:8443/x'));
    assert.ok(hits('example.com.', 'https://example.com./'));
  });

  test('a host is matched case-insensitively', () => {
    assert.ok(hits('EXAMPLE.com', 'https://API.Example.COM/x'));
    assert.ok(hits('example.com', 'HTTPS://EXAMPLE.COM/X'));
  });

  test('a bare host with a port is a host, not a glob that matches nothing', () => {
    for (const pattern of ['localhost:3000', '127.0.0.1:8080', 'example.com:8443']) {
      const compiled = compilePattern(pattern);
      assert.equal(compiled.kind, 'host', pattern);
      assert.equal(compiled.error, null, `${pattern}: ${compiled.error}`);
      assert.equal(compiled.source, hostToRegexSource(pattern));
    }
    assert.ok(hits('localhost:3000', 'http://localhost:3000/api'));
    assert.ok(!hits('localhost:3000', 'http://localhost:30000/'));
    assert.ok(!hits('localhost:3000', 'http://localhost/'));
    assert.ok(hits('127.0.0.1:8080', 'http://127.0.0.1:8080/x'));
    assert.ok(!hits('127.0.0.1:8080', 'http://127.0.0.1:8081/x'));
    assert.ok(hits('example.com:8443', 'https://api.example.com:8443/x'));
  });

  test('an explicit port has to match exactly', () => {
    assert.equal(
      hostToRegexSource('localhost:3000'),
      '^[^:/?#]+://(?:[^/?#]*@)?(?:[^/?#@]*\\.)?localhost\\.?:3000(?:[/?#]|$)',
    );
    const compiled = compilePattern('example.com').regex;
    assert.ok(compiled.test('https://example.com:8443/x'));
    const pinned = new RegExp(hostToRegexSource('example.com:8443'), 'i');
    assert.ok(pinned.test('https://example.com:8443/x'));
    assert.ok(!pinned.test('https://example.com:9000/x'));
    assert.ok(!pinned.test('https://example.com/x'));
  });

  test('a leading or trailing dot is ignored', () => {
    assert.equal(hostToRegexSource('.example.com.'), hostToRegexSource('example.com'));
    assert.ok(hits('.example.com', 'https://api.example.com/'));
  });

  test('a single-label host such as localhost works', () => {
    assert.ok(hits('localhost', 'http://localhost:3000/api'));
    assert.ok(hits('localhost', 'http://localhost/'));
    assert.ok(!hits('localhost', 'http://notlocalhost/'));
  });

  test('an IPv4 literal works', () => {
    assert.ok(hits('127.0.0.1', 'http://127.0.0.1:8080/x'));
    assert.ok(!hits('127.0.0.1', 'http://127.0.0.11/x'));
  });

  test('a regex metacharacter in a host stays literal', () => {
    const source = hostToRegexSource('ex*mple.com');
    assert.ok(source.includes('ex\\*mple\\.com'));
    assert.doesNotThrow(() => new RegExp(source, 'i'));
  });
});

describe('compilePattern', () => {
  test('reports the kind, source, flags and a live regex', () => {
    const host = compilePattern('example.com');
    assert.equal(host.pattern, 'example.com');
    assert.equal(host.kind, 'host');
    assert.equal(host.flags, 'i');
    assert.equal(host.source, hostToRegexSource('example.com'));
    assert.ok(host.regex instanceof RegExp);
    assert.equal(host.error, null);

    const glob = compilePattern('https://*.example.com/*');
    assert.equal(glob.kind, 'glob');
    assert.equal(glob.flags, 'i');
    assert.equal(glob.source, globToRegexSource('https://*.example.com/*'));
    assert.equal(glob.error, null);
  });

  test('a regex pattern keeps its body as the source', () => {
    const plain = compilePattern('/^https:\\/\\/api\\./');
    assert.equal(plain.kind, 'regex');
    assert.equal(plain.source, '^https:\\/\\/api\\.');
    assert.equal(plain.flags, '');
    assert.ok(plain.regex.test('https://api.example.com/x'));
    assert.ok(!plain.regex.test('https://www.example.com/x'));

    const flagged = compilePattern('/example/i');
    assert.equal(flagged.source, 'example');
    assert.equal(flagged.flags, 'i');
  });

  test('a regex is not anchored, so it may match anywhere in the URL', () => {
    assert.ok(hits('/example\\.com/', 'https://cdn.example.com/a'));
    assert.ok(hits('/\\?debug=1/', 'https://example.com/x?debug=1'));
  });

  test('trims the pattern before compiling', () => {
    const compiled = compilePattern('   example.com  ');
    assert.equal(compiled.pattern, 'example.com');
    assert.ok(compiled.regex.test('https://example.com/'));
  });

  test('never throws on an invalid regular expression', () => {
    for (const bad of ['/[/', '/(/', '/a{2,1}/', '/*/', '/\\/', '/(?<a>x)(?<a>y)/']) {
      let compiled;
      assert.doesNotThrow(() => { compiled = compilePattern(bad); });
      assert.equal(compiled.kind, 'regex');
      assert.equal(compiled.regex, null, `expected ${bad} to fail`);
      assert.ok(
        compiled.error.startsWith('Not a valid regular expression: '),
        `unexpected message for ${bad}: ${compiled.error}`,
      );
      assert.ok(!compiled.error.includes('Invalid regular expression:'), 'the V8 prefix is stripped');
      assert.ok(compiled.error.length > 'Not a valid regular expression: '.length, 'a reason is included');
    }
  });

  test('an empty pattern is an error, not a match-everything', () => {
    for (const empty of ['', '   ', undefined, null, 7]) {
      const compiled = compilePattern(empty);
      assert.equal(compiled.regex, null);
      assert.equal(compiled.error, 'Enter a URL pattern.');
    }
  });

  test('empty slashes are an error rather than a silent match-everything', () => {
    const compiled = compilePattern('//');
    assert.equal(compiled.kind, 'regex');
    assert.equal(compiled.regex, null);
    assert.equal(compiled.error, 'Not a valid regular expression: add an expression between the slashes.');
  });

  test('a host with no letter or digit is an error', () => {
    const compiled = compilePattern('.');
    assert.equal(compiled.kind, 'host');
    assert.equal(compiled.regex, null);
    assert.equal(compiled.error, 'Not a valid host. Enter a host such as example.com.');
  });

  test('a glob with no wildcard and no scheme is an error, not a silent no-match', () => {
    for (const pattern of ['/api/v1', 'localhost:abc', 'example.com/api']) {
      const compiled = compilePattern(pattern);
      assert.equal(compiled.kind, 'glob', pattern);
      assert.equal(compiled.regex, null, `expected ${pattern} to be refused`);
      assert.match(compiled.error, /^Not a URL pattern\./);
      assert.ok(compiled.error.includes('example.com'), compiled.error);
    }
    // A scheme or a wildcard is enough to make it matchable.
    assert.equal(patternError('https://example.com'), null);
    assert.equal(patternError('example.com/api*'), null);
  });

  test('a repeat inside a repeat is refused, whatever it hangs off', () => {
    const bad = [
      '/^https:\\/\\/([a-z0-9]+)+\\.example\\.com\\//i',
      '/([a-z]+)+/',
      '/(a*)*/',
      '/((a+))+/',
      '/(a+|b)+/',
      '/(?:x{2,})+/',
      '/(a+){2,}/',
    ];
    for (const pattern of bad) {
      const compiled = compilePattern(pattern);
      assert.equal(compiled.regex, null, `expected ${pattern} to be refused`);
      assert.match(compiled.error, /repeat inside a repeat/);
    }
  });

  test('a repeat around a choice is refused, at any depth', () => {
    const bad = [
      // Exponential: both branches match the same text, so every character of a
      // failing URL doubles the work.
      '/^https:\\/\\/(a|a)+$/',
      '/^https:\\/\\/(a|ab)+c$/',
      // The choice is a level down from the repeat, which is still exponential —
      // measured at 2x per character — so the check cannot look only at the top
      // of the repeated group.
      '/^https:\\/\\/(x(a|a))+$/',
      '/(?:a|b)+c{1,3}/',
    ];
    for (const pattern of bad) {
      const compiled = compilePattern(pattern);
      assert.equal(compiled.regex, null, `expected ${pattern} to be refused`);
      assert.match(compiled.error, /repeat around a choice/);
    }
  });

  test('a choice is fine as long as nothing repeats it', () => {
    for (const pattern of ['/(a|b)/', '/^https:\\/\\/(api|www)\\.example\\.com\\//', '/a|b/']) {
      assert.equal(patternError(pattern), null, pattern);
    }
    // A `|` inside a character class is a literal, not a branch.
    assert.equal(patternError('/^https:\\/\\/[a|b]+\\.test\\//'), null);
  });

  test('a group that only runs once is not a nested repeat', () => {
    for (const pattern of ['/(a+)?/', '/(a+){0,1}/', '/(a+){1}/', '/(a)(b)/']) {
      assert.equal(patternError(pattern), null, pattern);
    }
    // Every source this module writes has to survive the same check. The host
    // form is the one that matters: it carries both `(?:...|...)` and `(?:...)?`,
    // and a check that read either as a repeated choice would refuse every bare
    // host the extension compiles.
    for (const pattern of ['example.com', 'localhost:3000', 'https://*.example.com/*', '*']) {
      assert.equal(patternError(pattern), null, pattern);
    }
  });

  test('an invalid regular expression reports its syntax error, not the repeat check', () => {
    const compiled = compilePattern('/([a-z]+)+[/');
    assert.equal(compiled.regex, null);
    assert.match(compiled.error, /^Not a valid regular expression: /);
  });
});

describe('case sensitivity', () => {
  test('a regex is case-sensitive without the i flag', () => {
    assert.ok(!hits('/EXAMPLE/', 'https://example.com/'));
    assert.ok(hits('/EXAMPLE/', 'https://EXAMPLE.com/'));
  });

  test('the i flag makes a regex case-insensitive', () => {
    assert.ok(hits('/EXAMPLE/i', 'https://example.com/'));
  });

  test('globs are always case-insensitive', () => {
    assert.ok(hits('HTTPS://EXAMPLE.COM/*', 'https://example.com/Path'));
    assert.ok(hits('https://example.com/API/*', 'https://example.com/api/v1'));
  });

  test('hosts are always case-insensitive', () => {
    assert.ok(hits('Example.COM', 'https://example.com/'));
  });
});

describe('compilePatterns', () => {
  test('splits the good from the bad', () => {
    const { compiled, errors } = compilePatterns(['example.com', '/[/', 'https://x/*', '']);
    assert.equal(compiled.length, 2);
    assert.deepEqual(compiled.map((c) => c.pattern), ['example.com', 'https://x/*']);
    assert.equal(errors.length, 2);
    assert.deepEqual(Object.keys(errors[0]).sort(), ['message', 'pattern']);
    assert.equal(errors[0].pattern, '/[/');
    assert.ok(errors[0].message.startsWith('Not a valid regular expression: '));
    assert.equal(errors[1].pattern, '');
  });

  test('an empty or missing list compiles to nothing', () => {
    for (const input of [[], undefined, null, {}]) {
      const { compiled, errors } = compilePatterns(input);
      assert.deepEqual(compiled, []);
      assert.deepEqual(errors, []);
    }
  });

  test('a single string is treated as one pattern, never as match-everything', () => {
    const { compiled, errors } = compilePatterns('example.com');
    assert.equal(compiled.length, 1);
    assert.deepEqual(errors, []);
  });
});

describe('patternError', () => {
  test('null for a usable pattern', () => {
    assert.equal(patternError('example.com'), null);
    assert.equal(patternError('https://*.example.com/*'), null);
    assert.equal(patternError('/^https:/i'), null);
  });

  test('a readable message for an unusable one', () => {
    assert.ok(patternError('/(/').startsWith('Not a valid regular expression: '));
    assert.equal(patternError(''), 'Enter a URL pattern.');
  });
});

describe('matchesAny', () => {
  test('false for an empty or missing list', () => {
    assert.equal(matchesAny('https://example.com/', []), false);
    assert.equal(matchesAny('https://example.com/', undefined), false);
    assert.equal(matchesAny('https://example.com/', null), false);
  });

  test('true when any entry matches', () => {
    const { compiled } = compilePatterns(['other.test', 'example.com']);
    assert.equal(matchesAny('https://api.example.com/x', compiled), true);
    assert.equal(matchesAny('https://third.test/x', compiled), false);
  });

  test('skips entries that failed to compile', () => {
    assert.equal(matchesAny('https://example.com/', [null, {}, { regex: null }]), false);
  });

  test('a missing or empty URL matches nothing, even against *', () => {
    const { compiled } = compilePatterns(['*']);
    assert.equal(matchesAny('https://example.com/', compiled), true);
    assert.equal(matchesAny(undefined, compiled), false);
    assert.equal(matchesAny(null, compiled), false);
    assert.equal(matchesAny('', compiled), false);
  });

  test('a URL beyond the cap is matched by its prefix', () => {
    const { compiled } = compilePatterns(['example.com', '*']);
    const long = `https://api.example.com/x?q=${'a'.repeat(50000)}`;
    assert.equal(matchesAny(long, compiled), true);
    // The prefix decides, so a pattern that only the far end of the URL could
    // satisfy no longer matches.
    const tail = compilePatterns(['*/callback']).compiled;
    assert.equal(matchesAny('https://example.com/callback', tail), true);
    assert.equal(matchesAny(`https://example.com/${'a'.repeat(4000)}/callback`, tail), false);
  });

  test('the cap keeps a wildcard pattern from growing with the URL', () => {
    // `^.*x.*y$` searches every pair of positions, so without a ceiling the work
    // per request grows with a URL the page chose rather than the user.
    const { compiled } = compilePatterns(['*x*y']);
    const started = Date.now();
    assert.equal(matchesAny(`https://example.com/${'x'.repeat(200000)}`, compiled), false);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  });
});

describe('urlMatchesFilters', () => {
  test('an empty include list matches every URL', () => {
    assert.equal(urlMatchesFilters('https://anything.test/x', [], []), true);
    assert.equal(urlMatchesFilters('https://anything.test/x', undefined, undefined), true);
  });

  test('a non-empty include list narrows the match', () => {
    assert.equal(urlMatchesFilters('https://api.example.com/x', ['example.com'], []), true);
    assert.equal(urlMatchesFilters('https://other.test/x', ['example.com'], []), false);
  });

  test('a matching exclude always wins over include', () => {
    const include = ['example.com'];
    const exclude = ['https://api.example.com/*'];
    assert.equal(urlMatchesFilters('https://www.example.com/x', include, exclude), true);
    assert.equal(urlMatchesFilters('https://api.example.com/x', include, exclude), false);
  });

  test('exclude also wins over an empty include list', () => {
    assert.equal(urlMatchesFilters('https://api.example.com/x', [], ['api.example.com']), false);
    assert.equal(urlMatchesFilters('https://www.example.com/x', [], ['api.example.com']), true);
  });

  test('an include list of only broken patterns matches nothing', () => {
    assert.equal(urlMatchesFilters('https://example.com/', ['/[/'], []), false);
  });

  test('a broken exclude pattern blocks everything rather than being ignored', () => {
    // Ignoring it would widen the profile past what the user asked for, which is
    // how a credential reaches a host they deliberately excluded.
    assert.equal(urlMatchesFilters('https://example.com/', ['example.com'], ['/[/']), false);
    assert.equal(urlMatchesFilters('https://other.test/', ['example.com'], ['/[/']), false);
  });

  test('one broken exclude taints the whole list, valid siblings included', () => {
    assert.equal(urlMatchesFilters('https://example.com/', ['example.com'], ['other.test', '/[/']), false);
  });

  test('a usable exclude still only blocks what it matches', () => {
    assert.equal(urlMatchesFilters('https://example.com/', ['example.com'], ['other.test']), true);
    assert.equal(urlMatchesFilters('https://other.test/', [], ['other.test']), false);
  });
});

describe('glob matching is linear, not a backtracking regular expression', () => {
  test('the walk agrees with the regular expression it replaced', () => {
    const globs = ['*', '*://api.example.com/*', 'https://*.example.com/*', '*/api/v1/*', '*.png',
      'https://x.test/a*b*c', '*://*/*', 'http://localhost:*/api/*', '*?debug=1', '*[a]*'];
    const urls = ['https://api.example.com/v1/users', 'http://localhost:3000/api/x',
      'https://x.test/aQQbZZc', 'https://cdn.example.com/img/a.png', 'https://other.test/',
      'https://X.TEST/aBc', 'https://q/?debug=1', 'https://y.test/[a]/z'];
    for (const glob of globs) {
      const entry = compilePattern(glob);
      assert.equal(entry.error, null, glob);
      const regex = new RegExp(globToRegexSource(glob), 'i');
      for (const url of urls) {
        assert.equal(matchesAny(url, [entry]), regex.test(url), `${glob} vs ${url}`);
      }
    }
  });

  test('a pattern built to make a regex backtrack returns promptly', () => {
    // As a regular expression this took 37 seconds at ten groups, inside the
    // blocking listener Gecko runs for every request.
    const pattern = `*${'x*'.repeat(14)}y`;
    const url = `https://${'x'.repeat(60)}.test/`;
    const started = process.hrtime.bigint();
    assert.equal(urlMatchesFilters(url, [pattern], []), false);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 50, `took ${ms.toFixed(1)}ms`);
  });

  test('a glob still carries a regex source, because DNR needs one', () => {
    const entry = compilePattern('*://api.example.com/*');
    assert.ok(entry.source.startsWith('^'));
    assert.ok(entry.segments.length > 1);
  });
});

describe('effectiveInclude', () => {
  const profile = { include: ['example.com'], resourceTypes: ['main_frame'] };

  test('the header list wins when it has entries', () => {
    assert.deepEqual(effectiveInclude({ include: ['api.test'] }, profile), ['api.test']);
  });

  test('falls back to the profile list', () => {
    assert.deepEqual(effectiveInclude({ include: [] }, profile), ['example.com']);
    assert.deepEqual(effectiveInclude({}, profile), ['example.com']);
  });

  test('empty when neither has entries', () => {
    assert.deepEqual(effectiveInclude({}, {}), []);
    assert.deepEqual(effectiveInclude(undefined, undefined), []);
  });
});

describe('effectiveResourceTypes', () => {
  const profile = { include: [], resourceTypes: ['main_frame', 'sub_frame'] };

  test('the header list wins when it has entries', () => {
    assert.deepEqual(effectiveResourceTypes({ resourceTypes: ['script'] }, profile), ['script']);
  });

  test('falls back to the profile list, then to empty', () => {
    assert.deepEqual(effectiveResourceTypes({ resourceTypes: [] }, profile), ['main_frame', 'sub_frame']);
    assert.deepEqual(effectiveResourceTypes({}, {}), []);
    assert.deepEqual(effectiveResourceTypes(null, null), []);
  });
});

describe('urlMatchesProfile', () => {
  test('applies the profile include and exclude lists', () => {
    const profile = { include: ['example.com'], exclude: ['*.cdn.example.com'] };
    assert.equal(urlMatchesProfile('https://api.example.com/x', profile), true);
    assert.equal(urlMatchesProfile('https://static.cdn.example.com', profile), false);
    assert.equal(urlMatchesProfile('https://other.test/x', profile), false);
  });

  test('a profile with no filters matches everything', () => {
    assert.equal(urlMatchesProfile('https://anything.test/', { include: [], exclude: [] }), true);
    assert.equal(urlMatchesProfile('https://anything.test/', {}), true);
    assert.equal(urlMatchesProfile('https://anything.test/', undefined), true);
  });
});

describe('isRe2Safe', () => {
  test('plain constructs are safe', () => {
    assert.equal(isRe2Safe('^https://example\\.com/.*$'), true);
    assert.equal(isRe2Safe('(?:a|b)+c{1,3}[a-z]\\d\\b'), true);
    assert.equal(isRe2Safe('(a)(b)'), true);
    assert.equal(isRe2Safe(''), true);
    assert.equal(isRe2Safe(undefined), true);
  });

  test('a named group stays safe', () => {
    assert.equal(isRe2Safe('(?<host>[a-z.]+)'), true);
    assert.equal(isRe2Safe('(?<a>x)(?<b>y)'), true);
  });

  test('lookahead is rejected', () => {
    assert.equal(isRe2Safe('example(?=\\.com)'), false);
    assert.equal(isRe2Safe('example(?!\\.com)'), false);
  });

  test('lookbehind is rejected', () => {
    assert.equal(isRe2Safe('(?<=https://)example'), false);
    assert.equal(isRe2Safe('(?<!https://)example'), false);
  });

  test('a numeric backreference is rejected', () => {
    assert.equal(isRe2Safe('(a)\\1'), false);
    assert.equal(isRe2Safe('(a)(b)\\2'), false);
    assert.equal(isRe2Safe('(a)(b)(c)(d)(e)(f)(g)(h)(i)\\9'), false);
  });

  test('a backslash-digit with no group to point at is an octal escape RE2 accepts', () => {
    assert.equal(isRe2Safe('x\\12'), true);
    assert.equal(isRe2Safe('\\101'), true);
    assert.equal(isRe2Safe('\\9'), true);
    // The group has to come first, and a non-capturing group is not one.
    assert.equal(isRe2Safe('\\1(a)'), true);
    assert.equal(isRe2Safe('(?:a)\\1'), true);
    assert.equal(isRe2Safe('(?<h>a)\\1'), true);
  });

  test('a named backreference is rejected', () => {
    assert.equal(isRe2Safe('(?<h>a)\\k<h>'), false);
  });

  test('an escaped parenthesis is not a group', () => {
    assert.equal(isRe2Safe('a\\(?=b'), true);
    assert.equal(isRe2Safe('\\(\\?<=x\\)'), true);
  });

  test('lookaround spelled inside a character class is literal', () => {
    assert.equal(isRe2Safe('[(?=]'), true);
    assert.equal(isRe2Safe('[\\]](?:a)'), true);
  });

  test('an octal escape inside a class is not a backreference', () => {
    assert.equal(isRe2Safe('[\\1]'), true);
  });

  test('a trailing backslash does not run off the end', () => {
    assert.doesNotThrow(() => isRe2Safe('abc\\'));
    assert.equal(isRe2Safe('abc\\'), true);
  });

  test('every source this module generates is RE2-safe', () => {
    const patterns = [
      'example.com',
      '.example.com.',
      'localhost:3000',
      '127.0.0.1',
      'https://*.example.com/*',
      '*',
      '*://example.com/api?*',
      'http://localhost:*/graphql*',
    ];
    for (const pattern of patterns) {
      const compiled = compilePattern(pattern);
      assert.equal(compiled.error, null, `${pattern}: ${compiled.error}`);
      assert.equal(isRe2Safe(compiled.source), true, `${pattern} -> ${compiled.source}`);
    }
    assert.equal(isRe2Safe(hostToRegexSource('example.com:8443')), true);
  });
});

# Security policy

Nod Header holds the kind of data that makes a report worth making promptly. A profile routinely
contains an `Authorization` bearer token or a session `Cookie`, and the extension runs with
`<all_urls>`, so a bug that sends a header one host too far is a credential disclosure rather than a
cosmetic fault. Reports are welcome and taken seriously.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's **Report a vulnerability** button on the [Security tab][advisories] of this repository.
That opens a private advisory visible only to maintainers, lets us discuss the detail without it
being public, and can be used to publish the advisory and credit you when a fix ships.

If that button is not there, private reporting has not been enabled on the repository yet. Email
**[nod-header@yusufkaradag.com](mailto:nod-header@yusufkaradag.com)** instead — or, if you would
rather not use email, open an issue saying only that you need a private channel, with no detail and no
reproduction, and it will be turned on.

[advisories]: https://github.com/miador/nod-header/security/advisories/new

### What to include

- What an attacker gets, in one sentence: which header, reaching which host, under whose control.
- The browser and its exact version, and which engine the extension chose — the options page has an
  **About** pane that reports `Declarative rules` or `Blocking webRequest`.
- A profile that reproduces it, **with the header values replaced**. The names, operations and URL
  filters are what matter; your real tokens are not needed and should not be sent.
- The URL or pattern involved, and which pattern kind you meant — a bare host, a glob, or a regular
  expression in slashes.

### What to expect

I will confirm receipt within a few days. This is a small project with no security team behind it, so
I would rather set an honest expectation than a service level I cannot keep: you will get a real
answer about whether it is a vulnerability, and if it is, what the fix is and roughly when.

Disclosure is coordinated. Once a fixed version is released and has had time to reach people through
the stores, the advisory is published, and you are credited unless you would rather not be.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

Fixes go into a new release rather than being backported. Users who installed from the Chrome Web
Store or from addons.mozilla.org update automatically; anyone running a build from source needs to
rebuild.

## In scope

These are the failures worth reporting:

- **A header reaching a URL the filters should have excluded** — a broken exclude pattern that gets
  dropped while the include rules still apply, a pattern that matches more than it reads as, or a
  profile scoped to the active tab whose rules land on every tab.
- **A profile's contents leaving the device** by any route.
- **A pattern that makes matching take an unbounded amount of time**, hanging requests or the worker.
  Glob matching is a linear walk, never a compiled expression. A user-supplied regular expression is
  refused if it repeats anything ambiguous: a group that ends in a repeat, `([a-z]+)+`, or a group
  holding a choice at any depth, `(a|a)+` and `(x(a|a))+`. Both shapes cost exponential time against a
  URL the page chose, and on the Gecko fallback they would run inside a blocking listener. A way past
  that screen is in scope, and worth reporting even if the pattern has to be typed by hand — an
  imported profile is a pattern the user did not write.
- **An imported file doing more than importing** — code execution, or reaching data outside the
  extension, from a crafted JSON or ModHeader export.
- **A web page reading or writing the extension's state**, or otherwise reaching a privileged
  context.
- **A header the browser reserves being modified anyway** in a way that breaks an origin's security
  assumptions.

## Not vulnerabilities

Stated plainly so nobody spends their time on them:

- **The extension sends the headers you configure, to the URLs you scope them to.** That is the
  product. Being able to send `Authorization` to a site is the feature, not a flaw.
- **Profiles are stored unencrypted in the browser's local storage, and exports are plaintext JSON.**
  This is documented in [PRIVACY.md](PRIVACY.md). Local storage is protected by the browser profile
  and the operating-system account, and the extension deliberately holds no key of its own to
  encrypt with — anywhere it could keep one, an attacker with local access could read too.
- **An attacker who already controls the browser profile can read the profiles.** So can they read
  the cookie jar.
- **Bugs in Chrome, Edge or Firefox themselves.** Report those to the vendor; if the extension can
  work around one, that is an ordinary issue.
- **Reports produced by a scanner with no working reproduction**, and anything about the absence of
  headers this extension does not control on pages it does not serve.

## What the threat model rests on

Worth knowing before you look, because it narrows where a real bug can be:

- **No network code.** The packages contain no `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource` or `sendBeacon`, and no remote script, stylesheet, font or image. There is no
  account and no sync service. Nothing leaves the device by design, so any path that does is a bug.
- **No dynamic code.** No `eval`, no `new Function`, no dynamic `import()`, no string-bodied timers,
  and no `innerHTML` — the pages build their DOM node by node, so imported text has no route to
  becoming code.
- **The browser enforces the two claims above.** Both manifests set an explicit
  `content_security_policy.extension_pages` of `script-src 'self'; object-src 'none'; style-src 'self';
  img-src 'self'; connect-src 'none'; base-uri 'none'; frame-src 'none'`. `connect-src 'none'` means a
  page of this extension cannot open a network connection even if code to do so were introduced, and
  `script-src 'self'` means no script can be injected or fetched. These are platform guarantees rather
  than review promises, which is where a report about either should start.
- **No third-party code in the packages.** `package.json` has no `dependencies`, so everything inside
  a published zip is this repository plus Node's own standard library. The `devDependencies` are
  ESLint and four of its plugins; they run on a maintainer's machine and in the `lint` CI job, and
  nothing that ships imports them. See the reasoning in
  [CONTRIBUTING.md](CONTRIBUTING.md#nothing-that-ships-has-a-dependency).
- **Storage is local.** `storage.local` holds the profiles and the log. `storage.session` holds one
  engine diagnostics report so the options page can still show the last warnings after the service
  worker has been shut down and restarted; it is cleared when the browser session ends. Neither is
  synced.
- **Filters fail closed.** A pattern that cannot be compiled, or that the browser's own matcher will
  not accept, stops the profile from being published rather than narrowing it. Four modules have to
  agree on this, and a way to make any of them fail open instead is exactly the kind of report this
  policy is for.

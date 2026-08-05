# Contributing to Nod Header

Thanks for considering it. Nod Header is a small, deliberately dependency-free extension, and the
things that make it worth contributing to — no third-party code in the supply chain, no network
calls, rules that fail closed — are only true because they are checked on the way in. This document
is what to check.

Most of it is specific to this project. If you have contributed to a browser extension before,
skim [Constraints that are not up for debate](#constraints-that-are-not-up-for-debate) first, since
that is where this repository is unusual.

Taking part means keeping to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through
[SECURITY.md](SECURITY.md), never through a public issue.

## Before you open a pull request

- **An issue exists and says what should change.** For anything beyond a typo, open an issue first
  and let it be agreed. It is a poor trade to write a feature and discover the objection afterwards.
- **`npm run lint` and `npm test` pass.** `npm install` once first — ESLint is the only thing to
  install, and it is the only reason `node_modules` exists here.
- **The integration suite passes in at least one browser.** `npm run build && npm run test:integration`.
  CI runs Chrome, Edge, Firefox and the Firefox `webRequest` fallback; one locally is enough before
  you push.
- **New logic has unit tests, and anything that changes what goes on the wire has an integration
  test.** See [Tests](#tests).
- **No new `dependencies` entry.** A `devDependency` needs a reason in the description.
- **`CHANGELOG.md` has an entry under `## [Unreleased]`** if the change is visible to a user.
- **You have not touched `version` in `package.json`.** The release workflow owns it.
- **`dist/` is not in the diff.** It is generated and git-ignored.

## Reporting a bug

Open an issue with:

- The browser and its exact version.
- Which engine the extension chose: the options page has an **About** pane that reports it
  (`Declarative rules` or `Blocking webRequest`), along with the rule counts and any warnings.
- The profile that reproduces it. The profile menu can copy a profile as JSON, which is the fastest
  way to hand over a filter set exactly as it was.
- What you expected on the wire and what actually arrived.

**Strip your secrets from that JSON before posting it.** Exported profiles contain header values
verbatim, which is exactly where an `Authorization` bearer token or a session `Cookie` lives.
Replace the values; the names and filters are the part that matters for a bug report.

If the report is about a URL filter, say which pattern kind you meant — a bare host, a glob or a
regular expression in slashes — because the same text can be read as more than one of those.

## Reporting a security issue

Do not open a public issue. [SECURITY.md](SECURITY.md) has the process, what to include, and what is
in scope — briefly: use GitHub's **Report a vulnerability** button on the repository's Security tab,
which opens a private advisory only maintainers can see.

Worth reporting privately rather than publicly: any path where a header reaches a URL the filters
should have excluded, any way a profile's values escape the device, and any input that makes matching
take an unbounded amount of time.

## Building and testing

Three different Node floors, for three different reasons:

| To | You need | Because |
| --- | --- | --- |
| Build, and run the unit tests | Node 18 | Nothing to install; the scripts use only built-ins. CI runs these on 20, 22 and 24 |
| Run `npm install` and `npm run lint` | Node 20.19, 22.13 or 24+ | ESLint 10's own floor, and what `engines` in package.json declares |
| Run the integration suite | Node 22 | It drives Chrome over a global `WebSocket` |

In practice: use a current Node and none of this matters. `engines` names the middle row, because
that is the floor `npm install` has to clear; Node 18 is enough only if you are building the extension
rather than changing it, which needs no install at all.

```sh
npm test                          # the unit suite
npm run build                     # both targets into dist/
npm run build:chrome              # dist/chrome, also what Edge loads
npm run build:firefox             # dist/firefox
npm run zip                       # both, plus the store packages
npm run icons                     # redraw the icon and every PNG size
npm run check:placeholders        # documents still carrying a placeholder
npm run clean                     # remove dist/
```

The integration suite needs a build present, and takes the browser as an argument:

```sh
npm run build
npm run test:integration                                          # Chrome
npm run test:integration -- --browser=firefox
npm run test:integration -- --browser=edge
npm run test:integration -- --browser=firefox --engine=webrequest
npm run test:integration -- --browser=chrome --headful            # watch it happen
```

It drives Chrome and Edge over the DevTools protocol and Firefox over Marionette, both built into
the browsers, so there is no driver to install. A browser you do not have installed is skipped.

## Constraints that are not up for debate

These are not style preferences. A pull request that breaks one of them will be asked to change,
however good the feature is.

### Nothing that ships has a dependency

`package.json` has no `dependencies` at all, and it is not going to get one. Everything inside the
packages is written here: the build, the ES-module bundler, the PNG encoder and the ZIP writer are
all in `scripts/`, against Node built-ins.

This is a security posture, not asceticism. An extension with `<all_urls>` and the user's
`Authorization` headers in local storage is a high-value target, and every transitive dependency is
another maintainer who can push code into it. A dependency that would end up in `dist/` needs to be
argued for in an issue before any code is written, and the answer will usually be to write the part
you need.

The `devDependencies` are a different question, and there are five, all ESLint:

```bash
eslint  @eslint/js  @eslint/json  @eslint/compat  eslint-formatter-compact
```

They earn their place by finding things review does not. ESLint's `require-atomic-updates` found a
real bug in `storage.js` — a state read still in flight overwriting a newer write, which left the
engine applying rules from a profile revision one edit old. Nothing that ships imports them, no
runtime code touches them, and only the `lint` job in CI installs them.

The bar for a sixth is the same as for a first: it has to find a class of mistake that neither the
tests nor a reviewer will, and it has to stay out of `dist/`. Mozilla's `addons-linter` is run
through `npx` in CI for that reason — it is useful once per release and never needs installing here.

### The background bundle only accepts a subset of ES modules

Chrome loads the background as a module service worker and Firefox loads it as one classic script,
so `scripts/build.mjs` bundles it into a single IIFE. That bundler understands a narrow subset, and
anything outside it **fails the build with a file and a line** rather than shipping broken:

- `import { a, b } from './relative/path.js';` — relative, with the `.js`, named imports only.
- `export const`, `export let`, `export function`, `export class`.
- No default exports, no `export { a, b }` lists, no re-exports, no namespace imports, no dynamic
  `import()`.

This applies to everything reachable from `src/background/service-worker.js`, which in practice means
all of `src/lib/` too. The `src/popup/` and `src/options/` pages ship as the real modules they are
and have no such restriction.

### One namespace for browser APIs

Never reach for `chrome.*` or `browser.*` directly. `src/lib/browser.js` exports `api`, plus the
feature probes (`isGecko`, `hasModifyHeaders`, `hasBlockingWebRequest`) that the engine uses to
decide what this browser can actually do. Going around it is how a change works in one browser and
silently does nothing in the other.

### Logic stays testable

`src/lib/matcher.js`, `rules.js`, `model.js` and `portable.js` hold the decisions worth testing and
contain no browser APIs, which is why the unit suite can cover them without a browser. Put new logic
there rather than in the service worker. `storage.js` does touch the API and is tested against
`test/helpers/fake-browser.js`.

### Filters fail closed

If a URL pattern cannot be compiled, or is not safe for the matcher the browser will use, the
answer is never "drop that pattern and apply the rest". An exclude pattern that gets dropped while
the include rules ship is how an `Authorization` header reaches a host the user explicitly excluded.
Four places have to agree on this, and all four currently refuse rather than narrow the profile:
`src/lib/matcher.js`, `src/lib/rules.js`, `src/background/log.js` and
`src/background/engine-webrequest.js`. If you add a fifth consumer of a pattern, it agrees too.

The same reasoning applies to "active tab only": if the active tab cannot be identified, the rules
must not be published as ordinary rules that apply everywhere.

## Traps in this codebase

Every one of these has cost a real bug. They are easy to reintroduce.

- **A rule condition must always name its resource types.** Omit `condition.resourceTypes` and
  Chrome matches every type *except* `main_frame`, so no header ever applies to a top-level page
  load while the UI cheerfully reports success. `rules.js` emits an explicit vocabulary read from
  the browser's own `ResourceType` enum.
- **Chrome allows `append` on only 21 request headers,** and an append outside that list does not
  fail on its own — it rejects the whole atomic `updateDynamicRules` batch, so one bad row silently
  takes every other rule down with it. `APPENDABLE_REQUEST_HEADERS` in `src/lib/constants.js`.
- **Chrome matches URLs with RE2,** which has no lookahead, lookbehind or backreferences. A pattern
  JavaScript accepts can still be refused, so regex rules are checked with `isRegexSupported` before
  the batch goes in.
- **Header rules count against the small quota.** `modifyHeaders` is an "unsafe" rule, capped at
  5,000, not the 30,000 that safe rules get.
- **The service worker is not persistent.** Every listener is registered synchronously at the top
  level of `service-worker.js`, and nothing important lives in a module variable. If a change needs
  state to survive, it goes in storage.
- **Gecko answers messages by returning a promise.** Returning `true` from `onMessage` closes the
  channel before the reply arrives.
- **Matching must stay linear.** Glob patterns are matched by walking literal segments, not by a
  generated regular expression, because the regex version took 37 seconds on a pathological input.
  A user-authored regular expression with a nested quantifier is rejected outright.
- **The icon is drawn twice.** The shield bars in `#i-mark` appear in `popup.html`, `options.html`
  and `scripts/make-icons.mjs`, and all three must match. Never hand-edit the PNGs; run
  `npm run icons`.

## Code conventions

`npm run lint` enforces the rules a machine can check; `npm run lint:fix` applies what is
auto-fixable. `eslint.config.mjs` says why each rule is there, and two of them are this project's
own:

- **`no-undef` with globals written out by hand.** Because `chrome` and `browser` are deliberately
  absent from every globals list, a bare `chrome.storage.…` is an undefined variable and the lint
  fails. The "one namespace for browser APIs" rule above is machine-checked, not reviewer-checked.
- **`no-restricted-syntax` on `globalThis.chrome` and `globalThis.browser`,** which closes the same
  rule from the other side. `src/lib/browser.js` is the one file exempt, because asking which
  namespace exists is its whole job.

JSON is linted too. `JSON.parse` accepts a duplicate key in silence and keeps the last one, which is
how a permission or a version floor gets quietly overridden by an older copy of itself in a manifest.

Formatting is not enforced, deliberately: reformatting 11,000 lines would bury the history that
explains why the code looks the way it does. So the rest is observed rather than checked — match the
file you are editing.

- Two spaces, single quotes, semicolons, no tabs. ES modules everywhere: `.js` under `src/`, `.mjs`
  for the scripts in `scripts/`.
- Lines land around 100 columns. Some go over where breaking a sentence in a user-facing message
  would hurt it more than the length does.
- **Comments explain why, not what.** The code says what it does. A comment earns its place by
  recording the constraint, the browser behaviour or the bug that made the code look like this —
  most comments in this repository are of that kind, and it is why the traps above stayed fixed.
- User-facing strings are sentences, in the interface's voice, and say what to do next rather than
  what went wrong internally. Existing warnings are the reference.
- Naming follows the product, not the platform: a *profile*, a *header row*, the *master switch*.

For CSS, `src/shared/tokens.css` holds the design tokens and both pages use them. The popup is
specified to the pixel at 780px; the narrow-viewport layout is one media query at the end of
`popup.css` and the design above it is not to be disturbed. If you change a measurement, say in the
pull request what you measured it against.

## Tests

- **Logic changes need unit tests.** One file per module under `test/`, plain `node:test`, no
  bundling and no browser.
- **Anything that changes what reaches the network needs an integration test** in
  `integration/headers.test.js`. Those assert against a local server that records the headers it
  received, not against the extension's own account of itself — which is the point, because the
  extension can report success while sending nothing.
- **A bug fix gets a test that fails before it.** If the test cannot be made to fail first, say so
  in the pull request and explain why.
- Do not weaken an assertion to make a suite green. If a test is wrong, fix the test in its own
  commit and say what was wrong with it.

The integration harness lives in `integration/harness/` and is deliberately outside `test/`: Node
treats every file under a directory named `test` as a test file, which would make the harness modules
look like tests.

## Commits and pull requests

- One concern per pull request. A refactor and a fix in the same diff cannot be reviewed properly or
  reverted separately.
- Subject line in the imperative, under about 70 characters, no trailing period: *Reject an exclude
  pattern that RE2 cannot match*, not *fixed stuff*.
- The body explains **why**. The diff already shows what changed. If it fixes an issue, reference it.
- Keep the history readable — rebase rather than merge, and squash the "address review" commits
  before merge.
- A pull request describes what it changes, how it was tested, which browsers it was tested in, and
  anything a reviewer should be suspicious of. If it touches the manifest, permissions or the
  Firefox `data_collection_permissions` block, say so explicitly: both stores review those, and a
  change there can hold up a release.

## Review

Expect a reviewer to ask about: whether a filter can fail open, whether the change behaves the same
on Chrome and on Gecko, whether a rule still applies to `main_frame`, whether anything new can be
slow on a hostile input, and whether a new string reads like the rest of the interface.

Reviews are about the code. Disagree with the argument, take the change, or make the case again with
evidence — a measurement, a browser bug report, a failing test.

## Versions and the changelog

`package.json` is the single source of truth for the version: the build stamps it into both manifests
and into the zip filenames. **Do not edit it in a pull request.** `scripts/version.mjs` and
`.github/workflows/release.yml` move it, and versions are strict `MAJOR.MINOR.PATCH` — a prerelease
suffix is not a version a browser will load, so the script refuses one.

Add user-visible changes to `## [Unreleased]` in `CHANGELOG.md`, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections already there. Write the entry for
someone reading release notes, not for someone reading the diff.

## Licensing of contributions

The project is licensed under the [Apache License 2.0](LICENSE). There is no CLA to sign: by opening
a pull request you affirm that the contribution is your own work, that you have the right to submit
it, and that you license it to the project under those same terms — which is the arrangement
described in section 5 of the license itself.

If any part of the contribution is not yours, say so in the pull request and name the source and its
license. Code under a license incompatible with Apache 2.0 cannot be accepted, however small.

You may sign off commits with `git commit -s` if you prefer an explicit record; it is not required.

## AI-assisted contributions

Using an AI assistant is fine. Not saying you did is not.

If a meaningful part of a contribution was generated by a tool, disclose it in the commit with a
trailer:

```bash
Co-Authored-By: <AI tool name and version>
Generated-by: <AI tool name and version>
```

Disclosure changes nothing about your responsibility. You are the author: you are expected to have
read every line, to understand why it is correct, to have run the tests, and to be able to answer a
reviewer's questions about it. Generated code that its submitter cannot explain will be closed, and
this is not a rule about tools — it is the same standard applied to code copied from anywhere else.

Two specifics for this repository, because assistants get them wrong often enough to be worth
naming: an assistant will happily suggest a dependency, and it will happily produce a rule condition
with no `resourceTypes`. Both are in the lists above for a reason.

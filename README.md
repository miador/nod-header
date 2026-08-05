# Nod Header

Add, override and remove HTTP request and response headers in your browser.

Nod Header is a Manifest V3 extension for Chrome, Edge and Firefox, and a replacement for
ModHeader. You keep sets of headers in named profiles, decide which URLs and resource types each
one applies to, and flip the whole thing on or off from the toolbar. It is built for people who
test APIs, work behind feature flags and auth gateways, or need to reproduce a request exactly as
some other client would send it. There is no account, no sync service and no network code:
everything lives in the browser's local storage on the device.

## Features

- Request and response headers, in the same profile.
- A dropdown of the headers people actually reach for — Authorization, Content-Type, the CORS and
  security families, tracing headers — grouped, plus **Custom header** at the end, which empties the
  field and lets you type any name. Choosing a name also offers its usual values as autocomplete.
- Set, append and remove as separate operations, so you can also strip a header the site sends.
- Profiles, with only the active one live. Duplicate, rename and reorder headers by dragging.
- URL filters that accept globs, bare hostnames and regular expressions, with a separate exclude
  list that always wins.
- Resource-type filters: page, frame, XHR / fetch, script, image, font, media, WebSocket and the
  rest.
- Per-header overrides, so one header in a profile can target a narrower set of URLs or types than
  the profile does.
- Import and export as JSON, for one profile or all of them, with or without your settings.
- ModHeader import, including its URL, exclude and resource filters.
- A matched-request log, read-only, capped and stored locally, so you can confirm a rule fired.
- A keyboard shortcut for the master switch.
- Light and dark themes, or follow the system setting.

## Install

**Firefox — [get it from addons.mozilla.org][amo].** Signed and reviewed by Mozilla, and it updates
itself.

Chrome and Edge are not in a store yet; build them from source below. The build is the same one the
store package is cut from, so nothing is missing from it.

[amo]: https://addons.mozilla.org/firefox/addon/nod-header/

## Install from source

There is nothing to install to build this. The project has no runtime dependencies and the build
scripts use only Node built-ins, so a clone and a Node are the whole toolchain. You need Node 18 or
newer. (ESLint is a development dependency, needed only if you are going to change the code — see
[Development](#development).)

```sh
git clone https://github.com/miador/nod-header.git
cd nod-header
node --version   # 18.x or newer
```

### Chrome

```sh
npm run build:chrome
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode**, top right.
3. Click **Load unpacked** and select the `dist/chrome` directory.

### Edge

Edge runs the same build as Chrome.

```sh
npm run build:chrome
```

1. Open `edge://extensions`.
2. Turn on **Developer mode**, in the left sidebar.
3. Click **Load unpacked** and select the `dist/chrome` directory.

### Firefox

```sh
npm run build:firefox
```

1. Open `about:debugging`.
2. Click **This Firefox**.
3. Click **Load Temporary Add-on** and select `dist/firefox/manifest.json`.

A temporary add-on is removed when Firefox restarts, and its storage goes with it. Export anything
you want to keep before you close the browser — or install [from addons.mozilla.org][amo] instead,
which persists and updates itself. Load it from source only when you are changing the code.

### Supported versions

| Browser | Minimum | Why |
| --- | --- | --- |
| Chrome, Edge | 116 | `minimum_chrome_version`. Newer resource types are read from the browser's own enum at runtime, so an older Chrome simply never sees them |
| Firefox | 140 | The version that introduced `data_collection_permissions`, which every new extension has to declare. It is also past 127, from which Firefox grants `host_permissions` at install rather than leaving them for the user to find |
| Firefox for Android | 142 | The Android version that introduced `data_collection_permissions` |

The popup panel is 740px. The design it comes from is 780px, but Chrome's popup ceiling is 800px, and
20px of slack was not enough — see the note at the top of `popup.css`. The 40px came off the value
column, so every other measurement is still the design value.

Android opens the popup in the device viewport instead, around 412px, where the row drops its fixed
columns and the value field moves onto its own line. That layout lives in one media query at the end
of `popup.css`, selected by `(hover: none) and (pointer: coarse)` rather than by width alone: Chrome
sizes a popup from its content, so a width-only query changes the width it is testing and both states
end up self-consistent. A desktop pointer is never coarse, so the 740px layout always holds there.

## Usage

### Adding a header

Click the Nod Header icon to open the popup. Type a name in the **Header** column and a value in
**Value**; the row's switch turns that one header on and off. **Add header** appends an empty row.

The **Header** field is both a text field and a picker. The chevron at its right edge opens a grouped
list of common headers; the last entry, **Custom header**, clears the field so you can type a name of
your own. Typing directly also suggests matching names, and once a header is named, the **Value**
field suggests the values that header usually takes — `application/json` for `Content-Type`,
`no-store` for `Cache-Control`, and so on. Suggestions are only suggestions: any name or value the
HTTP spec allows is accepted.

The pencil button opens **Header details**, where a header gets the rest of its settings: whether it
applies to the **request** or the **response**, whether the operation is **set**, **append** or
**remove**, an optional comment for your own benefit, its own URL patterns, and its own resource
types. Remove is the only operation that does not need a value.

Select rows with their checkboxes to enable, disable, duplicate or delete several at once. The
status bar at the bottom says whether rules are active, and **View matched requests** opens the log.

### The master switch

The switch in the top bar is the master switch. Turned off, Nod Header applies nothing at all: no
rules are registered with the browser, no header is added, changed or removed. Your profiles are
untouched and come back exactly as they were when you turn it on again. Chrome lists the keyboard
shortcut for this switch at `chrome://extensions/shortcuts`, where you can also change it.

### Profiles

Only the active profile applies. The **Profile** dropdown in the popup chooses it, and changing the
dropdown swaps the live set of headers immediately. Headers in every other profile are stored and
inert, which makes a profile per environment — local, staging, a customer's tenant — the normal way
to work. The profile menu, behind the three dots, creates, renames, duplicates and deletes
profiles, edits the profile's URL filters, sorts headers by name and copies the profile as JSON.

### How the filters compose

For a header to change a request, all of this has to hold:

1. The master switch is on, the header is in the active profile, and the header's own switch is on.
2. The header has a valid name, and a value unless the operation is remove.
3. The URL matches the **include** list. A header's own include list is used when it has one;
   otherwise the profile's is. An empty list matches every URL.
4. The URL does not match the profile's **exclude** list. Exclude is a profile-level setting, it
   applies to every header in the profile, and it always beats include.
5. The request's resource type is in the effective **resource types**. A header's own list is used
   when it has one; otherwise the profile's is. An empty list matches every type.

The profile option **Only apply to the tab that is active when the rules are saved** narrows
everything above to that single tab.

The status bar is the shortcut into all of this: clicking **Rules active for…** opens **URL filters**,
where **Apply to** switches between *All sites* — an empty include list — and *Specific URLs*, which
starts you off with a pattern for the tab you are looking at.

### Pattern kinds

A pattern is read as a regular expression if it is wrapped in slashes; otherwise as a glob if it
contains a colon, a slash or an asterisk; otherwise as a bare host.

| Kind | How it is written | Example | What it matches |
| --- | --- | --- | --- |
| Bare host | a hostname on its own | `api.example.com` | that host and any subdomain of it, on any scheme, port and path |
| Glob | contains `:`, `/` or `*`; `*` matches any run of characters, everything else is literal | `*://localhost:*/api/*` | the whole URL, so `http://localhost:8080/api/users` matches and `http://localhost:8080/health` does not |
| Regular expression | wrapped in slashes, with an optional `i` flag | `/^https:\/\/[a-z0-9-]+\.internal\//i` | the whole URL, by JavaScript regular expression |

Patterns go one per line. A pattern that cannot be parsed is reported in the dialog that holds it
rather than silently ignored.

## Migrating from ModHeader

1. In ModHeader, export your profiles to a JSON file.
2. In Nod Header, click **Import** in the popup and pick that file.

What carries over: profile names, request headers, response headers, the enabled state of each
header, append mode as the **append** operation, an entry with a name and no value as a **set** with
an empty value, URL filters and exclude URL filters as include and exclude patterns, and resource
filters as resource types. ModHeader stores its URL filters as regular expressions, so they arrive
as slash-wrapped regex patterns and stay readable.

Those expressions are imported exactly as you wrote them. ModHeader hands its filter to the browser
as a `regexFilter`, which searches anywhere in the URL, so anchoring them on the way in would quietly
break the ones that do not start at the scheme — `localhost:3000/.*` is the common example. A filter
that will not compile is skipped and named, rather than imported as a pattern that matches nothing.

What does not: tab filters and tab-group filters are dropped, because Nod Header scopes by URL,
resource type and the active tab rather than by a tab id. The import tells you which profiles lost a
filter that way. Fields Nod Header has no equivalent for are ignored. A single malformed header
never fails the import — it is skipped and reported.

Import also accepts a Nod Header export, a bare array of profiles, and a single profile object, so
a profile pasted out of a chat message works too.

## Permissions

- **declarativeNetRequest** — lets the browser change headers on Nod Header's behalf, from rules it
  compiles from your profiles. The extension never sees page content or response bodies this way.
- **storage** — keeps your profiles, settings and log in `storage.local` on this device. It is not
  used for sync, and there is no account to sync to.
- **webRequest** — read-only observation, used only to note in the matched-request log that a request
  matched. It does not inspect or alter what was sent, and the log is off until you turn it on.
- **webRequestBlocking** — Firefox only, and a fallback rather than the normal path: it is the engine
  used when a browser cannot modify headers declaratively. Unlike the observation above, an engine
  does read and rewrite each request's header list. No shipping Firefox needs it today; the code is
  there so the extension still works if one stops supporting declarative header rules.
- **Host access to all sites** — a header rule can name any URL, so the extension has to be allowed
  to act on any URL. It is not used to read pages, and no content script is injected.

Nothing leaves the device. Nod Header makes no network requests of its own, contains no analytics
and no remote code, and reports nothing anywhere. See [PRIVACY.md](PRIVACY.md).

## Development

```sh
npm install           # ESLint, the only thing there is to install
npm run lint          # eslint over src, scripts, test, integration and the JSON
npm run lint:fix      # apply what is auto-fixable
npm test              # node --test over test/
npm run build         # build every target into dist/
npm run build:chrome  # dist/chrome, also used by Edge
npm run build:firefox # dist/firefox
npm run zip           # build every target and write the store packages
npm run icons         # redraw src/assets/icon.svg and every PNG size from one description
npm run clean         # remove dist/
```

The tests are plain `node:test` files and run against the source, with no bundling and no browser.
The modules that hold the logic worth testing — the pattern matcher, the rule compiler, the state
model and the import and export format — are free of browser APIs for exactly that reason.

### Integration tests

The unit tests decide what rules the compiler *should* produce. The integration suite decides whether
a real browser, running the real build, actually changes a real request — the one question no unit
test can answer. It installs `dist/` into an installed browser, writes a profile into the extension's
own storage, then navigates to a local server that records exactly what arrived on the wire.

```sh
npm run build
npm run test:integration                                        # Chrome
npm run test:integration -- --browser=firefox
npm run test:integration -- --browser=edge
npm run test:integration -- --browser=firefox --engine=webrequest
npm run test:integration -- --browser=chrome --headful          # watch it happen
```

There is nothing to install: the suite drives Chrome and Edge over the DevTools protocol and Firefox
over Marionette, both of which are built into the browsers, so no driver binary and no automation
library is involved. It needs Node 22 or newer for its global `WebSocket`. A browser that is not
installed is skipped rather than failed; pass `--require` to turn that into a failure, which is what
CI does so a green run can never mean "tested nothing".

`--engine=webrequest` turns `declarativeNetRequest` off in Firefox, which is the only way to exercise
the blocking `webRequest` fallback against a real network stack — every shipping browser now prefers
the declarative engine, so that code would otherwise never run in a test.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | What it proves |
| --- | --- |
| `lint` | ESLint passes, including the two rules specific to this codebase; also lists any placeholder still left in the documents, as a warning |
| `unit` | `node --test` and a full build on Node 20, 22 and 24, plus macOS and Windows — the build writes paths and zip entries by hand |
| `build` | both targets build, both manifests carry the `package.json` version, and the unpacked trees and store packages are kept as artifacts |
| `integration` | Chrome, Edge, Firefox and the Firefox `webRequest` fallback each change a real request, using the artifact `build` produced |
| `amo-lint` | the Firefox package passes Mozilla's `addons-linter`, the same validator AMO runs on upload |

Only first-party `actions/*` actions are used. The browsers are already on the GitHub-hosted Ubuntu
images, so nothing third-party is needed to obtain them.

### Releasing

`.github/workflows/release.yml` owns the version. `package.json` is the single source of truth —
the build stamps it into both manifests and into the zip filenames — and there are two ways in:

- **Actions → Release → Run workflow**, choosing `patch`, `minor` or `major` (or an exact version).
  It bumps `package.json`, commits, tags `vX.Y.Z`, and creates the GitHub release with both store
  packages attached. This is the normal path, and the one where the tag and the bumped
  `package.json` are the same commit.
- **Creating a release by hand** with a tag like `v1.4.0`. The workflow then syncs `package.json` on
  the default branch to `1.4.0`, commits it, and attaches packages built at that version. It builds
  from the default branch rather than from the tag, so it first checks that the two are the same
  commit and stops if they are not — otherwise a tag placed behind a branch that had moved on would
  get packages built from code it does not contain.

Either way the version increments automatically and the release carries packages that match it.
Neither path will publish while a document still holds a placeholder: `scripts/check-placeholders.mjs`
runs in strict mode here, because `SECURITY.md` links to the private-advisory form and a link that
goes nowhere sends the next reporter to a public issue.
Versions are strict `MAJOR.MINOR.PATCH`: `scripts/version.mjs` refuses a prerelease or build suffix,
because a browser reads `version` as up to four dot-separated integers and rejects a manifest that
carries anything else. If the default branch is protected, the workflow needs an exception to push
the version commit.

Layout of `src`:

- `lib/` — everything pure or nearly pure: the state model, storage, the pattern matcher, the rule
  compiler, the import and export format, and the one module that papers over `chrome` versus
  `browser`.
- `background/` — the service worker, the engines that talk to the browser, the matched-request log
  and the toolbar badge.
- `popup/` — the toolbar popup: profiles, the header grid and the detail dialogs.
- `options/` — the options page: settings, the matched-request log and diagnostics.
- `shared/` — design tokens and base styles shared by both pages.
- `assets/` — the source icon.

`src/manifest.chrome.json` and `src/manifest.firefox.json` sit next to those directories; the build
copies the right one to `dist/<target>/manifest.json`.

Outside `src`:

- `test/` — the unit suite, one file per module under test.
- `integration/` — the browser suite and its harness. It lives outside `test/` on purpose: Node
  treats every file under a directory named `test` as a test file, which would have made the harness
  modules themselves look like tests.
- `scripts/` — the build, the icon generator, the version tool and the integration runner.

## Architecture

The profile is the input and browser rules are the output. `src/lib/rules.js` compiles the active
profile into declarativeNetRequest rules: applicable headers are grouped by their effective include
list, resource types and target, so one rule can carry several header modifications, each exclude
pattern becomes a higher-priority `allow` rule that suppresses the modifications, and conditions
prefer a `regexFilter` built by `src/lib/matcher.js` so the rules, the fallback engine and the log
all agree on what a pattern means. On Chrome and Edge those rules are installed as dynamic rules —
or as session rules when the profile is limited to the active tab. Firefox uses the same compiler,
and falls back to a blocking `webRequest` engine that evaluates the same compiled patterns itself
when `modifyHeaders` is not available. The background worker owns that choice and nothing else does.

```bash
src/
  lib/matcher.js              patterns to anchored regular expressions
  lib/rules.js                profile to declarativeNetRequest rules
  lib/portable.js             import and export, including ModHeader
  lib/model.js                the stored shape, and its repair functions
  lib/storage.js              storage.local, cached and change-aware
  lib/browser.js              one namespace, plus feature probes
  background/service-worker.js  messages, events, lifecycle
  background/engine.js          picks an engine from the feature probes
  background/engine-dnr.js      declarativeNetRequest, Chrome and Edge
  background/engine-webrequest.js  blocking webRequest, Firefox fallback
  background/log.js             the matched-request log
  background/badge.js          the toolbar badge
```

## Known limits

- Some headers cannot be changed by any extension, because the browser owns them:
  `content-length`, `host`, `connection`, `transfer-encoding`, `upgrade`, `keep-alive`,
  `proxy-authorization`, `trailer` and `te`. Nod Header lets you write a rule for one and warns
  that it will have no effect, rather than pretending it worked.
- declarativeNetRequest matches regular expressions with RE2, which has no lookahead, no lookbehind
  and no backreferences. A pattern that uses one is skipped, with a warning naming it. Rewrite it
  without the unsupported construct, or use a glob.
- Chrome allows an extension 5000 dynamic rules, of which at most 1000 may use a regular
  expression. One include pattern is one rule, so this is generous in practice, but a profile built
  by machine can reach it.
- Chrome only accepts an `append` on a fixed list of request headers: `accept`, `accept-encoding`,
  `accept-language`, `access-control-request-headers`, `cache-control`, `connection`,
  `content-language`, `cookie`, `forwarded`, `if-match`, `if-none-match`, `keep-alive`, `range`,
  `te`, `trailer`, `transfer-encoding`, `upgrade`, `user-agent`, `via`, `want-digest` and
  `x-forwarded-for`. An append on any other request header is dropped with a warning; use **Set**
  instead. Response headers have no such restriction.
- An exclude pattern that cannot be used stops the whole profile rather than being ignored. Ignoring
  it would widen the profile past what you asked for, which is how a token reaches a host you
  deliberately excluded, so Nod Header fails closed and says which pattern to fix.
- Globs are matched by walking the URL, so any number of asterisks costs the same. A regular
  expression you write yourself is run by the browser's own engine: on Chrome that is RE2, which
  cannot backtrack, but on the Firefox fallback path a pathological expression can be slow. Nod
  Header refuses the common shape — a repeat wrapped around a repeat, such as `([a-z]+)+` — and
  names it, but a regular expression is a power tool and the remaining shapes are yours to own.
- Nod Header stores at most 50 profiles and 200 headers per profile.
- Response headers arrive after the browser has already decided some things, so changing, for
  example, a caching header does not retroactively change a response served from the cache.
- Firefox loads a temporary add-on for the session only, and clears its storage when it is removed.

## License

Apache 2.0. See [LICENSE](LICENSE).

Contributions are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) covers the build, the tests, the
constraints this project holds to, and the traps in the codebase worth knowing about before you
change it. Taking part means keeping to the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security
problem? [SECURITY.md](SECURITY.md) — please do not open a public issue.

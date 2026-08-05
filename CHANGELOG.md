# Changelog

All notable changes to Nod Header are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Importing a profile whose URL filter Nod Header cannot use no longer widens that profile to every
  URL. A ModHeader file scoped to one host, whose filter this extension refuses, used to import as a
  profile with an empty include list — which means *every* URL — so its headers, an `Authorization`
  value as often as not, would go to every site the browser visited. The unusable filter is now kept
  instead of discarded, which makes the profile send nothing until it is fixed, and the import report
  says so.
- A URL pattern that repeats a choice, such as `(a|a)+`, is now refused. Only a repeat around a group
  that ends in a repeat, `([a-z]+)+`, was caught before. Both cost exponential time to fail against a
  long URL, and the URL is whatever a page asked for, so any site could have stalled the extension —
  and, on the Firefox fallback engine, the requests waiting on its blocking listener.

### Added

- Both manifests now set an explicit content security policy for the extension's own pages, including
  `connect-src 'none'`, so the browser enforces what the code already did: no network connections and
  no script that did not ship in the package.

### Fixed

- The popup could open collapsed to about a third of its width, with the header row stacked as though
  it were on a phone, and stay that way. The phone layout was selected by viewport width, but Chrome
  sizes a popup from its content — so that layout, once applied, reported a width small enough to keep
  selecting itself. Both widths were self-consistent, and a single narrow first measurement, which one
  zoom step above 100% was enough to cause, latched it. The phone layout is now selected by the device
  having a coarse pointer, which a desktop never reports, and the panel is 740px rather than 780px so
  it is no longer within 20px of Chrome's 800px ceiling.
- Headers could keep applying from a profile revision one edit out of date. A state read that was
  still in flight when an edit was saved would finish afterwards and overwrite the newer state it
  found, so the rules the browser had were compiled from the older one — and stayed that way until
  the next edit, with nothing reporting it. Most likely just after the extension woke up, while the
  popup was still being typed in.

## [1.0.0] - 2026-08-05

First release.

### Added

- Request and response header rules with three operations: set, append and remove.
- Profiles. Only the active profile applies; the popup switches between them, and profiles can be
  created, renamed, duplicated and deleted.
- A master switch that suspends every rule without touching the profiles, reachable from the popup
  and from a keyboard shortcut.
- URL filters with three pattern kinds: bare hostnames including subdomains, globs, and regular
  expressions wrapped in slashes. Include and exclude lists, where exclude always wins.
- Resource-type filters covering every type declarativeNetRequest can match.
- Per-header overrides for URL patterns and resource types, which take precedence over the
  profile's.
- An option to limit a profile to the tab that was active when its rules were compiled.
- Import and export as JSON, for selected profiles, with settings included or left out.
- ModHeader import: profile titles, request and response headers, append mode, URL and exclude URL
  filters, and resource filters. Tab and tab-group filters are dropped with a warning.
- A matched-request log, capped and stored locally, with a setting to turn it off and a button to
  clear it.
- A popup with a drag-to-reorder header grid, bulk enable, disable, duplicate and delete, and inline
  warnings for header names the browser will not let an extension change.
- An options page for settings, the log and diagnostics.
- Light and dark themes, plus a setting to follow the system preference.
- Chrome and Edge builds using declarativeNetRequest dynamic and session rules.
- A Firefox build from the same source, with a blocking `webRequest` engine as the fallback when
  `modifyHeaders` is unavailable.
- A build with no dependencies: `npm run build`, `npm run build:chrome`, `npm run build:firefox`,
  `npm run icons`, and tests under `node --test`.

[Unreleased]: https://github.com/miador/nod-header/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/miador/nod-header/releases/tag/v1.0.0

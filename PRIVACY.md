# Privacy

Nod Header collects nothing.

There is no account, no sign-in, no telemetry, no analytics, no crash reporting and no remote code.
The extension makes no network requests of its own. Nothing you type into it is transmitted anywhere,
and no third party receives anything about you or about your browsing.

## What is stored, and where

Everything Nod Header knows is kept in the browser's `storage.local` on this device, under two keys:

- `state` — your profiles, the headers in them, their URL and resource-type filters, which profile is
  active, whether the master switch is on, and your settings.
- `log` — the matched-request log, described below.

`storage.local` is local to the browser profile. Nod Header does not use `storage.sync`, so nothing
is copied to a browser account or to another machine.

One more key lives in `storage.session`, which the browser clears when the session ends: a single
report of what the rule engine did on its last run, so the options page can still show the last
warnings after the background worker has been shut down and restarted. It holds counts, warning text
and the URL patterns those warnings name — no request data.

## The request log

Logging is off until you turn it on. When it is on, Nod Header records one entry per request that
one of your header rules matched, so you can confirm a rule fired. An entry holds the time, the full
URL of the request, its method and resource type, the tab it came from, and which of your headers
applied to it — including the values you configured for them.

Two things follow from that, and they are the reason logging is opt-in:

- **The values in an entry are your own header values.** If a rule sets `Authorization` or `Cookie`,
  the log holds that token in plain text, exactly as your profile already does. Nothing new leaves
  the device, but there is now a second copy, and **Copy** on the requests pane puts it on your
  clipboard.
- **A full URL can carry a secret in its query string.** Nod Header records the URL as the browser
  requested it and does not redact it, so a URL holding an access token is stored as it was.

The log holds nothing else about the request: no request or response bodies, no page content, no form
input, and none of the browser's cookies. Nod Header does not read the pages you visit — there is no
content script.

The log never leaves the browser on its own. It is written to local storage and read back by the
options page, and it goes further only when you press **Copy**.

The log is capped. It keeps 200 entries by default and at most 1000, and the oldest entries are
dropped as new ones arrive. **Clear log** removes every entry immediately.

## Clearing your data

- **Clear the log**: open the options page and use **Clear log**. It removes every entry immediately.
- **Stop logging**: turn logging off in the options page. Nothing further is recorded.
- **Remove everything**: uninstall the extension. The browser deletes its local storage with it. In
  Firefox, a temporary add-on and its storage are removed when the browser restarts.

Exporting a profile writes a file to wherever you tell your browser to save it. That file is yours;
Nod Header does not upload it or keep a copy.

## Permissions

Nod Header asks for host access to all sites because a header rule can name any URL.

On Chrome and Edge, and on every Firefox this extension supports, headers are changed by the
browser's own declarativeNetRequest engine, from rules compiled out of your profiles. The extension
hands the browser a rule and the browser does the rewriting, so it never sees the headers, bodies or
any other content of the requests and responses it changes. There, `webRequest` is used for one thing
only: noticing that a request matched, so the log can record it.

The Firefox build also asks for blocking `webRequest`, as a fallback for a browser that cannot modify
headers declaratively. That fallback is a real engine rather than an observer, so **while it is the
active engine, the extension does see each request's and response's header list** — that is how it
rewrites them. It reads and writes nothing else, stores nothing beyond what the log already records,
and sends nothing anywhere. The options page has an **About** pane that names which engine is live:
`Declarative rules` or `Blocking webRequest`.

See the permissions section of the [README](README.md#permissions).

## Changes

If this ever changes, it changes here and in [CHANGELOG.md](CHANGELOG.md), in the same release.

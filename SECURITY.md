# Security Policy

## Supported versions

This project is distributed as source and as a Chrome Web Store listing. Only the latest release / the
`main` branch is supported.

## Scope

Auto Refresh | Page Monitor runs entirely inside your browser. It has **no backend, no server, and no
credentials**, it **originates no network request of its own**, and it requests **no host permissions** — it
reloads tabs through `chrome.tabs.reload()` and injects no content script, so it cannot read or modify page
content. The realistic security surface is therefore the service-worker, popup, and options-page code in this
repository, and the blast radius of any issue is confined to your own browser profile.

The extension does store local data that can be sensitive — most notably statistics and an activity log
keyed by **full page URL**. What is kept, for how long, and how to clear it is documented in the
[Privacy Policy](https://kirilldevpro.github.io/auto-refresh-page-monitor/); that page is the single source
of truth for retention.

## Reporting a vulnerability

Please report privately rather than in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability
   reporting). This keeps the report visible only to the maintainer until a fix ships.
2. If private reporting is unavailable to you, open a regular issue that says only that you have found a
   security problem and asks for a private channel — **do not** include the details, a proof of concept, or
   any log excerpt in that issue.

Include the affected version or commit, reproduction steps, and the impact you believe it has.

**Redact before you attach anything.** Console output and the extension's own activity log contain full page
URLs, including private hostnames and query strings. Remove or replace them before sharing.

There is no bug bounty.

# Changelog

All notable changes to Auto Refresh | Page Monitor are documented here. This project follows
[semantic versioning](https://semver.org/).

## 2.8.1
- A new notification sound, created for this project.
- The privacy card in Settings is now precise about what stays on your device. It previously said that
  nothing it stores ever leaves your device; in fact your *preferences* live in Chrome's synced storage, so
  Chrome replicates them to your other signed-in browsers if you use Chrome Sync. The card now states what
  is actually local-only — your rules and statistics — and says "no telemetry" rather than "no analytics",
  since the extension does keep local statistics you can see on the Statistics tab.

## 2.8.0
- The popup now fits on screen without scrolling. The everyday controls — status, countdown, presets, custom
  interval, Start / Pause / Stop — sit on one surface, and everything else moved into two collapsible
  sections ("Advanced" for the interval range and the per-tab overrides, plus one for bulk actions).

## 2.7.0
- The URL whitelist and blacklist moved into the same tab as the scheduled refreshes, so every rule that
  decides *what* gets refreshed now lives in one place.
- Most settings on the General tab gained a hover/focus tooltip explaining what they do, and the page is
  grouped into cards instead of one long list.

## 2.6.0
- **Keyboard shortcuts** for starting/stopping and pausing/resuming the current tab, and for starting or
  stopping every tab in the window or in the current tab's group. Rebind them at
  `chrome://extensions/shortcuts`.
- **Bulk actions** in the popup: start or stop auto-refresh across a whole window or a whole tab group at
  once, with a cap on how many tabs a single bulk action will start.
- **Interval range** — instead of a fixed interval you can now give a minimum and a maximum, and each cycle
  picks a fresh value inside that band.

## 2.5.0
- Newly added scheduled refreshes appear at the top of the list instead of the bottom.
- Adding a rule whose URL pattern overlaps an existing one is now rejected, and the message names the rule it
  conflicts with. Entries that are not valid URL patterns are rejected too, instead of silently never
  matching.

## 2.4.1
- A tab whose interval ends exactly at midnight now reloads promptly instead of waiting out the next cycle.
- After an auto-recover reload the tab's normal refresh timer is restored if it was consumed while the
  recovery was in progress.

## 2.4.0
- The scheduled-refresh limit was raised to 300 rules.
- Fixed layout breakage on the settings page in languages whose translations run much longer than English.

## 2.3.1
- Smart pause now skips a refresh only for the tab you are actually looking at. Previously an active user
  could postpone refreshes on background tabs as well.

## 2.3.0
- **Right-click controls**: pick an interval, pause, resume, or stop auto-refresh for the current tab
  straight from the context menu.
- Tabs waiting on an auto-recover backoff now reload immediately when the network comes back, instead of
  sitting out the remaining delay.
- Smart pause is now on by default for everyone.

## 2.2.0
- **Smart pause** (opt-in): while you are actively using the tab you are viewing, its scheduled reload is
  skipped so the page never reloads out from under you. Background tabs keep refreshing.

## 2.1.0
- **Auto-recover** (opt-in): when a page fails to load or hangs, the tab is reloaded again on a backoff
  schedule (30 s, 1 m, 2 m, 5 m, 10 m, then every 30 m) until it succeeds. Enabling it asks for the optional
  `webNavigation` permission at that moment; it is not requested at install.

## 2.0.2
- The rate card on the settings page gained a short "how to leave a review" walkthrough.

## 2.0.1
- Timers, the badge countdown, and statistics now heal themselves after a browser update, sleep, or wake.
  Previously a suspended service worker could leave a tab showing an active timer that never fired again.
- A scheduled refresh no longer keeps reloading a page the tab has navigated away from, including on
  single-page-app navigations that fire no page-load event.

## 2.0.0
- A **light / dark / auto** theme; "auto" follows the operating system.
- A permanent hint under the custom-interval field stating the 30-second minimum, so an interval that Chrome
  would silently clamp can no longer be entered by mistake.
- A card linking to the Chrome Web Store listing for anyone who wants to leave a review.

## 1.x
Earlier releases, up to 1.6.0: the core per-tab auto-refresh with presets and custom intervals, URL-pattern
scheduled refreshes, whitelist and blacklist, statistics and the activity log, settings profile export and
import, the notification sound, the 27-language interface, the Material Design 3 redesign, hybrid
sync/local settings storage, the 30-second interval floor, per-tab and per-rule cache mode, and opt-in
interval jitter.

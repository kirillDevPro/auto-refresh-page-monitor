// startInterval.js — resolves which interval a NON-INTERACTIVE start path should use, and records
// the last sanitized interval used to start a tab. Leaf module: touches chrome.* only inside functions
// (like activityGuard.js), so it is unit-testable with a small storage mock.
//
// Why this exists. The popup always knows the interval the user just picked, but a keyboard shortcut
// or a bulk action has no UI to read: stopRefreshForTab() resets a tab to `interval: null`, and
// sanitizeInterval(undefined) returns null -> 'Invalid interval'. Without a fallback ladder a
// shortcut on a never-started or previously-stopped tab would silently do nothing.
//
// Storage tier. `lastUsedInterval` is a standalone top-level chrome.storage.local key and belongs to
// NEITHER SYNC_KEYS NOR LOCAL_KEYS, on purpose:
//   - background.js wires setupGlobalSettingsListener(reapplyScheduledRefreshesDebounced), which
//     fires on ANY write to sync.globalSettings / local.globalLists. This key is written on every
//     start, so putting it in either group would trigger a full scheduled-refresh re-apply sweep
//     across all tabs for a value the scheduler never reads.
//   - sync is write-rate quota'd and globalSettings is one ~8KB item rewritten whole on every set;
//     a bulk start would multiply that. A "last used interval" syncing across devices is also a
//     surprise, not a feature — device A's preset click should not change device B's shortcut.
//   - It matches the existing partition: sync.globalSettings holds user-authored prefs that have a
//     UI control, while machine-written per-use state lives as top-level local keys (tab_{id},
//     tab_{id}_lastArmed, activityLogs, statistics).
//
// No migration is needed: an absent key naturally falls through to DEFAULT_START_INTERVAL_SECONDS.

import { DEFAULT_START_INTERVAL_SECONDS } from './constants.js';
import { getTabState } from './state.js';

/** Top-level chrome.storage.local key holding the last sanitized start interval, in seconds. */
const LAST_USED_INTERVAL_KEY = 'lastUsedInterval';

/**
 * Write-dedup fast path for recordLastUsedInterval.
 *
 * MV3-safe: this is never READ as a source of truth. It only suppresses a redundant storage write
 * (a bulk start hitting N tabs with one interval). A service-worker suspension resets it to null,
 * which merely costs one extra write — resolveStartInterval always reads storage, so no cross-event
 * state is relied on.
 * @type {number|null}
 */
let cachedLastUsedInterval = null;

/**
 * Resolve the interval a non-interactive start should use, walking a three-rung ladder:
 *   1. the tab's own current interval (a paused/re-started tab keeps what it had);
 *   2. the last sanitized interval submitted to a start;
 *   3. DEFAULT_START_INTERVAL_SECONDS (fresh profile, no timer ever started).
 *
 * Every rung is best-effort: a storage or tab-state failure falls through rather than throwing, so a
 * shortcut never dies on a transient read error. The result is NOT pre-clamped — callers hand it to
 * startRefreshForTab, whose sanitizeInterval owns clamping. Do not bypass that.
 *
 * @param {number|null} tabId - Target tab id, or null for a window/group-scoped action that must
 *   resolve ONE interval for the whole batch (per-tab resolution would give each tab a different
 *   interval, which is incoherent for a single bulk action).
 * @returns {Promise<number>} Interval in seconds; always a positive finite number.
 */
export async function resolveStartInterval(tabId) {
    if (Number.isInteger(tabId) && tabId > 0) {
        try {
            const tabSettings = await getTabState(tabId);
            const own = Number(tabSettings && tabSettings.interval);
            if (Number.isFinite(own) && own > 0) return own;
        } catch (error) {
            console.warn('startInterval: tab state unreadable, falling back', error);
        }
    }
    try {
        const stored = await chrome.storage.local.get(LAST_USED_INTERVAL_KEY);
        const last = Number(stored && stored[LAST_USED_INTERVAL_KEY]);
        if (Number.isFinite(last) && last > 0) return last;
    } catch (error) {
        console.warn('startInterval: lastUsedInterval unreadable, using the default', error);
    }
    return DEFAULT_START_INTERVAL_SECONDS;
}

/**
 * Record a sanitized start interval as the fallback for future shortcut and bulk starts.
 *
 * Fire-and-forget by design: the value is advisory, so a failed write must never fail the start that
 * triggered it. Called from startRefreshForTab, the chokepoint used by interactive and
 * non-interactive start paths.
 *
 * @param {number} interval - Interval in seconds, already sanitized by the caller.
 * @returns {void}
 */
export function recordLastUsedInterval(interval) {
    if (!Number.isFinite(interval) || interval <= 0) return;
    if (cachedLastUsedInterval === interval) return;
    // Set the cache BEFORE awaiting so concurrent bulk calls dedup against it rather than racing.
    cachedLastUsedInterval = interval;
    chrome.storage.local.set({ [LAST_USED_INTERVAL_KEY]: interval }).catch((error) => {
        // Drop the cache so the next start retries instead of trusting a write that never landed.
        cachedLastUsedInterval = null;
        console.warn('startInterval: failed to persist lastUsedInterval', error);
    });
}

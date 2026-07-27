/**
 * Provides opt-in auto-recovery for monitored tabs whose main-frame page load fails or hangs.
 *
 * Uses chrome.webNavigation, an optional permission requested at runtime from a user gesture when
 * the user enables recovery. When the permission is absent, this module leaves all other refresh
 * features untouched and no navigation listeners are registered.
 *
 * Detection is gated to main-frame http(s) URLs on active, unpaused tabs whose recoverMode resolves
 * on. Recoverable onErrorOccurred failures schedule a backed-off reload, onCommitted writes the
 * stuck-load marker, and onCompleted resets the marker, retry record, and pending recovery alarm.
 *
 * Reload state is persisted per tab in chrome.storage.local and uses one-shot recover_tab_<id> alarms
 * following a fixed backoff schedule (RECOVERY_BACKOFF_SCHEDULE_SECONDS, jittered) that never gives up:
 * after the schedule is exhausted it keeps retrying at the last step (every 30 min) until a load succeeds.
 *
 * On a network reconnect, pending recoveries are fast-forwarded (accelerateRecoveriesOnReconnect) so a
 * tab that failed while offline reloads as soon as connectivity returns rather than waiting out the
 * remaining backoff - driven by a top-level 'online' listener (worker alive) and checkReconnect() on the
 * keepalive tick using a persisted online baseline, covering the suspended/terminated worker (since
 * 'online' does not wake a dormant MV3 service worker).
 */
import { getTabState, updateTabStorageAndState } from './state.js';
import { resolveRecoverMode, isGlobalSettingsLoaded, loadGlobalSettings } from './settings.js';
import { isRefreshableUrl } from './scheduler.js';
import { scheduleAlarm, scheduleTabRefresh } from './alarmUtils.js';
import { tryAcquireTab, releaseTab } from './inFlightTabs.js';
import { applyJitter } from './jitter.js';
import { updateIcon, isTabClosed, markTabAsClosed } from './iconController.js';
import { isTabNotFoundError } from './actionUtils.js';
import {
    RECOVER_ALARM_PREFIX,
    recoverAlarmName,
    tabAlarmName,
    clampInterval,
    RECOVERY_BACKOFF_SCHEDULE_SECONDS,
    RECOVERY_BACKOFF_JITTER_PERCENT,
    STUCK_LOAD_TIMEOUT_SECONDS
} from './constants.js';

// Injected activity-log writer, set by initializeNavigationRecovery.
let logActivityFunc;
// Prevents duplicate webNavigation listeners across startup and runtime permission grants.
let webNavListenersRegistered = false;
// Re-entrancy guard for overlapping keepalive stuck-load sweeps.
let stuckCheckInProgress = false;
// Re-entrancy guard for overlapping reconnect-acceleration sweeps.
let reconnectInProgress = false;
// chrome.storage.local key holding the last observed navigator.onLine value (boolean). Persisted (not
// in-memory) so an offline->online transition is still detected after the MV3 service worker was fully
// torn down between keepalive ticks (the common case), not only while it stayed alive.
const LAST_ONLINE_KEY = 'pau_last_online';

// net::ERR_* values that must NOT trigger a reload (a reload would fight the user or loop forever).
// ERR_BLOCKED_* and ERR_CERT_* are matched by prefix in isRecoverableError, not listed here.
const NON_RETRYABLE_ERRORS = new Set([
    'net::ERR_ABORTED',                       // user cancelled or a new navigation superseded this one
    'net::ERR_CACHE_MISS',                    // benign back/forward POST re-submit prompt
    'net::ERR_UNSAFE_REDIRECT',               // structural, will not self-heal
    'net::ERR_INVALID_REDIRECT',              // structural
    'net::ERR_TOO_MANY_REDIRECTS',            // reloading just repeats the loop
    'net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH' // server misconfig, not transient
]);

/**
 * Storage key for a tab's recovery retry record ({count, nextAt?}).
 * @param {number} tabId
 * @returns {string}
 */
function recoveryRecordKey(tabId) {
    return `tab_${tabId}_recovery`;
}

/**
 * Storage key for a tab's "main-frame load started" timestamp (the stuck-load marker).
 * @param {number} tabId
 * @returns {string}
 */
function loadStartedKey(tabId) {
    return `tab_${tabId}_loadStartedAt`;
}

/**
 * Decide whether a webNavigation.onErrorOccurred error warrants an auto-reload.
 * Defaults to TRUE for genuine network errors (so new net::ERR_* codes are handled), excluding the
 * explicit non-retryable set and the ERR_BLOCKED and ERR_CERT families (interstitials/blocks a reload
 * cannot clear).
 * @param {string} error - the details.error string (e.g. 'net::ERR_NAME_NOT_RESOLVED')
 * @returns {boolean}
 */
function isRecoverableError(error) {
    if (typeof error !== 'string' || !error.startsWith('net::')) return false;
    if (NON_RETRYABLE_ERRORS.has(error)) return false;
    if (error.startsWith('net::ERR_CERT')) return false;
    if (error.startsWith('net::ERR_BLOCKED')) return false;
    return true;
}

/**
 * Read a tab's recovery retry record, defaulting to {count: 0} when absent or on error.
 * @param {number} tabId
 * @returns {Promise<{count: number, nextAt?: number}>}
 */
async function getRecoveryRecord(tabId) {
    try {
        const key = recoveryRecordKey(tabId);
        const stored = await chrome.storage.local.get(key);
        return stored[key] || { count: 0 };
    } catch (e) {
        return { count: 0 };
    }
}

/**
 * Persist a tab's recovery retry record (best-effort).
 * @param {number} tabId
 * @param {{count: number, nextAt?: number}} record
 * @returns {Promise<void>}
 */
async function setRecoveryRecord(tabId, record) {
    try {
        await chrome.storage.local.set({ [recoveryRecordKey(tabId)]: record });
    } catch (e) {
        // Best-effort persistence; the next navigation event can recreate the record.
    }
}

/**
 * Clear a tab's stuck-load marker (best-effort). The recovery retry record is left intact.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function clearLoadMarker(tabId) {
    try {
        await chrome.storage.local.remove(loadStartedKey(tabId));
    } catch (e) {
        // Best-effort cleanup; stale markers are guarded by fresh tab state checks.
    }
}

/**
 * Reset all recovery state for a tab after a SUCCESSFUL load: clear the pending recovery alarm, the
 * retry record and the stuck marker, so a future failure starts the backoff schedule fresh. Exported as
 * the per-tab teardown is otherwise handled inline by alarmUtils.clearTabAlarms (stop/close/deactivate).
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function resetRecovery(tabId) {
    try {
        await chrome.alarms.clear(recoverAlarmName(tabId));
    } catch (e) {
        // Best-effort alarm cleanup; storage cleanup below is the durable reset.
    }
    try {
        await chrome.storage.local.remove([recoveryRecordKey(tabId), loadStartedKey(tabId)]);
    } catch (e) {
        // Best-effort storage cleanup; callers re-check state before any later reload.
    }
}

/**
 * Record a failed/stuck load for a tab and arm a one-shot recovery alarm at the next backoff delay.
 * De-duped against an already-pending recovery alarm so a burst of error events for the same outage
 * counts once. Recovery NEVER gives up: it walks RECOVERY_BACKOFF_SCHEDULE_SECONDS and then keeps
 * retrying at the last step (every 30 min) until a successful load resets the record.
 * @param {number} tabId
 * @param {string} url - the URL whose load failed (for the activity log)
 * @param {string} reason - the net::ERR_* code or 'stuck-load'
 * @returns {Promise<void>}
 */
async function registerFailure(tabId, url, reason) {
    // De-dupe: a recovery reload is already scheduled, so this failure belongs to the same outage burst.
    // Durable across SW suspension (unlike an in-memory guard), since the alarm lives in chrome.alarms.
    if (await chrome.alarms.get(recoverAlarmName(tabId))) return;

    const record = await getRecoveryRecord(tabId);

    // The failing load has resolved into an error; drop its stuck marker (the recovery reload's own
    // onCommitted sets a fresh one).
    await clearLoadMarker(tabId);

    const prevCount = record.count || 0;
    const attempt = prevCount + 1;
    // Index into the schedule, clamped at the last step so once it is exhausted recovery keeps retrying
    // at the final delay (every 30 min) instead of giving up.
    const idx = Math.min(prevCount, RECOVERY_BACKOFF_SCHEDULE_SECONDS.length - 1);
    const delaySeconds = applyJitter(RECOVERY_BACKOFF_SCHEDULE_SECONDS[idx], RECOVERY_BACKOFF_JITTER_PERCENT);
    // Stored count clamps at the schedule length so the integer stops growing on the 30-min plateau
    // (it is only ever used as the clamped schedule index above).
    const nextCount = Math.min(attempt, RECOVERY_BACKOFF_SCHEDULE_SECONDS.length);
    await setRecoveryRecord(tabId, { count: nextCount, nextAt: Date.now() + delaySeconds * 1000 });
    await scheduleAlarm(recoverAlarmName(tabId), delaySeconds, { initialDelaySeconds: delaySeconds, oneShot: true });
    if (logActivityFunc) {
        logActivityFunc(tabId, `Auto-recovery: load failed (${reason}); reload attempt ${attempt} in ~${Math.round(delaySeconds)}s: ${url}`);
    }
}

/**
 * Restore the tab's NORMAL refresh alarm if it went missing while this recovery reload held the shared
 * per-tab in-flight lock. A normal one-shot refresh alarm (interval < 60s, or any jittered interval) that
 * fires during a recovery reload is consumed by Chrome, but handleAlarm returns at its tryAcquireTab guard
 * without re-arming (the lock is held by this recovery), so the refresh timer would otherwise stay lost
 * until the slower orphan-watchdog grace plus the next keepalive tick. Called while we
 * still hold the lock, so a missing refresh alarm here cannot be a transient handleAlarm fire->re-arm gap
 * (that needs the lock) - it is a genuinely lost timer. Mirrors the orphan watchdog's re-arm (same active /
 * unpaused / interval / lastArmed-stamp guards) but WITHOUT its grace wait, since under the lock there is no
 * normal fire->re-arm window to mistake for an orphan. A still-present alarm (periodic, or a one-shot that
 * did not fire) is left untouched, so a recovery reload does not otherwise reset the refresh schedule.
 *
 * Re-validates tab state AFTER arming and writes the fresh snapshot (never the pre-await one), because a
 * stop/pause/deactivation does not take the inflight lock and could land mid-function - writing a stale
 * active snapshot would resurrect a stopped tab (the same double-check finalizeAfterFire uses). Best-effort:
 * it swallows its own errors so a failure cannot propagate into the recovery reload's failure-cleanup path.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function restoreRefreshAlarmIfConsumed(tabId) {
    try {
        let settings = await getTabState(tabId);
        if (!settings || !settings.isActive || settings.isPaused || !settings.interval) return;
        // The refresh alarm is still scheduled (periodic, or a one-shot that did not fire) - nothing was lost.
        if (await chrome.alarms.get(tabAlarmName(tabId))) return;
        // No arming stamp => not our orphan: a stopped/closed tab (clearTabAlarms removed the stamp) or a legacy
        // tab. Re-arming without a stamp would resurrect a stopped timer - skip, exactly as the orphan watchdog does.
        const stored = await chrome.storage.local.get(`tab_${tabId}_lastArmed`);
        if (!stored[`tab_${tabId}_lastArmed`]) return;
        const interval = clampInterval(settings.interval);
        // Re-read right before arming: a stop/pause/deactivation (none take the inflight lock) may have landed
        // during the awaits above; do not arm a just-stopped tab.
        settings = await getTabState(tabId);
        if (!settings || !settings.isActive || settings.isPaused || !settings.interval) return;
        await scheduleTabRefresh(tabAlarmName(tabId), interval, settings.jitterMode, { jitterPercent: settings.jitterPercent });
        // Re-read once more and persist the FRESH state, never the pre-await snapshot: if a stop/pause landed
        // during arming, do NOT write an active snapshot over it (that resurrects a stopped tab). The just-armed
        // alarm is then harmless - handleAlarm's next fire sees isActive=false and clears it without reloading
        // (the same guard finalizeAfterFire uses). This also covers a tabLifecycle scheduled-drift deactivation.
        const recheck = await getTabState(tabId);
        if (!recheck || !recheck.isActive || recheck.isPaused || !recheck.interval) return;
        recheck.interval = interval;
        await updateTabStorageAndState(tabId, recheck);
        if (logActivityFunc) {
            logActivityFunc(tabId, `Restored normal refresh timer consumed during auto-recovery (${interval}s)`);
        }
    } catch (e) {
        // Best-effort: this runs AFTER the recovery reload already succeeded, so a failure here must NOT
        // propagate into doRecoveryReloadImpl's reload-failure catch (which would wrongly flip isAutoRefresh
        // and resetRecovery). The orphan watchdog remains the ultimate backstop for a lost refresh timer.
        console.warn(`restoreRefreshAlarmIfConsumed failed for tab ${tabId}:`, e.message);
    }
}

/**
 * Perform a recovery reload of a tab, serialized through the shared per-tab in-flight lock so it cannot
 * race a normal refresh fire (alarmHandler) or another recovery path (alarm delivery, the stuck-load
 * sweep, reconnect acceleration). If another reload for this tab is already running, this is a no-op:
 * the recovery record persists and the watchdog / a fresh onErrorOccurred will retry. The actual work is
 * in doRecoveryReloadImpl.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function doRecoveryReload(tabId) {
    if (isTabClosed(tabId)) return;
    if (!tryAcquireTab(tabId)) return;
    try {
        await doRecoveryReloadImpl(tabId);
    } finally {
        releaseTab(tabId);
    }
}

/**
 * Inner recovery reload, run while holding the per-tab in-flight lock (see doRecoveryReload). Re-validates
 * that the tab is still a monitored, recovery-enabled, refreshable tab (recovery may have been turned off,
 * or the tab stopped/paused, during the backoff wait), then hard-reloads it. Sets isAutoRefresh first so
 * tabLifecycle's 'complete' handler does not reset the normal refresh timer.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function doRecoveryReloadImpl(tabId) {
    // If the optional webNavigation permission was revoked while this recovery was pending (the
    // namespace goes undefined on revoke), the feature is off - honor the opt-in boundary: do NOT
    // reload, and clear the leftover record/alarm so a stale recovery can't fire after revocation.
    if (!chrome.webNavigation) {
        await resetRecovery(tabId);
        return;
    }

    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    } catch (e) {
        if (isTabNotFoundError(e)) markTabAsClosed(tabId);
        return;
    }
    if (!tab || !isRefreshableUrl(tab.url)) {
        // Tab exists but is no longer refreshable; abandon the attempt and clear the retry record so
        // the schedule-time count increment is not spent without a reload (see the reset rationale below).
        await resetRecovery(tabId);
        return;
    }

    if (!isGlobalSettingsLoaded()) await loadGlobalSettings();

    // Mark the recovery reload as "in flight" by moving nextAt to an OUTCOME DEADLINE (current time + stuck
    // timeout) instead of clearing it. The keepalive orphan-recovery sweep won't re-fire before the
    // deadline (so it can't pile on while we await this reload's onCompleted/onErrorOccurred), yet if the
    // worker is killed right after the reload and no outcome event ever arrives, the persisted deadline
    // lets the watchdog re-issue the recovery - honoring the never-give-up contract. (Clearing nextAt
    // here would instead strand the record at {count>0, no nextAt, no alarm}, invisible to the watchdog.)
    const record = await getRecoveryRecord(tabId);
    if ((record.count || 0) > 0) {
        record.nextAt = Date.now() + STUCK_LOAD_TIMEOUT_SECONDS * 1000;
        await setRecoveryRecord(tabId, record);
    }

    // Re-read fresh state immediately before acting: a stop/pause/recoverMode-off message can land
    // during the awaits above. Acting on a stale snapshot would resurrect a stopped tab (writing
    // isActive=true over the stop) or reload a paused/stopped tab.
    const settings = await getTabState(tabId);
    if (!settings || !settings.isActive || settings.isPaused || !resolveRecoverMode(settings.recoverMode)) {
        // Recovery can no longer run for this tab (stopped / paused / turned off). Wipe the retry
        // record so the schedule-time count increment is not spent without a real reload - otherwise an
        // aborted attempt would advance the backoff step (and leave a dangling record with no alarm)
        // without ever having reloaded.
        await resetRecovery(tabId);
        return;
    }

    try {
        // Mark as auto-refresh so the subsequent 'complete' in tabLifecycle clears the flag instead of
        // resetting the user's normal refresh countdown (the recovery reload is extension-initiated).
        settings.isAutoRefresh = true;
        await updateTabStorageAndState(tabId, settings);
        // Hard reload (bypassCache): the previous attempt failed or partially loaded, so refetch fresh
        // rather than trust a cached/broken copy, independent of the tab's refreshMode.
        await chrome.tabs.reload(tabId, { bypassCache: true });
        // Restore the tab's NORMAL refresh timer if its one-shot alarm fired (and Chrome consumed it)
        // while this recovery reload held the shared per-tab lock; otherwise it stays lost until the
        // slower orphan-watchdog grace. No-op when the refresh alarm is still scheduled.
        await restoreRefreshAlarmIfConsumed(tabId);
        await updateIcon(tabId, 'updated', settings.interval);
        // Revert the icon shortly after, unless the tab closed meanwhile (swallow API errors).
        setTimeout(() => {
            if (isTabClosed(tabId)) return;
            updateIcon(tabId, 'active', settings.interval).catch(() => {});
        }, 2000);
        if (logActivityFunc) logActivityFunc(tabId, `Auto-recovery: reloaded after failed load: ${tab.url}`);
    } catch (e) {
        settings.isAutoRefresh = false;
        await updateTabStorageAndState(tabId, settings);
        // The reload call itself threw, typically because the tab closed mid-flight. nextAt was set to a
        // future deadline above, but no real reload was actually issued - wiping the record (resetRecovery)
        // gives a clean abandon and stops the orphan watchdog from re-firing on a throw-aborted dispatch.
        // A genuinely-failed load will re-trigger via a fresh onErrorOccurred from a future navigation.
        await resetRecovery(tabId);
        if (logActivityFunc) logActivityFunc(tabId, `Auto-recovery reload failed: ${tab.url} (${e.message})`);
    }
}

/**
 * Handle a fired recovery alarm (recover_tab_<id>), routed here by alarmHandler's onAlarm dispatcher.
 * Parses the tab id and performs the recovery reload. The retry counter was already incremented when
 * the alarm was scheduled, so this only reloads; success/failure of the reload drives the next step
 * via onCompleted/onErrorOccurred.
 * @param {chrome.alarms.Alarm} alarm
 * @returns {Promise<void>}
 */
export async function handleRecoveryAlarm(alarm) {
    try {
        if (!alarm || typeof alarm.name !== 'string' || !alarm.name.startsWith(RECOVER_ALARM_PREFIX)) return;
        const tabId = parseInt(alarm.name.slice(RECOVER_ALARM_PREFIX.length), 10);
        if (!Number.isInteger(tabId) || tabId <= 0) return;
        await doRecoveryReload(tabId);
    } catch (e) {
        console.error('handleRecoveryAlarm error:', e);
    }
}

/**
 * webNavigation.onCommitted handler that records the start of a main-frame load for a monitored,
 * recovery-enabled tab so the stuck-load sweep can detect a load that never completes/errors.
 * @param {chrome.webNavigation.WebNavigationFramedCallbackDetails} details
 * @returns {Promise<void>}
 */
async function handleCommitted(details) {
    try {
        if (details.frameId !== 0 || !isRefreshableUrl(details.url)) return;
        if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
        const settings = await getTabState(details.tabId);
        if (!settings || !settings.isActive || settings.isPaused) return;
        if (!resolveRecoverMode(settings.recoverMode)) return;
        await chrome.storage.local.set({ [loadStartedKey(details.tabId)]: Date.now() });
    } catch (e) {
        // Navigation event handlers must never throw.
    }
}

/**
 * webNavigation.onCompleted handler. A successful main-frame load is the reset signal: clear the
 * stuck marker, retry counter and any pending recovery alarm so the next failure starts fresh.
 * @param {chrome.webNavigation.WebNavigationFramedCallbackDetails} details
 * @returns {Promise<void>}
 */
async function handleCompleted(details) {
    try {
        if (details.frameId !== 0 || !isRefreshableUrl(details.url)) return;
        const settings = await getTabState(details.tabId);
        if (!settings || !settings.isActive) return; // Only monitored tabs hold recovery state.
        await resetRecovery(details.tabId);
    } catch (e) {
        // Navigation event handlers must never throw.
    }
}

/**
 * webNavigation.onErrorOccurred handler. Acts only on a recoverable main-frame
 * network error for a monitored, recovery-enabled tab; schedules a backed-off reload (never-give-up schedule).
 * @param {chrome.webNavigation.WebNavigationFramedErrorCallbackDetails} details
 * @returns {Promise<void>}
 */
async function handleErrorOccurred(details) {
    try {
        if (details.frameId !== 0 || !isRefreshableUrl(details.url)) return;
        if (!isRecoverableError(details.error)) return;
        if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
        const settings = await getTabState(details.tabId);
        if (!settings || !settings.isActive || settings.isPaused) return;
        if (!resolveRecoverMode(settings.recoverMode)) return;
        await registerFailure(details.tabId, details.url, details.error);
    } catch (e) {
        console.error('handleErrorOccurred error:', e);
    }
}

/**
 * Keepalive-tick sweep (routed from alarmHandler), doing two jobs for monitored, recovery-enabled,
 * active/unpaused tabs:
 *   1. Orphan-recovery watchdog: if a recovery is in progress (record.count > 0) whose backoff time
 *      (record.nextAt) has passed but no recover_tab_<id> alarm exists, the
 *      one-shot alarm was lost, most likely because the MV3 service worker was killed between the alarm
 *      firing and the reload, so re-issue the reload. This is what makes the persisted nextAt load-bearing
 *      and prevents a failed tab from staying broken forever after a worker restart.
 *   2. Fresh stuck-load detection: a tab with NO recovery yet (count 0) whose main-frame load committed
 *      but never completed/errored within STUCK_LOAD_TIMEOUT_SECONDS is treated as hung and recovered.
 * A tab with a recovery already underway (count > 0) is never given a fresh stuck attempt; the
 * onCompleted/onErrorOccurred events drive its remaining attempts, so the sweep can't pile a second
 * recovery onto a reload that is still loading. No-op when the webNavigation permission is absent.
 * @returns {Promise<void>}
 */
export async function checkStuckLoads() {
    if (!chrome.webNavigation) return;
    if (stuckCheckInProgress) return;
    stuckCheckInProgress = true;
    try {
        if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
        const tabs = await chrome.tabs.query({});
        const now = Date.now();
        const timeoutMs = STUCK_LOAD_TIMEOUT_SECONDS * 1000;
        for (const tab of tabs) {
            if (!tab || !Number.isInteger(tab.id) || tab.id <= 0) continue;
            if (!isRefreshableUrl(tab.url)) continue;
            const settings = await getTabState(tab.id);
            if (!settings || !settings.isActive || settings.isPaused) continue;
            if (!resolveRecoverMode(settings.recoverMode)) continue;

            const record = await getRecoveryRecord(tab.id);
            if ((record.count || 0) > 0) {
                // Recovery already underway. Re-issue a recovery reload whose one-shot alarm was lost to
                // a worker restart (nextAt passed, no alarm); otherwise leave it to the webNavigation
                // events and do not start a fresh stuck attempt on this tab.
                if (record.nextAt && record.nextAt <= now &&
                    !(await chrome.alarms.get(recoverAlarmName(tab.id)))) {
                    if (logActivityFunc) {
                        logActivityFunc(tab.id, `Auto-recovery: re-issuing a recovery reload lost to a worker restart: ${tab.url}`);
                    }
                    await doRecoveryReload(tab.id);
                }
                continue;
            }

            let startedAt = 0;
            try {
                const key = loadStartedKey(tab.id);
                const stored = await chrome.storage.local.get(key);
                startedAt = stored[key] || 0;
            } catch (e) {
                continue;
            }
            if (!startedAt || (now - startedAt) < timeoutMs) continue;

            if (logActivityFunc) {
                logActivityFunc(tab.id, `Auto-recovery: load appears stuck (>${STUCK_LOAD_TIMEOUT_SECONDS}s): ${tab.url}`);
            }
            await registerFailure(tab.id, tab.url, 'stuck-load');
        }
    } catch (e) {
        console.error('checkStuckLoads error:', e);
    } finally {
        stuckCheckInProgress = false;
    }
}

/**
 * Fast-forward every monitored tab with a pending recovery so it retries IMMEDIATELY instead of
 * waiting out the remaining backoff delay - invoked when the browser comes back online. Walks live
 * tabs like checkStuckLoads and, for a refreshable, active, unpaused, recovery-enabled tab whose
 * retry record is already underway (count > 0), accelerates it unless a reload is currently in flight:
 *   - alarm pending  -> waiting out its backoff: clear the one-shot alarm and reload immediately (the main case);
 *   - no alarm, nextAt PASSED -> overdue/lost: reload immediately (also covered by the keepalive watchdog);
 *   - no alarm, nextAt FUTURE -> reload in flight: skip (mirrors checkStuckLoads, avoids a double reload).
 * No-op without the webNavigation permission (recovery is off). doRecoveryReload re-validates state and
 * moves nextAt to the in-flight deadline, so a concurrent keepalive sweep won't pile on.
 * @returns {Promise<void>}
 */
export async function accelerateRecoveriesOnReconnect() {
    if (!chrome.webNavigation) return;
    if (reconnectInProgress) return;
    reconnectInProgress = true;
    try {
        if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
        const tabs = await chrome.tabs.query({});
        const now = Date.now();
        for (const tab of tabs) {
            if (!tab || !Number.isInteger(tab.id) || tab.id <= 0) continue;
            if (!isRefreshableUrl(tab.url)) continue;
            const settings = await getTabState(tab.id);
            if (!settings || !settings.isActive || settings.isPaused) continue;
            if (!resolveRecoverMode(settings.recoverMode)) continue;

            const record = await getRecoveryRecord(tab.id);
            if ((record.count || 0) <= 0) continue; // No recovery underway for this tab.

            const pendingAlarm = await chrome.alarms.get(recoverAlarmName(tab.id));
            // A recovery reload in flight (no alarm, future deadline) must not be reloaded again on top
            // of one still loading; mirror the checkStuckLoads guard and skip it.
            if (!pendingAlarm && record.nextAt && record.nextAt > now) continue;
            // Otherwise it is waiting out its backoff (alarm pending) or overdue/lost: retry immediately. Drop the
            // pending one-shot first so its original backoff fire can't double with the reload below.
            if (pendingAlarm) {
                try { await chrome.alarms.clear(recoverAlarmName(tab.id)); } catch (e) { /* best-effort */ }
            }
            if (logActivityFunc) {
                logActivityFunc(tab.id, `Auto-recovery: network reconnected, retrying now instead of waiting: ${tab.url}`);
            }
            await doRecoveryReload(tab.id);
        }
    } catch (e) {
        console.error('accelerateRecoveriesOnReconnect error:', e);
    } finally {
        reconnectInProgress = false;
    }
}

/**
 * Keepalive-tick reconnect detector (routed from alarmHandler). Compares navigator.onLine against the
 * last observed value PERSISTED in chrome.storage.local and, on an offline->online transition, fast-forwards
 * pending recoveries. This is the suspended/terminated-worker counterpart to the top-level 'online' listener
 * (which fires only while the worker is alive): because the baseline is persisted, the transition is still
 * detected after the MV3 worker was fully torn down between ticks. An absent baseline (first ever tick /
 * cleared storage) is treated as "not offline", so a cold start never counts as a reconnect. No-op without
 * the webNavigation permission.
 * @returns {Promise<void>}
 */
export async function checkReconnect() {
    if (!chrome.webNavigation) return;
    let online = true;
    try {
        online = (typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true;
    } catch (e) {
        online = true; // Assume online if the API is unavailable; never block recovery on a probe error.
    }
    let prev;
    try {
        const stored = await chrome.storage.local.get(LAST_ONLINE_KEY);
        prev = stored[LAST_ONLINE_KEY];
    } catch (e) {
        prev = undefined;
    }
    // Persist the current state first so the NEXT tick has an accurate baseline even across a worker
    // teardown. prev===undefined (first tick / cleared storage) is "not offline", so a cold start is
    // never mistaken for a reconnect.
    try {
        await chrome.storage.local.set({ [LAST_ONLINE_KEY]: online });
    } catch (e) {
        // best-effort persistence; the next tick re-reads and re-writes.
    }
    if (prev === false && online) {
        await accelerateRecoveriesOnReconnect();
    }
}

/**
 * Register the webNavigation listeners, but only if the optional permission is granted (the namespace
 * is undefined otherwise). Idempotent. Called synchronously at init (first turn of the SW event loop,
 * so a granted permission can wake a dormant SW) and again on a runtime grant.
 * @returns {void}
 */
function registerWebNavListeners() {
    if (webNavListenersRegistered || !chrome.webNavigation) return;
    chrome.webNavigation.onCommitted.addListener(handleCommitted);
    chrome.webNavigation.onCompleted.addListener(handleCompleted);
    chrome.webNavigation.onErrorOccurred.addListener(handleErrorOccurred);
    webNavListenersRegistered = true;
    console.log('navigationRecovery: webNavigation listeners registered');
}

/**
 * Remove the webNavigation listeners after the permission is revoked.
 * @returns {void}
 */
function unregisterWebNavListeners() {
    if (!webNavListenersRegistered) return;
    // ALWAYS reset the flag, even when chrome.webNavigation is already undefined (the namespace goes away
    // on revoke - the very state this runs in). Leaving the flag true would make a later re-grant's
    // registerWebNavListeners() early-return, silently keeping auto-recovery disabled after re-grant.
    // Only attempt removeListener while the namespace still exists (on revoke Chrome already drops them).
    if (chrome.webNavigation) {
        try {
            chrome.webNavigation.onCommitted.removeListener(handleCommitted);
            chrome.webNavigation.onCompleted.removeListener(handleCompleted);
            chrome.webNavigation.onErrorOccurred.removeListener(handleErrorOccurred);
        } catch (e) {
            // best-effort
        }
    }
    webNavListenersRegistered = false;
    console.log('navigationRecovery: webNavigation listeners removed (permission revoked)');
}

/**
 * Wire injected dependencies and register navigation/permission listeners. Must run synchronously in
 * the service worker's first event-loop turn (called from background.js alongside the other module
 * initializers) so that, when the webNavigation permission is already granted, its events can wake a
 * dormant SW. A runtime grant/revoke is handled via chrome.permissions.onAdded/onRemoved. Also
 * registers self online/offline listeners so a network reconnect fast-forwards pending recoveries.
 * @param {{logActivity: function(number|null, string):void}} dependencies
 * @returns {void}
 */
export function initializeNavigationRecovery(dependencies) {
    logActivityFunc = dependencies.logActivity;

    registerWebNavListeners();

    // Network reconnect: when the browser comes back online, fast-forward pending recoveries
    // instead of waiting out their backoff. These events fire only while the worker is alive; the
    // suspended-worker case is covered by checkReconnect() on the keepalive tick. Registered
    // unconditionally - accelerateRecoveriesOnReconnect no-ops without the webNavigation permission.
    self.addEventListener('online', () => {
        chrome.storage.local.set({ [LAST_ONLINE_KEY]: true }).catch(() => {});
        accelerateRecoveriesOnReconnect().catch(e => console.error('online handler error:', e));
    });
    self.addEventListener('offline', () => {
        // Persist offline so a later keepalive tick (even after a worker teardown) sees the transition.
        chrome.storage.local.set({ [LAST_ONLINE_KEY]: false }).catch(() => {});
    });

    if (chrome.permissions && chrome.permissions.onAdded) {
        chrome.permissions.onAdded.addListener((perms) => {
            if (perms && Array.isArray(perms.permissions) && perms.permissions.includes('webNavigation')) {
                registerWebNavListeners();
            }
        });
    }
    if (chrome.permissions && chrome.permissions.onRemoved) {
        chrome.permissions.onRemoved.addListener((perms) => {
            if (perms && Array.isArray(perms.permissions) && perms.permissions.includes('webNavigation')) {
                unregisterWebNavListeners();
            }
        });
    }
}

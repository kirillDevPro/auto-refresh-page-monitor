/**
 * Handles chrome.alarms events for refresh, recovery, and service-worker keepalive work.
 *
 * Per-tab refresh alarms reload tabs after whitelist/blacklist checks, scheduled-rule live-URL
 * checks, the global smart-pause gate, and per-tab cache-mode resolution. Recovery alarms are
 * routed to navigationRecovery, whose recovery reload wrapper acquires the shared inFlightTabs lock.
 * The keepalive alarm also runs missed-alarm, orphaned-alarm, stuck-load, and reconnect sweeps.
 */
import { getGlobalAppSettings, resolveBypassCache, isGlobalSettingsLoaded, loadGlobalSettings } from './settings.js';
import { getTabState, updateTabStorageAndState } from './state.js';
import { updateIcon, markTabAsClosed, isTabClosed, ensureBadgeTimer } from './iconController.js';
import { scheduleTabRefresh } from './alarmUtils.js';
import { tryAcquireTab, releaseTab } from './inFlightTabs.js';
import { isUserActive, isTabFocused } from './activityGuard.js';
import { ALARM_NAMES, TAB_ALARM_PREFIX, RECOVER_ALARM_PREFIX, tabAlarmName, clampInterval } from './constants.js';
import { handleKeepaliveAlarm } from './lifecycle.js';
import { isTabNotFoundError } from './actionUtils.js';

// Dependencies injected by initializeAlarmHandler.
let playNotificationSoundFunc;
let logActivityFunc;
let cleanupRefresherFunc;
let statisticsCollectorInstance;
// Returns true if the URL matches at least one enabled scheduled rule.
// Injected from scheduler.js - needed so a scheduled tab that drifted via SPA navigation
// onto a non-matching page does not keep reloading (see handleAlarm).
let urlMatchesAnyEnabledScheduleFunc;
// Deactivates a scheduled tab (clear the alarm + reset state to idle). Also from scheduler.js -
// the single shared teardown, common with applyScheduledRefreshIfNeeded (see the SPA guard in handleAlarm).
let deactivateScheduledTabFunc;
// Auto-recovery callbacks from navigationRecovery.js: handleRecoveryAlarm fires a backed-off recovery
// reload when a recover_tab_<id> alarm rings; checkStuckLoads sweeps for hung loads on the keepalive
// tick; checkReconnect fast-forwards pending recoveries on a network reconnect, also on that tick.
let handleRecoveryAlarmFunc;
let checkStuckLoadsFunc;
let checkReconnectFunc;

/**
 * Safely test a URL against a user-supplied regex pattern.
 * Returns false and logs a warning if the pattern is invalid.
 * @param {*} pattern - User-supplied regex source.
 * @param {string} url - URL to test.
 * @returns {boolean} true when the regex is valid and matches the URL.
 */
function safeRegexTest(pattern, url) {
    if (pattern == null || typeof pattern !== 'string') return false;
    try {
        return new RegExp(pattern).test(url);
    } catch (e) {
        console.warn(`Invalid regex pattern "${pattern}", skipping:`, e.message);
        return false;
    }
}

// Deduplication map for double-delivery from missed-alarm checks and real onAlarm events.
const recentlyRefreshedTabs = new Map(); // tabId -> timestamp (ms)
let lastDedupCleanup = Date.now();
let missedAlarmCheckInProgress = false;
// Re-entrancy guard for the vanished-alarm watchdog (a sweep separate from missedAlarm).
let orphanCheckInProgress = false;
// Per-tab reload serialization uses the shared inFlightTabs lock (tryAcquireTab/releaseTab) so normal
// refresh fires and recovery reloads (which call doRecoveryReload directly) cannot race for one tab.

/**
 * Wire up injected dependencies and register the chrome.alarms.onAlarm listener.
 * @param {object} dependencies - { playNotificationSound, logActivity, cleanupRefresher,
 *   statisticsCollector, urlMatchesAnyEnabledSchedule, deactivateScheduledTab,
 *   handleRecoveryAlarm, checkStuckLoads, checkReconnect }
 * @returns {void}
 */
export function initializeAlarmHandler(dependencies) {
    playNotificationSoundFunc = dependencies.playNotificationSound;
    logActivityFunc = dependencies.logActivity;
    cleanupRefresherFunc = dependencies.cleanupRefresher;
    statisticsCollectorInstance = dependencies.statisticsCollector;
    urlMatchesAnyEnabledScheduleFunc = dependencies.urlMatchesAnyEnabledSchedule;
    deactivateScheduledTabFunc = dependencies.deactivateScheduledTab;
    handleRecoveryAlarmFunc = dependencies.handleRecoveryAlarm;
    checkStuckLoadsFunc = dependencies.checkStuckLoads;
    checkReconnectFunc = dependencies.checkReconnect;

    chrome.alarms.onAlarm.addListener(handleAlarm);
}

/**
 * Reschedule a tab's refresh alarm after a fire, but only if Chrome no longer holds the alarm.
 * Periodic alarms (>=60s, no jitter) are auto-rescheduled by Chrome and STILL EXIST after a fire,
 * so we must not touch them. One-shot alarms (<60s, or any jittered interval) are consumed on fire
 * and vanish, so we re-arm them (with a fresh jittered offset). Deciding by the alarm's existence -
 * instead of re-deriving one-shot-ness from jitter settings - makes this drift-proof: the re-arm
 * decision can no longer disagree with the schedule-time one-shot decision when the effective jitter
 * percent changes in between (global toggle flip, or a stale-settings read on a cold-woken SW).
 * @param {number} tabId
 * @param {object} tabSettings - Current per-tab state, including interval, jitter mode/percent, and alarm name.
 * @returns {Promise<void>}
 */
async function rescheduleAfterFire(tabId, tabSettings) {
    const alarmName = tabSettings.alarmName || tabAlarmName(tabId);
    const existing = await chrome.alarms.get(alarmName);
    if (!existing) {
        await scheduleTabRefresh(alarmName, tabSettings.interval, tabSettings.jitterMode, { jitterPercent: tabSettings.jitterPercent });
    }
}

/**
 * Finalize a fire: RE-READ the current tab state and only re-arm + persist if the tab is still
 * active and not paused. A stop/pause/mode change can land during the reload
 * await; without this re-read, handleAlarm would write its stale pre-reload snapshot back and
 * resurrect a just-stopped/paused timer - re-creating the very alarm stop had cleared, looping
 * forever for <60s/jittered intervals. Fields this fire legitimately produced (refreshCount,
 * isAutoRefresh) are carried onto the fresh state.
 * @param {number} tabId
 * @param {object} ownedUpdates - fire-produced fields to preserve onto the fresh state
 * @returns {Promise<void>}
 */
async function finalizeAfterFire(tabId, ownedUpdates) {
    const fresh = await getTabState(tabId);
    if (!(fresh && fresh.isActive && !fresh.isPaused)) {
        // The user stopped/paused before finalization; stop/pause already cleared the alarm.
        // do not resurrect the timer or overwrite their fresh record with a stale snapshot.
        return;
    }
    Object.assign(fresh, ownedUpdates);
    await rescheduleAfterFire(tabId, fresh);
    // rescheduleAfterFire arms the alarm with internal awaits; a stop/pause could land
    // during that window. Re-read once more and write the active snapshot ONLY if the tab is
    // still active; otherwise do NOT write (writing would resurrect a stopped timer). We deliberately
    // do NOT clear the alarm in the else branch: if a stop arrived during arming, the leftover alarm
    // is harmless: handleAlarm on its next fire will see isActive=false and clear it without reloading.
    // Clearing it here, by contrast, would wipe an alarm a concurrent start may have just armed (a zombie).
    const recheck = await getTabState(tabId);
    if (recheck && recheck.isActive && !recheck.isPaused) {
        await updateTabStorageAndState(tabId, fresh);
    }
}

/**
 * Top-level chrome.alarms.onAlarm dispatcher.
 * For the keepalive alarm it runs the lifecycle handler plus the missed-alarm and orphaned-alarm
 * sweeps. For a per-tab refresh alarm (name starts with TAB_ALARM_PREFIX) it loads global settings
 * if not yet loaded, applies the scheduled-rule SPA guard, whitelist/blacklist, and smart-pause
 * skip gate, dedups, reloads the tab with the resolved per-tab cache mode when allowed, records
 * stats for actual reload attempts, and re-arms via finalizeAfterFire. Smart-pause skips are not
 * written to the activity log. An inFlightTabs guard serializes concurrent dispatches for the same
 * tab; alarms for inactive/paused tabs are cleared.
 * @param {chrome.alarms.Alarm} alarm
 * @param {object} [opts] - dispatch options.
 * @param {boolean} [opts.clearBeforeReschedule] - when true (a forced badge-timer rescue), clear this
 *   alarm right AFTER the per-tab lock is acquired so finalizeAfterFire re-arms it fresh; see the
 *   inline note below and forceCheckAlarmForTab.
 * @returns {Promise<void>}
 */
async function handleAlarm(alarm, opts = {}) {
    // Handle keepalive alarm for service worker lifecycle management.
    if (alarm.name === ALARM_NAMES.KEEPALIVE) {
        await handleKeepaliveAlarm();
        await checkAndHandleMissedAlarms();
        // Watchdog: active tabs whose alarm vanished entirely. A consumed one-shot (jitter, or a
        // 30-59s interval) disappears from chrome.alarms.getAll() after SW sleep/death, so
        // checkAndHandleMissedAlarms (which only scans getAll) cannot see it, so we catch it here.
        await checkAndRearmOrphanedAlarms();
        // Auto-recovery: detect lost recovery alarms and stuck loads; no-op without webNavigation.
        if (checkStuckLoadsFunc) await checkStuckLoadsFunc();
        // Network reconnect: on an offline->online transition, fast-forward pending recoveries so a tab
        // that failed while offline reloads immediately instead of waiting out its backoff (no-op without webNavigation).
        if (checkReconnectFunc) await checkReconnectFunc();
        return;
    }

    // Validate alarm object and name format
    if (!alarm?.name || typeof alarm.name !== 'string') {
        return;
    }

    // Recovery alarm (recover_tab_<id>): a backed-off reload of a tab whose load failed or hung.
    // It is handled before the refresh-alarm path and serialized through inFlightTabs so a normal
    // refresh reload cannot race a recovery reload for the same tab.
    if (alarm.name.startsWith(RECOVER_ALARM_PREFIX)) {
        // doRecoveryReload (navigationRecovery) acquires the shared per-tab in-flight lock itself, so the
        // recovery reload is serialized against a normal refresh fire and the keepalive sweeps without a
        // pre-acquire here.
        if (handleRecoveryAlarmFunc) await handleRecoveryAlarmFunc(alarm);
        return;
    }

    const prefix = TAB_ALARM_PREFIX;
    if (!alarm.name.startsWith(prefix)) {
        return;
    }

    const tabId = parseInt(alarm.name.slice(prefix.length), 10);
    if (!Number.isInteger(tabId) || tabId <= 0) {
        return;
    }

    // After a COLD start the in-memory globalAppSettings are still defaults (onChanged stays silent
    // without a write), yet whitelist/blacklist and resolveBypassCache are read right here, on the fire.
    // Load settings once - like tabLifecycle.js - otherwise the first fire after wake-up judges by
    // seed defaults (could bypass whitelist/blacklist and pick the wrong cache mode).
    if (!isGlobalSettingsLoaded()) await loadGlobalSettings();

    // Early exit if tab is known to be closed; avoid unnecessary API calls.
    if (isTabClosed(tabId)) {
        if (cleanupRefresherFunc) await cleanupRefresherFunc(tabId).catch(() => {});
        return;
    }

    // Per-tab in-flight guard: forceCheckAlarmForTab (the 1s badge timer) calls handleAlarm
    // OUTSIDE the checkAndHandleMissedAlarms re-entrancy guard, so a single tab could be processed
    // twice concurrently. The shared lock also serializes against recovery reloads (doRecoveryReload),
    // and makes the dedup map a backstop, not the sole defense against a double reload.
    if (!tryAcquireTab(tabId)) return;

    try {
        // Forced badge-timer rescue: after THIS dispatch owns the per-tab lock, clear the overdue
        // alarm so finalizeAfterFire's existence-based rescheduleAfterFire re-arms it fresh (advancing
        // scheduledTime so the countdown recovers - for one-shot AND periodic alarms; clearing a periodic
        // alarm also cancels Chrome's pending delivery). Clearing UNDER the lock (not before dispatch) is
        // what makes this safe: if the lock were busy - e.g. a concurrent recovery reload, which does NOT
        // re-arm the refresh alarm - handleAlarm already returned at the tryAcquireTab guard above, BEFORE
        // this clear, leaving the alarm intact so the timer is never lost; the next badge zero-tick retries.
        // recentlyRefreshedTabs remains the backstop if Chrome had already queued the original onAlarm event.
        if (opts.clearBeforeReschedule) {
            await chrome.alarms.clear(alarm.name);
        }

        // First, check if the tab exists (errors are thrown as exceptions with Promise API)
        const tab = await chrome.tabs.get(tabId);

        // If tab object is somehow null/undefined, cleanup and exit
        if (!tab) {
            if (cleanupRefresherFunc) await cleanupRefresherFunc(tabId).catch(() => {});
            return;
        }

        // Proceed if tab exists
        let tabSettings = await getTabState(tabId);
        if (tabSettings && tabSettings.isActive && !tabSettings.isPaused) {
            const url = tab.url;

            // SPA guard: a scheduled (URL-pattern) refresh must fire only while the tab still matches
            // its rule. Home Assistant and similar SPAs navigate via the History API WITHOUT a 'complete'
            // event, so an armed alarm could carry the reload onto an unrelated page. We re-check the live
            // URL and, on mismatch, deactivate the tab without reloading, mirroring the deactivation in
            // applyScheduledRefreshIfNeeded. `url &&`: when tab.url is empty (tab mid-navigation) the URL
            // is unknown; do not deactivate based on it. Manual (non-scheduled) refreshes are deliberately
            // tab-bound and skip this gate.
            if (tabSettings.isScheduled && url && urlMatchesAnyEnabledScheduleFunc &&
                !urlMatchesAnyEnabledScheduleFunc(url) && deactivateScheduledTabFunc) {
                await deactivateScheduledTabFunc(tabId, tabSettings,
                    `Deactivated scheduled refresh — tab no longer matches any rule: ${url}`);
                return;
            }

            const currentGlobalSettings = getGlobalAppSettings();
            let allowRefresh = true;

            if (currentGlobalSettings.blacklist && currentGlobalSettings.blacklist.some(pattern => safeRegexTest(pattern, url))) {
                allowRefresh = false;
            }
            if (allowRefresh && currentGlobalSettings.whitelist && currentGlobalSettings.whitelist.length > 0 &&
                !currentGlobalSettings.whitelist.some(pattern => safeRegexTest(pattern, url))) {
                allowRefresh = false;
            }

            // Smart pause: when enabled, SKIP this refresh cycle only for the tab the user is ACTUALLY
            // VIEWING (the active tab of the focused window) WHILE they are active (chrome.idle reports
            // 'active'), so an auto-reload never interrupts active work on the page in front of them
            // (typing in a form, scrolling an article). Background tabs the user is not looking at always
            // refresh - chrome.idle alone is system-wide, so the isTabFocused gate is what keeps the skip
            // from blocking every tab while the user works elsewhere. isTabFocused is checked first: a
            // background tab returns false without the extra idle query, and it re-reads the tab fresh so a
            // focus change during the earlier awaits is honored at decision time. The cycle is skipped, not
            // deferred - finalizeAfterFire below still re-arms, so the next interval tries again. Auto-recovery
            // reloads (navigationRecovery) deliberately bypass this gate: they fix a broken page, not active work.
            // Deliberately NOT written to the activity log: on short intervals an active user would flood the
            // capped 200-entry log; a console line is enough for debugging.
            let skippedForActivity = false;
            if (allowRefresh && currentGlobalSettings.pauseWhileActiveEnabled === true
                    && await isTabFocused(tabId) && await isUserActive()) {
                allowRefresh = false;
                skippedForActivity = true;
                console.debug(`Smart pause: skipped refresh for focused tab ${tabId} (user active): ${url}`);
            }

            if (allowRefresh) {
                // Dedup: skip if this tab was already refreshed recently.
                // Window: min 5s, max 30s - safe for packed-floor short intervals and long timers.
                const lastRefreshTime = recentlyRefreshedTabs.get(tabId);
                const dedupWindowMs = Math.max(Math.min(tabSettings.interval * 500, 30000), 5000);
                if (lastRefreshTime && (Date.now() - lastRefreshTime) < dedupWindowMs) {
                    // Already refreshed recently (by missed-alarm check or duplicate alarm), skip reload.
                    // Still reschedule for the next cycle (one-shot for <60s or any jittered interval).
                    await finalizeAfterFire(tabId, {
                        isAutoRefresh: tabSettings.isAutoRefresh,
                        refreshCount: tabSettings.refreshCount
                    });
                    return;
                }

                try {
                    // Mark as auto-refresh before reload so tabLifecycle can distinguish from manual refresh
                    tabSettings.isAutoRefresh = true;
                    await updateTabStorageAndState(tabId, tabSettings);
                    // Set dedup timestamp before reload to prevent a TOCTOU race
                    // when both missed-alarm check and real alarm pass dedup simultaneously
                    recentlyRefreshedTabs.set(tabId, Date.now());
                    // bypassCache=true equals Ctrl+Shift+R (hard reload). Per-tab refreshMode
                    // ('hard'/'normal') overrides the global default; 'default' falls back to it.
                    await chrome.tabs.reload(tabId, { bypassCache: resolveBypassCache(tabSettings.refreshMode) });
                    tabSettings.refreshCount = (tabSettings.refreshCount || 0) + 1;
                    await updateIcon(tabId, 'updated', tabSettings.interval);
                    // Race-condition guard: if the tab closes within 2 seconds, do not call the
                    // chrome.action API and swallow any rejection so Chrome does not log
                    // "Unchecked runtime.lastError".
                    setTimeout(() => {
                        if (isTabClosed(tabId)) return;
                        updateIcon(tabId, 'active', tabSettings.interval).catch(() => {});
                    }, 2000);
                    if (tabSettings.soundEnabled && playNotificationSoundFunc) {
                        playNotificationSoundFunc().catch(e => console.warn('Sound playback failed:', e.message));
                    }
                    if (logActivityFunc) logActivityFunc(tabId, `Refreshed: ${url} (Interval: ${tabSettings.interval}s)`);

                    if (statisticsCollectorInstance) {
                        // Fire-and-forget: the write is serialized by an internal queue and catches its
                        // own errors; we do not block the hot reload path by awaiting it.
                        statisticsCollectorInstance.recordRefresh(tabId, url, tabSettings.interval, true);
                    }
                } catch (refreshError) {
                    // Remove dedup entry so the next alarm can refresh this tab
                    recentlyRefreshedTabs.delete(tabId);
                    // Reset auto-refresh flag on error to ensure next manual refresh works correctly
                    tabSettings.isAutoRefresh = false;
                    await updateTabStorageAndState(tabId, tabSettings);

                    if (logActivityFunc) logActivityFunc(tabId, `Failed to refresh: ${url} (Error: ${refreshError.message})`);

                    if (statisticsCollectorInstance) {
                        statisticsCollectorInstance.recordRefresh(tabId, url, tabSettings.interval, false);
                    }
                }
            } else if (!skippedForActivity) {
                if (logActivityFunc) logActivityFunc(tabId, `Skipped refresh for ${url} due to rules.`);
            }
            // Re-arm and persist via finalizeAfterFire, which first re-reads fresh state so a
            // stop/pause/mode-change that landed during the reload await is honored rather than
            // clobbered by this stale snapshot (see finalizeAfterFire).
            await finalizeAfterFire(tabId, {
                isAutoRefresh: tabSettings.isAutoRefresh,
                refreshCount: tabSettings.refreshCount
            });
        } else {
            // This case handles when the timer is no longer active or is paused.
            await chrome.alarms.clear(alarm.name);
            if (tabSettings) {
                tabSettings.isActive = false;
                tabSettings.isPaused = false;
                await updateTabStorageAndState(tabId, tabSettings);
                await updateIcon(tabId, 'idle');
            } else {
                // If no settings, still try to cleanup.
                if (cleanupRefresherFunc) await cleanupRefresherFunc(tabId).catch(() => {});
            }
        }
    } catch (error) {
        // This outer catch handles errors from chrome.tabs.get, meaning the tab likely closed.
        if (isTabNotFoundError(error)) {
            markTabAsClosed(tabId); // Prevent further API calls for this tab
            if (cleanupRefresherFunc) await cleanupRefresherFunc(tabId).catch(() => {});
        }
    } finally {
        releaseTab(tabId);
    }
}

/**
 * Active overdue check for a single tab, invoked from the badge timer on every tick the countdown
 * sits at 00:00. Forces handleAlarm as soon as the refresh alarm is genuinely overdue (scheduledTime
 * in the past), cutting the wait for Chrome's throttled natural delivery / the ~30s keepalive sweep
 * down to ~1 second. The clear of the overdue alarm is DEFERRED into handleAlarm (clearBeforeReschedule),
 * where it runs UNDER the per-tab lock - so a busy lock (e.g. a concurrent recovery reload, which never
 * re-arms the refresh alarm) cannot clear-then-fail-to-re-arm and lose the timer; finalizeAfterFire then
 * re-arms it fresh (one-shot OR periodic). recentlyRefreshedTabs dedup prevents a double refresh if Chrome
 * later delivers the original alarm event.
 * @param {number} tabId - Tab id whose refresh alarm should be checked.
 * @returns {Promise<boolean>} true when an overdue alarm was force-dispatched.
 */
export async function forceCheckAlarmForTab(tabId) {
    if (!Number.isInteger(tabId) || tabId <= 0) return false;

    const alarmName = tabAlarmName(tabId);
    try {
        const alarm = await chrome.alarms.get(alarmName);
        if (!alarm) return false;

        // Force only a genuinely-late alarm: overdueMs > 0 means scheduledTime has actually passed.
        // The badge can show 00:00 up to ~500ms BEFORE the alarm is due (alarmRemainingSeconds rounds),
        // so those ticks have overdueMs <= 0 and must NOT preempt Chrome's imminent on-time delivery.
        const overdueMs = Date.now() - alarm.scheduledTime;
        if (overdueMs <= 0) return false;

        const overdueSeconds = Math.round(overdueMs / 1000);
        console.warn(`Active badge re-check: forcing ${alarmName} (overdue ${overdueSeconds}s)`);
        // Surface meaningful recoveries to the activity log so users can see
        // when refreshes were rescued from a stuck-alarm state.
        if (overdueMs > 5000 && logActivityFunc) {
            logActivityFunc(tabId, `Force-triggered overdue refresh (${overdueSeconds}s late)`);
        }
        // Dispatch with clearBeforeReschedule: handleAlarm clears the overdue alarm AFTER it owns the
        // per-tab lock, then finalizeAfterFire re-arms it fresh (one-shot OR periodic). We deliberately do
        // NOT clear here: clearing before dispatch could lose the timer when the lock is held by a recovery
        // reload (handleAlarm would return at its tryAcquireTab guard without re-arming). See handleAlarm.
        await handleAlarm({
            name: alarm.name,
            scheduledTime: alarm.scheduledTime,
            periodInMinutes: alarm.periodInMinutes
        }, { clearBeforeReschedule: true });
        return true;
    } catch (error) {
        if (isTabNotFoundError(error)) {
            markTabAsClosed(tabId);
            return false;
        }
        console.warn(`forceCheckAlarmForTab failed for tab ${tabId}:`, error.message);
        return false;
    }
}

/**
 * Check for alarms that should have fired but were delayed by Chrome.
 * Called on every keepalive tick (~30s) to catch missed refresh alarms.
 * Does NOT clear overdue alarms - lets Chrome deliver them naturally
 * (periodic alarms auto-reschedule; a still-alive one-shot is re-armed only once
 * Chrome delivers the real alarm and consumes it, not by this synthetic dispatch).
 * Dedup in handleAlarm prevents double-refreshes.
 * @returns {Promise<void>}
 */
async function checkAndHandleMissedAlarms() {
    // Re-entrancy guard: prevent concurrent executions from overlapping keepalive ticks
    if (missedAlarmCheckInProgress) return;
    missedAlarmCheckInProgress = true;

    try {
        const allAlarms = await chrome.alarms.getAll();
        const now = Date.now();
        const OVERDUE_THRESHOLD_MS = 2000; // Consider missed when 2+ seconds past scheduled time.

        // Periodic cleanup of dedup map
        if (now - lastDedupCleanup > 60000) {
            for (const [id, timestamp] of recentlyRefreshedTabs) {
                if (now - timestamp > 120000) recentlyRefreshedTabs.delete(id);
            }
            lastDedupCleanup = now;
        }

        for (const alarm of allAlarms) {
            if (!alarm.name.startsWith(TAB_ALARM_PREFIX)) continue;
            if (alarm.scheduledTime > now - OVERDUE_THRESHOLD_MS) continue;

            // This alarm is overdue - Chrome delayed its delivery
            const overdueSeconds = Math.round((now - alarm.scheduledTime) / 1000);
            console.warn(`Missed alarm detected: ${alarm.name}, overdue by ${overdueSeconds}s`);

            // Manually trigger the alarm handler with a synthetic alarm object.
            // Do NOT clear the alarm here: non-jittered periodic alarms (>= 60s) are
            // auto-rescheduled by Chrome on delivery. A one-shot alarm (< 60s, or ANY
            // jittered interval) is still alive at this point (it came from getAll), so
            // rescheduleAfterFire sees it still exists and skips re-arming; the real
            // Chrome delivery later consumes it and re-arms via finalizeAfterFire (dedup
            // in handleAlarm prevents the synthetic + real fire from double-refreshing).
            await handleAlarm({
                name: alarm.name,
                scheduledTime: alarm.scheduledTime,
                periodInMinutes: alarm.periodInMinutes
            });
        }
    } catch (error) {
        console.error('Error checking for missed alarms:', error);
    } finally {
        missedAlarmCheckInProgress = false;
    }
}

/**
 * Watchdog for VANISHED alarms of active tabs. In the same pass over live tabs it also revives
 * orphaned 1s badge timers of tabs whose alarm is still alive - their setInterval dies on SW
 * suspension, and on a bare wake-up without re-bootstrap the countdown would otherwise freeze
 * (via ensureBadgeTimer).
 *
 * checkAndHandleMissedAlarms only sees existing-but-overdue alarms (via chrome.alarms.getAll).
 * But a consumed one-shot (jitter, or a 30-59s interval) that Chrome deleted BEFORE finalizeAfterFire
 * could re-arm it (SW death / sleep between fire and re-arm) disappears from getAll() entirely - nothing
 * catches it except a full reapplyTimersOnStartup on the next cold start. This sweep closes the gap:
 * every ~30s (keepalive tick) we walk the LIVE tabs (chrome.tabs.query, not a read of all storage -
 * which may hold multi-megabyte statistics) and, if a tab is marked active (not paused) but its alarm
 * has been absent LONGER than the grace window since the last arming, we treat the timer as lost and re-arm.
 *
 * Grace = interval*1.5 + 10s from tab_{id}_lastArmed (written in scheduleTabRefresh): keeps it from
 * firing in the normal fire->re-arm window where the alarm is absent for a fraction of a second. A MISSING
 * stamp => skip: a legitimate orphan always has a stamp from its last arming, and its absence means a
 * stopped/closed tab (clearTabAlarms removed the stamp) or a legacy tab from before this feature (which
 * reapplyTimersOnStartup will finish off on a cold start / onInstalled) - re-arming without a stamp would
 * resurrect a stopped timer. A scheduled tab whose live URL drifted off its pattern is DEACTIVATED (like the
 * fire-time SPA guard in handleAlarm), not re-armed - otherwise one extra reload of an unrelated page.
 * Re-arming goes through the same scheduleTabRefresh + updateTabStorageAndState (the badge restarts);
 * handleAlarm on a closed tab cleans up the alarm itself (chrome.tabs.query already returned only live tabs).
 * @returns {Promise<void>}
 */
export async function checkAndRearmOrphanedAlarms() {
    if (orphanCheckInProgress) return;
    orphanCheckInProgress = true;

    try {
        const tabs = await chrome.tabs.query({});
        const now = Date.now();

        for (const tab of tabs) {
            if (!tab || !Number.isInteger(tab.id) || tab.id <= 0) continue;

            const settings = await getTabState(tab.id);
            // !interval guards against clampInterval(null)=30 (Number(null)===0 -> MIN) on a half-reset
            // record (isActive=true but interval=null) - otherwise we would arm a phantom 30s timer.
            if (!settings || !settings.isActive || settings.isPaused || !settings.interval) continue;

            const alarmName = tabAlarmName(tab.id);
            const existingAlarm = await chrome.alarms.get(alarmName);
            if (existingAlarm) {
                // The alarm is alive - the timer is not lost. But the 1s badge countdown (setInterval)
                // may have died on SW suspension; on a bare wake-up (no re-bootstrap) there is nothing to
                // restart it - revive the orphaned badge timer without touching the alarm itself.
                await ensureBadgeTimer(tab.id, settings, existingAlarm);
                continue;
            }

            const stored = await chrome.storage.local.get(`tab_${tab.id}_lastArmed`);
            const lastArmed = stored[`tab_${tab.id}_lastArmed`] || 0;
            // No arming stamp => not our orphan: stopped/closed (clearTabAlarms removed the stamp) or a
            // legacy tab from before this feature. Re-arming would resurrect a stopped timer - skip.
            if (!lastArmed) continue;
            const interval = clampInterval(settings.interval);
            const graceMs = interval * 1500 + 10000; // interval*1.5s + 10s margin
            if ((now - lastArmed) < graceMs) continue; // armed recently / mid re-arm

            // A scheduled tab whose live URL drifted off its pattern (SPA pushState) is NOT re-armed -
            // otherwise one extra reload of an unrelated page before the fire-time SPA guard removes it.
            // We mirror the guard from handleAlarm: on mismatch, deactivate here.
            if (settings.isScheduled && tab.url && urlMatchesAnyEnabledScheduleFunc &&
                !urlMatchesAnyEnabledScheduleFunc(tab.url) && deactivateScheduledTabFunc) {
                await deactivateScheduledTabFunc(tab.id, settings,
                    `Deactivated orphaned scheduled refresh — tab no longer matches any rule: ${tab.url}`);
                continue;
            }

            console.warn(`Orphaned alarm: tab ${tab.id} active but alarm missing — re-arming (${interval}s)`);
            if (logActivityFunc) logActivityFunc(tab.id, `Recovered lost auto-refresh timer (${interval}s)`);

            settings.interval = interval;
            await scheduleTabRefresh(alarmName, interval, settings.jitterMode, { jitterPercent: settings.jitterPercent });
            await updateTabStorageAndState(tab.id, settings);
            await updateIcon(tab.id, 'active', interval);
        }
    } catch (error) {
        console.error('Error checking for orphaned alarms:', error);
    } finally {
        orphanCheckInProgress = false;
    }
}

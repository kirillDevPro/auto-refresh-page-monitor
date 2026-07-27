/**
 * URL-pattern-based scheduled-refresh scheduler.
 *
 * Activates, restores, keeps-in-sync and deactivates per-tab scheduled auto-refresh
 * timers driven by the user's `scheduledRefreshes` rules. Refreshes are gated to
 * http(s) URLs (`isRefreshableUrl`) and to tabs whose live URL still matches at least
 * one enabled rule (`urlMatchesAnyEnabledSchedule`), so an armed alarm can't keep
 * reloading a page the tab has drifted to. Also re-arms surviving/lost alarms on a
 * service-worker cold start (`reapplyTimersOnStartup`). Dependencies (activity log,
 * statistics collector) are injected via `initializeScheduler` to avoid circular imports.
 */
import { getGlobalAppSettings, loadGlobalSettings, resolveJitterPercent, sanitizeJitterPercent } from './settings.js';
import { getTabState, updateTabStorageAndState } from './state.js';
import { updateIcon } from './iconController.js';
import { scheduleTabRefresh, clearTabAlarms } from './alarmUtils.js';
import { tabAlarmName, clampInterval } from './constants.js';

// Injected dependencies set by initializeScheduler.
let logActivityFunc;
let statisticsCollectorInstance;

/**
 * Wire injected dependencies into the scheduler (avoids circular imports).
 * @param {object} dependencies
 * @param {function(number, string):void} dependencies.logActivity - activity-log writer
 * @param {object} dependencies.statisticsCollector - statistics collector singleton
 * @returns {void}
 */
export function initializeScheduler(dependencies) {
    logActivityFunc = dependencies.logActivity;
    statisticsCollectorInstance = dependencies.statisticsCollector;
}

/**
 * True if `url` is a schedulable/refreshable page, i.e. an http(s) URL.
 * Filters out chrome://, devtools://, view-source:, about:, file:// and extension pages.
 * @param {string} url
 * @returns {boolean}
 */
export function isRefreshableUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Apply, restore or keep-in-sync the scheduled refresh for a tab given its current URL.
 * Skips manually-active (non-scheduled) tabs. For the first enabled rule whose pattern
 * matches the URL it either restores or reschedules the alarm, synchronizes the rule's modes and
 * jitter strength, or activates the tab. If no enabled rule matches and the tab was scheduled, it
 * is deactivated.
 * @param {number} tabId
 * @param {string} url - the tab's current URL
 * @returns {Promise<void>}
 */
export async function applyScheduledRefreshIfNeeded(tabId, url) {
    const currentGlobalSettings = getGlobalAppSettings();
    if (!currentGlobalSettings.scheduledRefreshes || currentGlobalSettings.scheduledRefreshes.length === 0) return;

    const currentTabSettings = await getTabState(tabId);
    if (currentTabSettings.isActive && !currentTabSettings.isScheduled) {
        return;
    }

    for (const schedule of currentGlobalSettings.scheduledRefreshes) {
        if (schedule.enabled && isRefreshableUrl(url) && urlMatchesPattern(url, schedule.url)) {
            const alarmName = tabAlarmName(tabId);
            const scheduleMode = schedule.refreshMode || 'default';
            const scheduleJitterMode = schedule.jitterMode || 'default';
            // A rule's range strength is honored only under an explicit 'on' (the range<->mode
            // invariant); any other mode carries 0 so a stale rule percent cannot leak through.
            const scheduleJitterPercent = sanitizeJitterPercent(scheduleJitterMode, schedule.jitterPercent);
            const scheduleRecoverMode = schedule.recoverMode || 'default';
            // Clamp the rule interval at the point it enters tab state: a corrupted/non-numeric
            // interval (e.g. from an imported profile) would otherwise settle into tabSettings.interval
            // and break the dedup window (NaN*500 -> NaN) and the comparison below (NaN===NaN is always
            // false -> re-activation on every navigation).
            const safeInterval = clampInterval(schedule.interval);

            // Check if settings already match - but still need to restore alarm after extension restart
            if (currentTabSettings.isActive && currentTabSettings.isScheduled && currentTabSettings.interval === safeInterval) {
                // Detect a jitter change BEFORE overwriting state: a jitter mode/strength edit that
                // keeps the same interval (e.g. a range widened around the same midpoint) changes the
                // alarm TYPE (periodic<->one-shot), so the existing alarm must be replaced, not kept.
                const jitterChanged = currentTabSettings.jitterMode !== scheduleJitterMode
                    || (currentTabSettings.jitterPercent || 0) !== scheduleJitterPercent;
                // Keep the active tab's refresh/jitter/recover mode in sync if the rule was edited
                currentTabSettings.refreshMode = scheduleMode;
                currentTabSettings.jitterMode = scheduleJitterMode;
                currentTabSettings.jitterPercent = scheduleJitterPercent;
                currentTabSettings.recoverMode = scheduleRecoverMode;
                // Settings match, but alarm might be lost after restart - check and restore if needed
                const existingAlarm = await chrome.alarms.get(alarmName);
                // The stored rule fields can be unchanged while the EFFECTIVE jitter flipped — e.g. an
                // inherited 'default' rule after the global jitter toggle is switched. That changes the
                // alarm TYPE (a scheduleAlarm is periodic only for >=60s WITHOUT jitter; otherwise
                // one-shot), which the raw-field jitterChanged check above cannot see. Compare the live
                // alarm's actual type against the desired effective type so an inherited rule re-arms.
                const desiredJitterPercent = resolveJitterPercent(scheduleJitterMode, scheduleJitterPercent);
                const desiredPeriodic = safeInterval >= 60 && desiredJitterPercent === 0;
                const existingPeriodic = !!(existingAlarm && existingAlarm.periodInMinutes !== undefined);
                const alarmTypeStale = existingAlarm && existingPeriodic !== desiredPeriodic;
                if (existingAlarm && !jitterChanged && !alarmTypeStale) {
                    // Alarm exists, interval matches, jitter effect unchanged; persist any non-alarm mode
                    // change (also refreshes the badge) and return without rescheduling.
                    await updateTabStorageAndState(tabId, currentTabSettings);
                    return;
                }
                // Alarm lost after restart, OR the jitter type/strength changed - (re)schedule it.
                await scheduleTabRefresh(alarmName, safeInterval, scheduleJitterMode, { jitterPercent: scheduleJitterPercent });
                await updateTabStorageAndState(tabId, currentTabSettings);
                await updateIcon(tabId, 'active', currentTabSettings.interval);
                if (logActivityFunc) logActivityFunc(tabId, `Restored scheduled refresh for ${url} (Interval: ${safeInterval}s)`);
                return;
            }

            const newSettings = {
                interval: safeInterval,
                isActive: true,
                isPaused: false,
                isCustom: false,
                isScheduled: true,
                soundEnabled: currentGlobalSettings.defaultSoundEnabled || false,
                refreshMode: scheduleMode,
                jitterMode: scheduleJitterMode,
                jitterPercent: scheduleJitterPercent,
                recoverMode: scheduleRecoverMode,
                refreshCount: currentTabSettings.refreshCount || 0,
                alarmName: alarmName
            };
            await scheduleTabRefresh(newSettings.alarmName, safeInterval, scheduleJitterMode, { jitterPercent: scheduleJitterPercent });
            await updateTabStorageAndState(tabId, newSettings);
            await updateIcon(tabId, 'active', newSettings.interval);
            if (logActivityFunc) logActivityFunc(tabId, `Activated scheduled refresh for ${url} (Interval: ${safeInterval}s)`);

            // Statistics are recorded automatically on every refresh

            return;
        }
    }

    if (currentTabSettings.isActive && currentTabSettings.isScheduled) {
        await deactivateScheduledTab(tabId, currentTabSettings);
    }
}

/**
 * Deactivate a scheduled tab: clear its alarm and reset its state to idle. The single source of
 * truth for the "scheduled rule no longer applies" teardown, shared by two call sites that must
 * stay in lockstep: applyScheduledRefreshIfNeeded's no-match tail (URL stopped matching on a
 * 'complete'/SPA re-eval) and alarmHandler's fire-time SPA-guard (the live URL drifted away). The
 * canonical alarm is cleared unconditionally (alarmName may be unwritten on a partially-initialized
 * state, and the alarm would otherwise stay alive after deactivation). Optional logMessage is recorded
 * via the injected activity log.
 * @param {number} tabId
 * @param {object} tabSettings - current per-tab state to derive the stopped snapshot from
 * @param {string} [logMessage] - optional activity-log line
 * @returns {Promise<void>}
 */
export async function deactivateScheduledTab(tabId, tabSettings, logMessage) {
    await clearTabAlarms(tabId, tabSettings && tabSettings.alarmName);
    const stoppedSettings = {
        ...tabSettings,
        isActive: false, isPaused: false, interval: null, refreshCount: 0, alarmName: null, isScheduled: false
    };
    await updateTabStorageAndState(tabId, stoppedSettings);
    await updateIcon(tabId, 'idle');
    if (logMessage && logActivityFunc) logActivityFunc(tabId, logMessage);
}

/**
 * Match a URL against a scheduled-rule pattern. A trailing '*' is a prefix wildcard
 * (matches any URL starting with the literal prefix); otherwise an exact equality match.
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
function urlMatchesPattern(url, pattern) {
    if (pattern.endsWith('*')) {
        return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
}

/**
 * True if `url` is refreshable AND matches at least one currently-enabled scheduled rule,
 * evaluated against the live in-memory global settings.
 *
 * Read live so the alarm handler can gate a scheduled tab's reload: an SPA (Home Assistant
 * etc.) changes its URL via the History API WITHOUT a 'complete' event, so an armed alarm
 * would otherwise keep reloading the page the tab has been navigated away to. Re-checking the
 * live URL here keeps the URL-pattern refresh active ONLY while the tab actually matches.
 * @param {string} url
 * @returns {boolean}
 */
export function urlMatchesAnyEnabledSchedule(url) {
    if (!isRefreshableUrl(url)) return false;
    const { scheduledRefreshes } = getGlobalAppSettings();
    if (!Array.isArray(scheduledRefreshes) || scheduledRefreshes.length === 0) return false;
    return scheduledRefreshes.some(schedule => schedule.enabled && urlMatchesPattern(url, schedule.url));
}

/**
 * Re-arm timers across all tabs on service-worker startup. Loads global settings first.
 * When autoRestoreTimers is disabled, only re-applies scheduled refreshes (they must always
 * run); otherwise it also restores manually-active (non-scheduled) tabs — preserving an
 * existing future alarm and re-arming only when the alarm was actually lost, healing a
 * legacy-corrupted stored interval and clearing a stale isAutoRefresh flag.
 * @returns {Promise<void>}
 */
export async function reapplyTimersOnStartup() {
    await loadGlobalSettings();
    const currentGlobalSettings = getGlobalAppSettings();
    
    // Check the auto-restore-timers setting
    // Use === false intentionally so undefined keeps the default auto-restore behavior.
    if (currentGlobalSettings.autoRestoreTimers === false) {
        // Still apply scheduled refreshes, since they always run independently of auto-restore.
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (tab.id && isRefreshableUrl(tab.url)) {
                await applyScheduledRefreshIfNeeded(tab.id, tab.url);
            }
        }
        return;
    }
    
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (tab.id && isRefreshableUrl(tab.url)) {
            const persistedSettings = await getTabState(tab.id);
            if (persistedSettings.isActive && !persistedSettings.isScheduled) {
                const alarmName = tabAlarmName(tab.id);
                // Heal a legacy-corrupted interval in the persisted state (it could have been
                // stored before the clamp fix): otherwise the dedup window in handleAlarm is computed
                // as NaN*500 and gets disabled.
                persistedSettings.interval = clampInterval(persistedSettings.interval);
                // Paused tabs are not rescheduled here; resume restores their alarm from
                // remainingTimeOnPause. For active tabs we PRESERVE an already-existing future alarm
                // (Chrome persists alarms across SW restarts) and re-arm only if it was actually
                // lost, mirroring the scheduled path above. Unconditional re-creation on every cold
                // start would reset the countdown to a full interval, and under frequent SW churn it
                // would push the next fire further forward so that a >=60s tab could barely refresh
                // at all.
                if (!persistedSettings.isPaused && !(await chrome.alarms.get(alarmName))) {
                    await scheduleTabRefresh(alarmName, persistedSettings.interval, persistedSettings.jitterMode, { jitterPercent: persistedSettings.jitterPercent });
                }
                // Reset the auto-refresh flag: if the SW was killed between reload() and 'complete',
                // the flag could have stayed true and the next MANUAL reload would not reset the timer.
                persistedSettings.isAutoRefresh = false;
                await updateTabStorageAndState(tab.id, persistedSettings);
                await updateIcon(tab.id, persistedSettings.isPaused ? 'paused' : 'active', persistedSettings.interval);
                if (logActivityFunc) logActivityFunc(tab.id, `Auto-restored timer for ${tab.url} (Interval: ${persistedSettings.interval}s)`);
                continue;
            }
            await applyScheduledRefreshIfNeeded(tab.id, tab.url);
        }
    }
}

/**
 * Re-evaluate and apply scheduled refreshes for every open refreshable tab.
 * @returns {Promise<void>}
 */
export async function reapplyScheduledRefreshesToAllTabs() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
         if (tab.id && isRefreshableUrl(tab.url)) {
            await applyScheduledRefreshIfNeeded(tab.id, tab.url);
        }
    }
}

/**
 * Registers the service worker runtime message listener.
 *
 * Routes incoming messages to global settings updates, statistics actions, bulk window/group
 * actions, or per-tab refresh controls. Dependencies are injected by setupMessageHandler to avoid
 * circular imports.
 */
import { getGlobalAppSettings, updateGlobalAppSettings, sanitizeJitterPercent } from './settings.js';
import { getTabState, updateTabStorageAndState, getRemainingTimeForAlarm } from './state.js';
import { updateIcon, markTabAsClosed } from './iconController.js';
import { STORAGE_QUOTA_BYTES, tabAlarmName, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS } from './constants.js';
import { scheduleTabRefresh, clearTabAlarms } from './alarmUtils.js';
import { isTabNotFoundError } from './actionUtils.js';
import { recordLastUsedInterval } from './startInterval.js';

let reapplyScheduledRefreshesToAllTabsFunc;
let statisticsCollectorInstance;
let logActivityFunc;
// Injected by background.js so this module never imports bulkActions.js (which imports the start/stop
// helpers FROM here — importing it back would be a cycle). The set names the bulk actions to route;
// the handler resolves the result. Both stay undefined until setupMessageHandler wires them.
let bulkActionsSet = new Set();
let handleBulkMessageFunc;

const GLOBAL_ACTIONS = new Set(['getStatistics', 'resetStatistics', 'exportStatistics']);

/**
 * Sanitize a requested refresh interval from any extension context.
 * @param {*} raw - The raw interval value (seconds) from the message.
 * @returns {number|null} The rounded interval clamped to [MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS], or null if not a finite number.
 */
function sanitizeInterval(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(Math.round(n), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
}

/**
 * Wire up the runtime.onMessage listener and store injected dependencies.
 * @param {Object} dependencies - Injected collaborators.
 * @param {Function} dependencies.reapplyScheduledRefreshesToAllTabs - Re-applies scheduled rules to all tabs after a global-settings change.
 * @param {Object} dependencies.statisticsCollector - The StatisticsCollector singleton used by global actions.
 * @param {Function} dependencies.logActivity - Appends an entry to the activity log.
 * @param {{actions: Set<string>, handle: Function}} [dependencies.bulkActions] - Window/group bulk
 *   apply support, injected so this module need not import (and cycle with) bulkActions.js.
 * @returns {void}
 */
export function setupMessageHandler(dependencies) {
    reapplyScheduledRefreshesToAllTabsFunc = dependencies.reapplyScheduledRefreshesToAllTabs;
    statisticsCollectorInstance = dependencies.statisticsCollector;
    logActivityFunc = dependencies.logActivity;
    if (dependencies.bulkActions) {
        bulkActionsSet = dependencies.bulkActions.actions;
        handleBulkMessageFunc = dependencies.bulkActions.handle;
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        const tabId = request.tabId || (sender.tab && sender.tab.id);

        if (request.action === 'globalSettingsUpdated') {
            updateGlobalAppSettings(request.newSettings);
            console.log("MessageHandler: Global settings update received and applied.", getGlobalAppSettings());
            if (reapplyScheduledRefreshesToAllTabsFunc) {
                reapplyScheduledRefreshesToAllTabsFunc().catch(err =>
                    console.error('Failed to reapply scheduled refreshes:', err)
                );
            }
            try {
                sendResponse({ status: "globalSettingsAck" });
            } catch (e) {
            }
            return true; // Keep the response channel open for asynchronous listeners.
        }

        if (GLOBAL_ACTIONS.has(request.action)) {
            handleGlobalMessage(request, sendResponse).catch((error) => {
                console.error('handleGlobalMessage error:', error);
                try { sendResponse({ status: "error", message: error.message }); } catch (e) { /* port closed */ }
            });
            return true;
        }

        // Let offscreen.js handle playSound messages; they are not tab-specific refresh actions.
        if (request.action === 'playSound' && request.target === 'offscreen') {
            return false; // Allow other listeners, such as offscreen.js, to handle this.
        }

        // Bulk actions are window/group-scoped, not tab-scoped, so they must be routed BEFORE the
        // tabId guard below. Default the window to the sender's when the popup omitted it.
        if (bulkActionsSet.has(request.action) && handleBulkMessageFunc) {
            const bulkRequest = request.windowId === undefined && sender.tab
                ? { ...request, windowId: sender.tab.windowId }
                : request;
            handleBulkMessageFunc(bulkRequest).then((result) => {
                try { sendResponse({ status: 'bulk_done', result }); } catch (e) { /* port closed */ }
            }).catch((error) => {
                console.error('handleBulkMessage error:', error);
                try { sendResponse({ status: 'error', message: error.message }); } catch (e) { /* port closed */ }
            });
            return true;
        }

        if (!tabId) {
            try {
                sendResponse({ status: "error", message: "No tabId provided for tab-specific action." });
            } catch (e) {
            }
            return true;
        }

        handleTabMessage(request, tabId, sendResponse).catch((error) => {
            console.error('handleTabMessage error:', error);
            try { sendResponse({ status: "error", message: error.message }); } catch (e) { /* port closed */ }
        });
        return true; // Indicates that sendResponse will be called asynchronously.
    });
}

/**
 * Start or restart a tab's auto-refresh timer for messages, menus, shortcuts, and bulk actions. Owns
 * interval sanitization, state construction, alarm arming, persistence, icon updates, and logging.
 * Reads fresh tab state internally so callers need not pass a snapshot.
 * @param {number} tabId - Target tab id.
 * @param {Object} [opts] - Start options: interval, isCustom, soundEnabled, refreshMode, jitterMode,
 *   jitterPercent, and recoverMode. Modes omitted by the caller are carried forward from tab state.
 *   When jitterMode is omitted, jitterPercent is also carried from tab state; otherwise the value
 *   comes from opts. A positive per-item percent is retained only with jitterMode 'on'.
 * @returns {Promise<{ok: boolean, error?: string, settings?: object, remainingTimeForPopup?: number}>}
 */
export async function startRefreshForTab(tabId, opts = {}) {
    const interval = sanitizeInterval(opts.interval);
    if (interval === null) {
        return { ok: false, error: 'Invalid interval' };
    }
    // Every explicit start funnels through here, so this is where rung 2 of resolveStartInterval's
    // ladder gets populated for later shortcut/bulk starts. Advisory and fire-and-forget: it must
    // never fail the start. Recorded only for a sanitized interval, so a rejected value cannot
    // poison the fallback.
    recordLastUsedInterval(interval);
    let tabSettings = await getTabState(tabId);
    const currentGlobalSettings = getGlobalAppSettings();
    const alarmName = tabAlarmName(tabId);
    const jitterMode = opts.jitterMode !== undefined ? opts.jitterMode : (tabSettings.jitterMode || 'default');
    // Where the range strength comes from depends on whether the caller specified a mode:
    //  - Explicit mode (the popup always passes jitterMode): the percent comes from opts. A bare 'on'
    //    preset/custom/Start-button click carries none -> 0 -> the global %, and must NOT inherit a
    //    prior range (picking a plain preset would otherwise silently re-apply the old range).
    //  - Carried-forward mode (a shortcut toggle / bulk start / context-menu pick passes no mode): the
    //    percent is carried from tab state alongside the mode, so a stopped-then-restarted range keeps
    //    its range instead of collapsing to 'on' + 0 -> the global %. stopRefreshForTab preserves the
    //    percent expressly so this restart can find it.
    // Either way the range<->mode invariant holds: a non-zero percent only ever pairs with mode 'on'.
    const sourcePercent = opts.jitterMode !== undefined ? opts.jitterPercent : tabSettings.jitterPercent;
    const jitterPercent = sanitizeJitterPercent(jitterMode, sourcePercent);
    tabSettings = {
        ...tabSettings,
        interval: interval,
        isActive: true,
        isPaused: false,
        isCustom: opts.isCustom,
        isScheduled: false,
        soundEnabled: opts.soundEnabled !== undefined
            ? opts.soundEnabled
            : (tabSettings.soundEnabled !== undefined ? tabSettings.soundEnabled : (currentGlobalSettings.defaultSoundEnabled || false)),
        refreshMode: opts.refreshMode !== undefined ? opts.refreshMode : (tabSettings.refreshMode || 'default'),
        jitterMode: jitterMode,
        jitterPercent: jitterPercent,
        recoverMode: opts.recoverMode !== undefined ? opts.recoverMode : (tabSettings.recoverMode || 'default'),
        refreshCount: (tabSettings.isActive && tabSettings.interval === interval) ? tabSettings.refreshCount : 0,
        alarmName: alarmName
    };
    await scheduleTabRefresh(alarmName, interval, jitterMode, { jitterPercent: jitterPercent });
    await updateTabStorageAndState(tabId, tabSettings);
    await updateIcon(tabId, 'active', interval);

    // Log the timer start (best-effort; guard on tab.url since a loading tab may lack a readable url).
    if (logActivityFunc) {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.url) {
                logActivityFunc(tabId, `Timer started for ${tab.url} (Interval: ${interval}s)`);
            } else {
                logActivityFunc(tabId, `Timer started (Interval: ${interval}s)`);
            }
        } catch (error) {
            // chrome.tabs.get rejects for a missing tab; mark it closed so we stop calling its APIs.
            if (isTabNotFoundError(error)) {
                markTabAsClosed(tabId);
            }
            logActivityFunc(tabId, `Timer started (Interval: ${interval}s)`);
        }
    }

    return { ok: true, settings: tabSettings, remainingTimeForPopup: interval };
}

/**
 * Pause a tab's active refresh: snapshot the remaining time, clear the alarm, and set the paused icon.
 * Shared by message, context-menu, and keyboard-shortcut controls.
 * @param {number} tabId - Target tab id.
 * @returns {Promise<{ok: boolean, settings?: object, remainingTimeForPopup?: number}>} ok=false when
 *   the tab is not active or is already paused.
 */
export async function pauseRefreshForTab(tabId) {
    const tabSettings = await getTabState(tabId);
    if (!(tabSettings.isActive && !tabSettings.isPaused)) {
        return { ok: false };
    }
    tabSettings.isPaused = true;
    const remainingTimeForPopup = await getRemainingTimeForAlarm(tabAlarmName(tabId));
    tabSettings.remainingTimeOnPause = remainingTimeForPopup;
    // clearTabAlarms, not a bare alarms.clear, is the single teardown: removes the canonical + fallback
    // alarm AND the tab_{id}_lastArmed stamp, like stop/deactivate/close.
    await clearTabAlarms(tabId, tabSettings.alarmName);
    await updateTabStorageAndState(tabId, tabSettings);
    await updateIcon(tabId, 'paused', tabSettings.interval);
    if (logActivityFunc) {
        logActivityFunc(tabId, `Timer paused (${remainingTimeForPopup}s remaining)`);
    }
    return { ok: true, settings: tabSettings, remainingTimeForPopup };
}

/**
 * Resume a paused tab's refresh, re-arming the alarm for the time that remained at pause.
 * Shared by message, context-menu, and keyboard-shortcut controls.
 * @param {number} tabId - Target tab id.
 * @returns {Promise<{ok: boolean, settings?: object, remainingTimeForPopup?: number}>} ok=false when
 *   the tab is not active or not paused.
 */
export async function resumeRefreshForTab(tabId) {
    const tabSettings = await getTabState(tabId);
    if (!(tabSettings.isActive && tabSettings.isPaused)) {
        return { ok: false };
    }
    tabSettings.isPaused = false;
    const resumeDelaySeconds = tabSettings.remainingTimeOnPause !== undefined ?
        tabSettings.remainingTimeOnPause :
        tabSettings.interval;
    await scheduleTabRefresh(tabAlarmName(tabId), tabSettings.interval, tabSettings.jitterMode, { initialDelaySeconds: resumeDelaySeconds, jitterPercent: tabSettings.jitterPercent });
    delete tabSettings.remainingTimeOnPause;
    const remainingTimeForPopup = Math.max(Math.round(resumeDelaySeconds), 1);
    await updateTabStorageAndState(tabId, tabSettings);
    await updateIcon(tabId, 'active', tabSettings.interval);
    if (logActivityFunc) {
        logActivityFunc(tabId, `Timer resumed (Interval: ${tabSettings.interval}s)`);
    }
    return { ok: true, settings: tabSettings, remainingTimeForPopup };
}

/**
 * Stop a tab's refresh and reset it to idle, preserving the per-tab sound/refresh/jitter/recover
 * preferences. Shared by message, menu, shortcut, and bulk controls.
 * @param {number} tabId - Target tab id.
 * @returns {Promise<{settings: object}>} the reset idle state.
 */
export async function stopRefreshForTab(tabId) {
    let tabSettings = await getTabState(tabId);
    // Clear the canonical alarm unconditionally, even if the state is only partially initialized
    // (alarmName not yet written): future fires must be suppressed on a stopped tab.
    await clearTabAlarms(tabId, tabSettings.alarmName);
    tabSettings = {
        soundEnabled: tabSettings.soundEnabled,     // Preserve sound preference
        refreshMode: tabSettings.refreshMode,       // Preserve per-tab refresh mode
        jitterMode: tabSettings.jitterMode,         // Preserve per-tab jitter mode
        jitterPercent: tabSettings.jitterPercent,   // Preserve the range strength so a shortcut restart keeps the range
        recoverMode: tabSettings.recoverMode,       // Preserve per-tab auto-recovery mode
        isActive: false, isPaused: false, interval: null, refreshCount: 0, alarmName: null, isScheduled: false
    };
    await updateTabStorageAndState(tabId, tabSettings);
    await updateIcon(tabId, 'idle');
    if (logActivityFunc) {
        logActivityFunc(tabId, 'Timer stopped');
    }
    return { settings: tabSettings };
}

/**
 * Dispatch a tab-specific message: start, pause, resume, stop,
 * updateSoundSetting, updateRefreshMode, updateJitterMode, updateRecoverMode, or getTabState.
 * Re-arms or clears the per-tab alarm as needed and persists tab state. The start/pause/resume/stop
 * cases delegate to the shared startRefreshForTab/pauseRefreshForTab/resumeRefreshForTab/stopRefreshForTab
 * helpers (also used by the context menu).
 * @param {Object} request - The incoming message.
 * @param {number} tabId - The target tab id.
 * @param {Function} sendResponse - The onMessage sendResponse callback.
 * @returns {Promise<void>}
 */
async function handleTabMessage(request, tabId, sendResponse) {
    /**
     * Reply to a tab message without throwing if the message port has already closed.
     * @param {object} data - Response payload for the caller.
     * @returns {void}
     */
    const safeSendResponse = (data) => {
        try { sendResponse(data); } catch (e) { /* message port closed */ }
    };
    let tabSettings = await getTabState(tabId);
    let remainingTimeForPopup;
    const alarmName = tabAlarmName(tabId);

    switch (request.action) {
        case 'start': {
            const result = await startRefreshForTab(tabId, {
                interval: request.interval,
                isCustom: request.isCustom,
                soundEnabled: request.soundEnabled,
                refreshMode: request.refreshMode,
                jitterMode: request.jitterMode,
                jitterPercent: request.jitterPercent,
                recoverMode: request.recoverMode
            });
            if (!result.ok) {
                safeSendResponse({ status: "error", message: result.error });
                break;
            }
            safeSendResponse({ status: "started", settings: result.settings, remainingTimeForPopup: result.remainingTimeForPopup });
            break;
        }

        case 'pause': {
            const r = await pauseRefreshForTab(tabId);
            if (r.ok) safeSendResponse({ status: "paused", settings: r.settings, remainingTimeForPopup: r.remainingTimeForPopup });
            else safeSendResponse({ status: "already_paused_or_inactive" });
            break;
        }

        case 'resume': {
            const r = await resumeRefreshForTab(tabId);
            if (r.ok) safeSendResponse({ status: "resumed", settings: r.settings, remainingTimeForPopup: r.remainingTimeForPopup });
            else safeSendResponse({ status: "not_paused_or_inactive" });
            break;
        }

        case 'stop': {
            const r = await stopRefreshForTab(tabId);
            safeSendResponse({ status: "stopped", settings: r.settings });
            break;
        }

        case 'updateSoundSetting':
            tabSettings.soundEnabled = request.soundEnabled;
            await updateTabStorageAndState(tabId, tabSettings);
            safeSendResponse({ status: "sound_setting_updated", soundEnabled: request.soundEnabled });
            break;

        case 'updateRefreshMode':
            // Per-tab refresh mode can be changed regardless of active state; it is
            // read at reload time via resolveBypassCache(). 'default' inherits the global flag.
            tabSettings.refreshMode = request.refreshMode;
            await updateTabStorageAndState(tabId, tabSettings);
            safeSendResponse({ status: "refresh_mode_updated", refreshMode: request.refreshMode });
            break;

        case 'updateJitterMode':
            // Per-tab jitter mode is read at (re)schedule time via resolveJitterPercent().
            // Unlike refreshMode, jitter affects alarm TYPE (one-shot vs periodic), so an
            // active tab must be rescheduled immediately — otherwise a >=60s tab left on a
            // now-stale alarm could either fire twice or stop. Preserve the current countdown
            // by reusing the remaining time as the next delay.
            tabSettings.jitterMode = request.jitterMode;
            // Switching the mode away from 'on' clears any range percent, so a range set earlier
            // cannot silently linger behind an 'off'/'default' select (the range<->mode invariant,
            // also enforced in resolveJitterPercent). Flipping to 'on' from the popup select keeps
            // no percent — a bare 'on' is plain jitter until a range is set.
            if (request.jitterMode !== 'on') tabSettings.jitterPercent = 0;
            if (tabSettings.isActive && !tabSettings.isPaused && tabSettings.interval) {
                const remaining = await getRemainingTimeForAlarm(alarmName);
                const nextDelay = remaining > 0 ? remaining : tabSettings.interval;
                await scheduleTabRefresh(alarmName, tabSettings.interval, tabSettings.jitterMode, { initialDelaySeconds: nextDelay, jitterPercent: tabSettings.jitterPercent });
            }
            await updateTabStorageAndState(tabId, tabSettings);
            safeSendResponse({ status: "jitter_mode_updated", jitterMode: request.jitterMode });
            break;

        case 'updateRecoverMode':
            // Per-tab auto-recovery mode can be changed regardless of active state; it is read at
            // error/stuck-detection time via resolveRecoverMode(). Like refreshMode (and unlike
            // jitterMode), it does not affect the alarm type, so no reschedule is needed: only a plain
            // state write. 'default' inherits the global autoRecoverEnabled flag.
            tabSettings.recoverMode = request.recoverMode;
            await updateTabStorageAndState(tabId, tabSettings);
            safeSendResponse({ status: "recover_mode_updated", recoverMode: request.recoverMode });
            break;

        case 'getTabState':
            remainingTimeForPopup = 0;
            if (tabSettings.isActive && !tabSettings.isPaused && tabSettings.alarmName) {
                remainingTimeForPopup = await getRemainingTimeForAlarm(tabSettings.alarmName);
            } else if (tabSettings.isActive && tabSettings.isPaused) {
                remainingTimeForPopup = tabSettings.remainingTimeOnPause !== undefined ? tabSettings.remainingTimeOnPause : tabSettings.interval;
            }
            safeSendResponse({ status: "current_state", settings: tabSettings, remainingTimeForPopup });
            break;
        default: safeSendResponse({ status: "error", message: "Unknown action" });
    }
}

/**
 * Dispatch a global (non-tab) statistics message: getStatistics,
 * resetStatistics, or exportStatistics. Responds with an error if the
 * statistics collector dependency is unavailable.
 * @param {Object} request - The incoming message (may carry a `period` for getStatistics).
 * @param {Function} sendResponse - The onMessage sendResponse callback.
 * @returns {Promise<void>}
 */
async function handleGlobalMessage(request, sendResponse) {
    /**
     * Reply to a global message without throwing if the message port has already closed.
     * @param {object} data - Response payload for the caller.
     * @returns {void}
     */
    const safeSendResponse = (data) => {
        try { sendResponse(data); } catch (e) { /* message port closed */ }
    };
    if (!statisticsCollectorInstance) {
        safeSendResponse({ status: "error", message: "Statistics collector not available" });
        return;
    }

    switch (request.action) {
        case 'getStatistics':
            try {
                await statisticsCollectorInstance.ensureInitialized(); // Ensure stats storage is ready
                let stats;
                if (request.period) {
                    stats = await statisticsCollectorInstance.getStatisticsByPeriod(request.period);
                } else {
                    stats = await statisticsCollectorInstance.getStatistics();
                }

                if (stats) {
                    let bytesInUse = 0;
                    try {
                        bytesInUse = await chrome.storage.local.getBytesInUse(null);
                        if (typeof bytesInUse !== 'number' || bytesInUse < 0) {
                            bytesInUse = 0;
                        }
                    } catch (storageError) {
                        console.warn('Failed to get storage bytes:', storageError.message);
                    }
                    if (!stats.general) { stats.general = {}; }
                    stats.general.storageBytesUsed = bytesInUse;
                    stats.general.storageQuotaBytes = STORAGE_QUOTA_BYTES;
                }

                safeSendResponse({ status: "success", statistics: stats });
            } catch (error) {
                console.error('Error getting statistics in messageHandler:', error);
                safeSendResponse({ status: "error", message: "Failed to get statistics: " + error.message });
            }
            break;

        case 'resetStatistics':
            try {
                await statisticsCollectorInstance.resetStatistics();
                safeSendResponse({ status: "success", message: "Statistics reset successfully" });
            } catch (error) {
                console.error('Error resetting statistics:', error);
                safeSendResponse({ status: "error", message: "Failed to reset statistics" });
            }
            break;

        case 'exportStatistics':
            try {
                const exportData = await statisticsCollectorInstance.exportStatistics();
                safeSendResponse({ status: "success", data: exportData });
            } catch (error) {
                console.error('Error exporting statistics:', error);
                safeSendResponse({ status: "error", message: "Failed to export statistics" });
            }
            break;

        default:
            safeSendResponse({ status: "error", message: "Unknown action" });
    }
}

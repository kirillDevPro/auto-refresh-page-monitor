// tabLifecycle.js — chrome.tabs lifecycle handlers for the service worker.
// Registers onRemoved (cleanup on close) and onUpdated (navigation) listeners:
// re-applies URL-pattern scheduled refresh rules on both full page loads ('complete')
// and SPA History-API navigation (changeInfo.url with no 'complete'), distinguishes
// extension auto-refreshes from user manual reloads to decide whether to reset the
// timer, and keeps the toolbar icon/badge in sync with each tab's state.
import { loadGlobalSettings, isGlobalSettingsLoaded } from './settings.js';
import { getTabState, clearTabState, getRemainingTimeForAlarm, updateTabStorageAndState } from './state.js';
import { updateIcon, updateIconBadge, clearBadgeTimer, markTabAsClosed } from './iconController.js';
import { isTabNotFoundError } from './actionUtils.js';
import { scheduleTabRefresh, clearTabAlarms } from './alarmUtils.js';
import { tabAlarmName } from './constants.js';

// Injected from scheduler.js via initializeTabLifecycleHandlers — avoids a circular import.
let applyScheduledRefreshIfNeededFunc;

/**
 * Wire up the chrome.tabs lifecycle listeners and capture injected dependencies.
 * @param {{applyScheduledRefreshIfNeeded: function(number, string): Promise<void>}} dependencies
 *   Callbacks injected from scheduler.js to break the circular import.
 */
export function initializeTabLifecycleHandlers(dependencies) {
    applyScheduledRefreshIfNeededFunc = dependencies.applyScheduledRefreshIfNeeded;
    
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

/**
 * chrome.tabs.onRemoved handler. Immediately marks the tab as closed (to stop the
 * badge interval from hitting a dead tab) and then runs the full refresher cleanup.
 * @param {number} tabId The id of the closed tab.
 */
async function handleTabRemoved(tabId) {
    // Mark tab as closed IMMEDIATELY to prevent race conditions with intervals
    markTabAsClosed(tabId);

    try {
        await cleanupRefresher(tabId);
    } catch (error) {
        console.warn(`cleanupRefresher failed for tab ${tabId}:`, error?.message);
    }
}

/**
 * chrome.tabs.onUpdated handler. Re-applies scheduled refresh rules and syncs the
 * icon/badge across navigation events: full loads ('complete') re-apply rules and
 * reset the manual-refresh timer (auto-refreshes only clear the isAutoRefresh flag);
 * SPA History-API navigation (changeInfo.url, no 'complete') re-evaluates scheduled
 * rules against the new URL; 'loading' only refreshes the icon. "Tab not found"
 * errors are swallowed since cleanup is owned by onRemoved.
 * @param {number} tabId The updated tab's id.
 * @param {chrome.tabs.TabChangeInfo} changeInfo The change descriptor (status/url/...).
 * @param {chrome.tabs.Tab} tab The current tab object; bails out if it has no url.
 */
async function handleTabUpdated(tabId, changeInfo, tab) {
    // Check if the tab object is valid, especially its URL
    if (!tab || !tab.url) {
        return;
    }

    try {
        if (changeInfo.status === 'complete') {
            // globalAppSettings is kept fresh in-memory via the onChanged listener, so there is
            // no need to re-read it from storage on every 'complete'. But after a COLD SW start
            // (onChanged stays silent without a write) the state is still empty — load it ONCE;
            // afterwards this is a cheap synchronous flag check, with no storage read.
            if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
            if (applyScheduledRefreshIfNeededFunc) {
                await applyScheduledRefreshIfNeededFunc(tabId, tab.url);
            }

            const currentSettings = await getTabState(tabId);

            if (currentSettings && currentSettings.isActive && !currentSettings.isPaused) {
                const alarmName = currentSettings.alarmName || tabAlarmName(tabId);
                let remaining;
                if (currentSettings.isAutoRefresh) {
                    // This was an auto-refresh from the extension - just clear the flag
                    currentSettings.isAutoRefresh = false;
                    await updateTabStorageAndState(tabId, currentSettings);
                    remaining = await getRemainingTimeForAlarm(alarmName);
                } else {
                    // This was a manual refresh by the user - reset the timer (jittered when active).
                    // Read back the real (possibly jittered) alarm time so the first badge frame is accurate.
                    await scheduleTabRefresh(alarmName, currentSettings.interval, currentSettings.jitterMode, { jitterPercent: currentSettings.jitterPercent });
                    remaining = await getRemainingTimeForAlarm(alarmName);
                }
                await updateIcon(tabId, 'active', currentSettings.interval);
                updateIconBadge(tabId, currentSettings, remaining).catch(err =>
                    console.warn(`Badge update failed for tab ${tabId}:`, err.message)
                );
            } else if (currentSettings && currentSettings.isActive && currentSettings.isPaused) {
                // Use saved remainingTimeOnPause — alarm is cleared when paused, so getRemainingTimeForAlarm returns 0
                const remaining = currentSettings.remainingTimeOnPause !== undefined
                    ? currentSettings.remainingTimeOnPause
                    : (currentSettings.interval || 0);
                await updateIcon(tabId, 'paused', currentSettings.interval);
                updateIconBadge(tabId, currentSettings, remaining).catch(err =>
                    console.warn(`Badge update failed for tab ${tabId}:`, err.message)
                );
            } else if (currentSettings) {
                await updateIcon(tabId, 'idle');
                updateIconBadge(tabId, currentSettings, 0).catch(err =>
                    console.warn(`Badge update failed for tab ${tabId}:`, err.message)
                );
            }
        } else if (changeInfo.url) {
            // URL changed without a full reload (SPA History-API navigation, e.g. Home Assistant).
            // Re-check scheduled rules against the new URL: a scheduled tab that drifted onto a
            // non-matching page is deactivated immediately (and its countdown badge stops), while a
            // tab that landed on a matching page is activated — neither fires a 'complete' event.
            // Manual refreshes are unaffected: applyScheduledRefreshIfNeeded early-returns for
            // active non-scheduled tabs.
            if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
            if (applyScheduledRefreshIfNeededFunc) {
                await applyScheduledRefreshIfNeededFunc(tabId, tab.url);
            }
            const currentSettings = await getTabState(tabId);
            if (currentSettings && currentSettings.isActive) {
                await updateIcon(tabId, currentSettings.isPaused ? 'paused' : 'active', currentSettings.interval);
            } else if (currentSettings) {
                await updateIcon(tabId, 'idle');
            }
        } else if (changeInfo.status === 'loading') {
            const currentSettings = await getTabState(tabId);

            if (currentSettings && currentSettings.isActive) {
                await updateIcon(tabId, currentSettings.isPaused ? 'paused' : 'active', currentSettings.interval);
            } else if (currentSettings) {
                await updateIcon(tabId, 'idle');
            }
        }
    } catch (e) {
        // Silently ignore "tab not found" errors - cleanup is handled by onRemoved
        if (!isTabNotFoundError(e)) console.warn(`handleTabUpdated failed for tab ${tabId}:`, e.message);
    }
}

/**
 * Tear down all per-tab refresher resources: clear the canonical (and fallback) alarm,
 * stop the badge timer, drop the in-memory state, and remove the tab's storage keys
 * (tab_{id}, tab_{id}_remainingTime, tab_{id}_lastArmed). Safe to call on a
 * partially-initialized tab. Storage-removal errors are intentionally ignored.
 * @param {number} tabId The tab to clean up.
 */
export async function cleanupRefresher(tabId) {
    const tabSettings = await getTabState(tabId);

    // Clear the canonical alarm unconditionally — to cover a partially-initialized state
    // (the timer was already created but alarmName has not been persisted yet). Otherwise the
    // alarm survives the tab close and fires against a non-existent tabId.
    await clearTabAlarms(tabId, tabSettings && tabSettings.alarmName);

    clearBadgeTimer(tabId);
    clearTabState(tabId);

    try {
        await chrome.storage.local.remove([`tab_${tabId}`, `tab_${tabId}_remainingTime`, `tab_${tabId}_lastArmed`]);
    } catch (e) {
    }
}

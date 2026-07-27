// state.js — in-memory per-tab refresh-state cache (activeTabRefreshers), kept in sync with
// chrome.storage.local (tab_{id} state + tab_{id}_remainingTime). Provides read/write/clear
// helpers and the single rounding-policy source for an alarm's remaining seconds, plus a
// dependency-injected badge-update callback. Survives SW restarts via the storage mirror.
import { tabAlarmName } from './constants.js';

// In-memory cache of tab states { tabId: { settings... }}
let activeTabRefreshers = {};

// Dependencies that will be injected or imported later
let updateIconBadgeFunc;

/**
 * Inject this module's runtime dependencies (avoids circular imports).
 * @param {{updateIconBadge: function}} [dependencies] - Provides the badge-update callback used after each state write.
 */
export function initializeStateManagement(dependencies) {
    if (dependencies) {
        updateIconBadgeFunc = dependencies.updateIconBadge;
    }
}

// --- Core Timer and State Management ---

// Whole seconds until the alarm fires (never below 0); null -> 0. The single source of the
// rounding policy — used by updateTabStorageAndState, getRemainingTimeForAlarm and
// iconController.ensureBadgeTimer (which already hold the alarm, so an extra chrome.alarms.get is unneeded).
/**
 * Compute whole seconds remaining until the alarm fires, floored at 0.
 * @param {chrome.alarms.Alarm|null|undefined} alarm - The alarm; null/undefined yields 0.
 * @returns {number} Rounded seconds until scheduledTime, never negative.
 */
export function alarmRemainingSeconds(alarm) {
    return alarm ? Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 1000)) : 0;
}

/**
 * Write a tab's settings to the in-memory cache and chrome.storage.local, recompute its
 * remaining time (from the live alarm when active/unpaused, the full interval if the alarm
 * isn't created yet, or the paused remaining time), persist it, and trigger the badge update.
 * @param {number} tabId - The tab whose state is being updated.
 * @param {object} settings - The tab's refresh settings (isActive, isPaused, interval, remainingTimeOnPause, ...).
 * @returns {Promise<void>}
 */
export async function updateTabStorageAndState(tabId, settings) {
    const key = `tab_${tabId}`;
    activeTabRefreshers[tabId] = settings; // Update in-memory cache
    await chrome.storage.local.set({ [key]: settings });

    let remainingTime = 0;
    if (settings && settings.isActive && !settings.isPaused && settings.interval) {
        const alarm = await chrome.alarms.get(tabAlarmName(tabId));
        // Full interval if alarm not found (e.g., just created)
        remainingTime = alarm ? alarmRemainingSeconds(alarm) : settings.interval;
    } else if (settings && settings.isPaused && settings.remainingTimeOnPause !== undefined) {
        remainingTime = settings.remainingTimeOnPause;
    }
    await chrome.storage.local.set({ [`tab_${tabId}_remainingTime`]: remainingTime });
    
    if (updateIconBadgeFunc) {
        updateIconBadgeFunc(tabId, settings, remainingTime).catch(err =>
            console.warn(`Badge update failed for tab ${tabId}:`, err.message)
        );
    } else {
        console.warn("updateIconBadgeFunc not initialized in state.js");
    }
}

/**
 * Return a deep copy of a tab's state, reading from the in-memory cache or falling back to
 * chrome.storage.local (caching the result, or {} when absent) so SW restarts still resolve state.
 * @param {number} tabId - The tab to look up.
 * @returns {Promise<object>} A deep-cloned copy of the tab's settings (never the live cache object).
 */
export async function getTabState(tabId) {
    if (activeTabRefreshers[tabId]) {
        return JSON.parse(JSON.stringify(activeTabRefreshers[tabId])); // Return a copy
    }
    const key = `tab_${tabId}`;
    const result = await chrome.storage.local.get(key);
    activeTabRefreshers[tabId] = result[key] || {}; // Cache it
    return JSON.parse(JSON.stringify(activeTabRefreshers[tabId])); // Return a copy
}

/**
 * Look up an alarm by name and return its remaining seconds; returns 0 on any error or if absent.
 * @param {string} alarmName - The alarm name to query.
 * @returns {Promise<number>} Whole seconds until the alarm fires, or 0.
 */
export async function getRemainingTimeForAlarm(alarmName) {
    try {
        return alarmRemainingSeconds(await chrome.alarms.get(alarmName));
    } catch (e) {
    }
    return 0;
}

/**
 * Remove a tab's entry from the in-memory cache (does not touch chrome.storage.local).
 * @param {number} tabId - The tab to evict from the cache.
 */
export function clearTabState(tabId) {
    delete activeTabRefreshers[tabId];
}

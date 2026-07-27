// iconController.js - toolbar action icon/title state and per-tab badge countdown.
// Drives the action icon (idle/active/updated/paused) and title from persisted tab
// state, runs a 1s setInterval per active tab to repaint the badge countdown, tracks
// closed tab IDs to avoid Chrome API errors on removed tabs, and revives badge timers
// that died on service-worker suspension. The 1s timer also keeps the SW alive while a
// countdown is running and force-triggers an overdue alarm on each zero tick until it reloads.
import { DEFAULT_ICON_PATH, ACTIVE_ICON_PATH, UPDATED_ICON_PATH, tabAlarmName } from './constants.js';
import { getTabState, getRemainingTimeForAlarm, alarmRemainingSeconds } from './state.js';
import { resolveJitterPercent } from './settings.js';
import {
    setActionIcon,
    setActionTitle,
    setActionBadgeText,
    setActionBadgeBackgroundColor,
    isTabNotFoundError
} from './actionUtils.js';

let badgeTimers = {}; // { tabId: intervalId } for badge countdowns

// Injected callback to force-trigger an overdue alarm without waiting for keepalive.
// Wired from background.js via initializeIconController to avoid circular imports.
let forceCheckAlarmFunc = null;

// Set of closed tab IDs to prevent race conditions with intervals
const closedTabs = new Set();
const CLOSED_TABS_CLEANUP_THRESHOLD = 100; // Clean up when Set grows too large

/**
 * Wire injected dependencies into this module to avoid circular imports.
 * @param {object} dependencies
 * @param {(tabId:number)=>Promise<boolean>} [dependencies.forceCheckAlarm] - force-triggers an
 *   overdue alarm for a tab without waiting for the keepalive tick; stored in forceCheckAlarmFunc.
 * @returns {void}
 */
export function initializeIconController(dependencies) {
    if (dependencies?.forceCheckAlarm) {
        forceCheckAlarmFunc = dependencies.forceCheckAlarm;
    }
}

/**
 * Mark a tab as closed to prevent further Chrome API calls for it.
 * @param {number} tabId
 * @returns {void}
 */
export function markTabAsClosed(tabId) {
    closedTabs.add(tabId);

    // Cleanup old entries if Set grows too large
    if (closedTabs.size > CLOSED_TABS_CLEANUP_THRESHOLD) {
        const entriesToRemove = closedTabs.size - 50;
        const iterator = closedTabs.values();
        for (let i = 0; i < entriesToRemove; i++) {
            closedTabs.delete(iterator.next().value);
        }
    }
}

/**
 * Check whether a tab has been marked as closed.
 * @param {number} tabId
 * @returns {boolean}
 */
export function isTabClosed(tabId) {
    return closedTabs.has(tabId);
}

/**
 * Clear the action badge text for a tab. No-op if the tab is marked closed; swallows
 * tab-not-found errors and warns on any other failure.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function clearBadge(tabId) {
    if (isTabClosed(tabId)) return;

    try {
        await setActionBadgeText({ tabId, text: '' });
    } catch (error) {
        if (!isTabNotFoundError(error)) console.warn(`clearBadge failed for tab ${tabId}:`, error.message);
    }
}

/**
 * Set the badge text and its green countdown background color for a tab in parallel.
 * No-op if the tab is marked closed; swallows tab-not-found errors and warns otherwise.
 * @param {number} tabId
 * @param {string} text - badge text to display
 * @returns {Promise<void>}
 */
async function setBadgeWithCountdownColor(tabId, text) {
    if (isTabClosed(tabId)) return;

    try {
        await Promise.all([
            setActionBadgeText({ tabId, text }),
            setActionBadgeBackgroundColor({ tabId, color: '#2ecc71' })
        ]);
    } catch (error) {
        if (!isTabNotFoundError(error)) console.warn(`Badge countdown update failed for tab ${tabId}:`, error.message);
    }
}

/**
 * Update the action icon + title for a tab. The visual state is driven primarily by
 * the persisted tab state (isActive / isPaused) read via getTabState; the `status`
 * argument only has special handling for the literal value 'updated' (shows the
 * UPDATED icon + "Refreshed!" title). Any other value ('active' / 'idle' / 'paused'
 * or a typo) renders the active state when the tab is active and unpaused, otherwise
 * the default/idle icon. Passing status='paused' does NOT force the paused icon -
 * pause is determined by tabSettings.isPaused, not by this argument.
 *
 * @param {number} tabId
 * @param {string} [status='idle'] - only 'updated' alters output; other values leave state to tabSettings
 * @param {number} [currentInterval=0] - interval (s) shown in the title; falls back to tabSettings.interval
 * @returns {Promise<void>}
 */
export async function updateIcon(tabId, status = 'idle', currentInterval = 0) {
    // Skip if tab is known to be closed
    if (isTabClosed(tabId)) {
        return;
    }

    let iconPath = DEFAULT_ICON_PATH;
    let title = "Pages Auto Updater";

    const tabSettings = await getTabState(tabId); 

    if (tabSettings && tabSettings.isActive) {
        const intervalToDisplay = currentInterval || tabSettings.interval;
        // The tilde signals that the interval is randomized (the actual time of each cycle jumps by +/- percent).
        const tilde = resolveJitterPercent(tabSettings.jitterMode, tabSettings.jitterPercent) > 0 ? '~' : '';
        if (tabSettings.isPaused) {
            iconPath = DEFAULT_ICON_PATH;
            title = `Paused (${tilde}${intervalToDisplay}s) - Pages Auto Updater`;
        } else if (status === 'updated') {
            iconPath = UPDATED_ICON_PATH;
            title = `Refreshed! Next in ${tilde}${intervalToDisplay}s - Pages Auto Updater`;
        } else {
            iconPath = ACTIVE_ICON_PATH;
            title = `Refreshing every ${tilde}${intervalToDisplay}s - Pages Auto Updater`;
        }
    }

    try {
        await setActionIcon({ tabId, path: iconPath });
        await setActionTitle({ tabId, title });
    } catch (error) {
        if (!isTabNotFoundError(error)) console.warn(`updateIcon failed for tab ${tabId}:`, error.message);
    }
}

/**
 * Format a remaining-seconds count as compact badge text: "" for NaN/negative,
 * "Nh+" for an hour or more, otherwise zero-padded "MM:SS".
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatBadgeTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) return "";
    if (totalSeconds >= 3600) { 
        return `${Math.floor(totalSeconds / 3600)}h+`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Paint the countdown badge for a tab and (re)start its 1s countdown timer when the tab is
 * active, unpaused, and has time left. The setInterval re-reads fresh tab state and the alarm's
 * remaining time each tick, replacing any prior timer for the same tab; while the alarm is overdue
 * it holds "00:00" and on EVERY zero tick force-triggers the overdue alarm (self-limiting: a
 * successful dispatch re-arms the alarm into the future so the next tick exits the episode; guarded
 * against double-refresh by the inFlightTabs lock and handleAlarm's recentlyRefreshedTabs dedup),
 * clearing the badge after >60s at zero as a safety fallback. When the tab is closed, inactive,
 * paused, or has no time left, it stops the timer and clears the badge instead.
 * @param {number} tabId
 * @param {object} tabSettings - current per-tab state (isActive / isPaused)
 * @param {number} remainingSeconds - seconds left until the next refresh
 * @returns {Promise<void>}
 */
export async function updateIconBadge(tabId, tabSettings, remainingSeconds) {
    // Skip if tab is known to be closed
    if (isTabClosed(tabId)) {
        if (badgeTimers[tabId]) clearInterval(badgeTimers[tabId]);
        delete badgeTimers[tabId];
        return;
    }

    if (tabSettings && tabSettings.isActive && !tabSettings.isPaused && remainingSeconds > 0) {
        await setBadgeWithCountdownColor(tabId, formatBadgeTime(remainingSeconds));

        if (badgeTimers[tabId]) clearInterval(badgeTimers[tabId]);
        let zeroTickCount = 0;
        const timerId = setInterval(async () => {
            // Check if this timer is still the active one for this tab
            if (badgeTimers[tabId] !== timerId) {
                clearInterval(timerId);
                return;
            }

            // Check if tab was closed - no Chrome API call needed
            if (isTabClosed(tabId)) {
                clearInterval(timerId);
                delete badgeTimers[tabId];
                return;
            }

            try {
                const currentTabState = await getTabState(tabId);
                if (currentTabState.isActive && !currentTabState.isPaused) {
                    const currentRemaining = await getRemainingTimeForAlarm(tabAlarmName(tabId));
                    // Re-check after async operations
                    if (isTabClosed(tabId)) {
                        clearInterval(timerId);
                        delete badgeTimers[tabId];
                        return;
                    }
                    if (currentRemaining > 0) {
                        zeroTickCount = 0;
                        await setActionBadgeText({ tabId, text: formatBadgeTime(currentRemaining) });
                    } else {
                        zeroTickCount++;
                        if (zeroTickCount <= 60) {
                            // Hold "00:00" while the late alarm is forced. The running interval keeps the
                            // SW alive; paint the text only on the first zero tick to avoid redundant
                            // chrome.action calls.
                            if (zeroTickCount === 1) {
                                await setActionBadgeText({ tabId, text: '00:00' });
                            }
                            // Force the overdue alarm on EVERY zero tick (not just the first). The first
                            // zero tick usually lands with the alarm <1s overdue - below the act threshold -
                            // so a single shot would no-op and the reload would wait for Chrome's
                            // (MV3-throttled) natural delivery or the ~30s keepalive sweep (the 3-10s
                            // "stuck at 00:00" the user sees). Retrying each tick rescues it within ~1s.
                            // Self-limiting: a successful dispatch re-arms the alarm into the future, so the
                            // next tick leaves the zero-episode. Fire-and-forget; handleAlarm clears the
                            // alarm UNDER its per-tab lock and the recentlyRefreshedTabs dedup guards against
                            // a double refresh if Chrome later delivers the original alarm event.
                            if (forceCheckAlarmFunc) {
                                forceCheckAlarmFunc(tabId).catch(err =>
                                    console.warn(`Force alarm check failed for tab ${tabId}:`, err.message)
                                );
                            }
                        } else {
                            // Safety fallback: >60s at zero, something went wrong
                            if (badgeTimers[tabId] === timerId) {
                                clearInterval(timerId);
                                delete badgeTimers[tabId];
                            }
                            await clearBadge(tabId);
                        }
                    }
                } else {
                    if (badgeTimers[tabId] === timerId) {
                        clearInterval(timerId);
                        delete badgeTimers[tabId];
                    }
                    await clearBadge(tabId);
                }
            } catch (error) {
                if (badgeTimers[tabId] === timerId) {
                    clearInterval(timerId);
                    delete badgeTimers[tabId];
                }
                if (!isTabNotFoundError(error)) console.warn(`Badge countdown tick failed for tab ${tabId}:`, error.message);
            }
        }, 1000);
        badgeTimers[tabId] = timerId;

    } else {
        if (badgeTimers[tabId]) clearInterval(badgeTimers[tabId]);
        delete badgeTimers[tabId];
        await clearBadge(tabId);
    }
}

/**
 * Stop and remove the 1s badge countdown timer for a tab, if one is running.
 * @param {number} tabId
 * @returns {void}
 */
export function clearBadgeTimer(tabId) {
    if (badgeTimers[tabId]) {
        clearInterval(badgeTimers[tabId]);
        delete badgeTimers[tabId];
    }
}

/**
 * Restart a tab's 1s badge countdown timer if it is missing but the tab is still actively
 * refreshing. The setInterval in updateIconBadge dies when the SW is suspended; on a bare
 * keepalive wake (suspension below the re-bootstrap threshold, so reapplyTimersOnStartup does NOT
 * run) nothing repaints the countdown - the badge freezes/blanks while auto-refresh keeps working,
 * which reads as "broken" to the user. Called from the orphaned-alarm watchdog for tabs whose alarm
 * is still alive: recomputes remaining from the alarm and re-arms the timer. No-op when the timer is
 * already running, the tab is closed, the tab is not active/unpaused, or remaining <= 0.
 * @param {number} tabId
 * @param {object} tabSettings - current per-tab state
 * @param {object} alarm - the live chrome.alarms entry (its scheduledTime drives the countdown)
 * @returns {Promise<void>}
 */
export async function ensureBadgeTimer(tabId, tabSettings, alarm) {
    if (badgeTimers[tabId]) return;
    if (isTabClosed(tabId)) return;
    if (!tabSettings || !tabSettings.isActive || tabSettings.isPaused) return;
    const remaining = alarmRemainingSeconds(alarm);
    if (remaining > 0) {
        await updateIconBadge(tabId, tabSettings, remaining);
    }
}

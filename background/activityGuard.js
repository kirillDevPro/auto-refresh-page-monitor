/**
 * Smart-pause guards: answer the two questions the alarm handler needs before it may skip an
 * auto-refresh for "the user is busy" — (1) is the user active right now, and (2) is THIS tab the
 * one the user is actually looking at. Smart pause only suppresses the refresh of the tab in focus,
 * so a background tab the user is not viewing keeps refreshing even while they work elsewhere.
 * Deciding WHETHER to consult these guards (the global pauseWhileActiveEnabled toggle) is the
 * caller's job; this module only reports the two facts.
 *
 * isUserActive uses chrome.idle (a non-host permission declared in the manifest), whose queryState
 * reports system-wide input activity: 'active' | 'idle' | 'locked'. Only 'active' counts as busy.
 * isTabFocused uses chrome.windows.get (no permission needed beyond the manifest's `tabs`) to read
 * the focused flag of the tab's window. Both fail OPEN — any API error resolves to "not busy / not
 * focused" so a guard failure can never silently block every refresh.
 */
import { ACTIVITY_IDLE_THRESHOLD_SECONDS } from './constants.js';

/**
 * Return whether the user is currently active, i.e. has generated input within the idle threshold.
 * Fail-open: returns FALSE (treat as not active -> allow the refresh) when chrome.idle is unavailable
 * or queryState throws, so a guard failure can never silently block every refresh.
 * @returns {Promise<boolean>} true when chrome.idle reports the user as 'active'
 */
export async function isUserActive() {
    try {
        if (!chrome.idle || typeof chrome.idle.queryState !== 'function') return false;
        const state = await chrome.idle.queryState(ACTIVITY_IDLE_THRESHOLD_SECONDS);
        return state === 'active';
    } catch (e) {
        return false;
    }
}

/**
 * Return whether `tabId` is the tab the user is currently viewing: the active tab in the focused
 * Chrome window. Re-reads the tab FRESH (rather than trusting a snapshot the caller fetched earlier
 * in the same handler) so a focus/active-tab change that landed in between is honored at decision
 * time. A tab is "focused" only when it is BOTH active within its window AND that window is the
 * focused one — so when the user switches to another application (no Chrome window focused) every
 * Chrome tab refreshes freely, and a background tab the user is not looking at always refreshes.
 *
 * Fail-open: returns FALSE on any error, a missing tab, or a non-real window id (e.g. a detached
 * tab mid-drag whose windowId is chrome.windows.WINDOW_ID_NONE = -1), so a guard failure never
 * blocks the refresh. A false result simply means smart pause does not apply to this tab.
 * @param {number} tabId - Tab whose viewed/focused state to check.
 * @returns {Promise<boolean>} true when the tab is the active tab of the focused window
 */
export async function isTabFocused(tabId) {
    try {
        if (!chrome.windows || typeof chrome.windows.get !== 'function') return false;
        const tab = await chrome.tabs.get(tabId);
        if (!tab || tab.active !== true) return false;
        // WINDOW_ID_NONE is -1 (a valid number), so guard on a positive id, not on typeof.
        if (!Number.isInteger(tab.windowId) || tab.windowId <= 0) return false;
        const win = await chrome.windows.get(tab.windowId);
        return win != null && win.focused === true;
    } catch (e) {
        return false;
    }
}

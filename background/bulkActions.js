/**
 * Bulk apply / clear auto-refresh across many tabs at once — every tab in a window, or every tab in
 * the active tab's group.
 *
 * Reuses the shared start/stop helpers from messageHandler.js one-way (like contextMenu.js and
 * commands.js): a service worker cannot message its own onMessage listener, so these are in-process
 * calls. This module is NEVER imported by messageHandler.js — background.js injects BULK_ACTIONS and
 * handleBulkMessage into setupMessageHandler, keeping the import graph acyclic (the DI pattern the
 * whole background/ package uses to avoid circular imports).
 *
 * Two invariants worth stating:
 *  - GLOBAL ceiling, not per-action: a bulk start counts the live refresh alarms and fills only the
 *    remaining MAX_ACTIVE_REFRESH_TABS capacity, so two starts in a row cannot sum past the ceiling.
 *    It never evicts an existing timer. STOP is uncapped — stopping only reduces load.
 *  - One interval for the whole batch: a bulk start resolves ONE interval via resolveStartInterval
 *    (rungs 2-3, since there is no single tab to read rung 1 from). Per-tab resolution would give a
 *    single action N different intervals, which is incoherent.
 */
import { startRefreshForTab, stopRefreshForTab } from './messageHandler.js';
import { getTabState } from './state.js';
import { isRefreshableUrl } from './scheduler.js';
import { resolveStartInterval } from './startInterval.js';
import { ensureGlobalSettingsLoaded } from './settings.js';
import { isTabNotFoundError } from './actionUtils.js';
import { TAB_ALARM_PREFIX, MAX_ACTIVE_REFRESH_TABS } from './constants.js';

/** Bulk apply/clear across the current window. */
const BULK_START_WINDOW = 'bulkStartWindow';
const BULK_STOP_WINDOW = 'bulkStopWindow';
/** Bulk apply/clear across the active tab's group. */
const BULK_START_GROUP = 'bulkStartGroup';
const BULK_STOP_GROUP = 'bulkStopGroup';
/** Single-button toggle used by the popup group control and the keyboard shortcut. */
const BULK_TOGGLE_GROUP = 'bulkToggleGroup';

/**
 * Message actions this module handles. Exported so background.js can hand it to setupMessageHandler
 * for dispatch without messageHandler.js importing this module (which would be a cycle).
 * @type {Set<string>}
 */
export const BULK_ACTIONS = new Set([BULK_START_WINDOW, BULK_STOP_WINDOW, BULK_START_GROUP, BULK_STOP_GROUP, BULK_TOGGLE_GROUP]);

/**
 * Serializes bulk-START admission (the capacity count + the arming loop) so overlapping starts cannot
 * each observe the same free capacity and both fill it, busting MAX_ACTIVE_REFRESH_TABS.
 *
 * The service worker is single-threaded but interleaves at every await, so two bulk starts — a shortcut
 * toggling one window while the popup starts another, or two windows — would otherwise race between
 * countActiveRefreshTimers() and arming, each seeing the pre-fill count and each arming up to the
 * ceiling (a full 2x breach). A module-level promise chain (the pattern StatisticsCollector uses for
 * its writes) makes each start wait for the previous to finish counting + arming, so the second sees
 * the first's alarms. STOP is never serialized — it only reduces load. The chain is reset to a resolved
 * promise after each run so one throw cannot wedge it.
 * @type {Promise<unknown>}
 */
let startAdmissionChain = Promise.resolve();

/**
 * Count the refresh timers currently armed, across all tabs.
 *
 * Each running (non-paused) refresh timer owns exactly one `refresh_tab_<id>` alarm, so the alarm
 * count is the live-timer count without walking per-tab storage. Used to enforce the global ceiling.
 * Fails safe to the ceiling (blocks further starts) rather than 0 on an alarms error.
 * @returns {Promise<number>} Number of armed refresh alarms.
 */
async function countActiveRefreshTimers() {
    try {
        const alarms = await chrome.alarms.getAll();
        return alarms.filter((a) => typeof a.name === 'string' && a.name.startsWith(TAB_ALARM_PREFIX)).length;
    } catch (error) {
        console.warn('bulkActions: could not count active timers, assuming full', error);
        return MAX_ACTIVE_REFRESH_TABS;
    }
}

/**
 * A tab belongs to a real group only when its groupId is a non-negative integer.
 *
 * chrome.tabs.query treats a negative groupId (TAB_GROUP_ID_NONE = -1) as "match EVERY ungrouped tab in
 * EVERY window", so every group-scoped action guards on this first to avoid fanning out catastrophically.
 * @param {*} groupId
 * @returns {boolean}
 */
function isRealGroupId(groupId) {
    return Number.isInteger(groupId) && groupId >= 0;
}

/**
 * Read whether a tab currently has a running (active, non-paused) refresh timer.
 * @param {number} tabId - Tab id.
 * @returns {Promise<boolean>} true if the tab's state is active and not paused.
 */
async function isTabRunning(tabId) {
    try {
        const s = await getTabState(tabId);
        return !!(s && s.isActive && !s.isPaused);
    } catch (error) {
        return false;
    }
}

/**
 * Serialize a bulk-start request behind earlier admission runs.
 *
 * The chained operation delegates the capacity count and sequential arming to
 * admitAndArmEligibleTabs, and a rejected run does not wedge later requests.
 * @param {chrome.tabs.Tab[]} eligible - Refreshable http(s) tabs in scope.
 * @param {number} interval - The one interval to arm every started tab with.
 * @returns {Promise<{started: number, failed: number, capped: number}>}
 */
async function startEligibleTabs(eligible, interval) {
    // Run the count+arm critical section one-at-a-time against every other bulk start (see
    // startAdmissionChain), so two overlapping starts cannot both spend the same ceiling capacity.
    const run = startAdmissionChain.then(() => admitAndArmEligibleTabs(eligible, interval));
    startAdmissionChain = run.catch(() => {});
    return run;
}

/**
 * The serialized critical section of a bulk start: count the live timers, take only the remaining
 * global capacity (already-running tabs never draw capacity, so repeating the action keeps making
 * progress), and arm sequentially. Only ever runs one-at-a-time via startEligibleTabs's chain.
 * @param {chrome.tabs.Tab[]} eligible - Refreshable http(s) tabs in scope.
 * @param {number} interval - The one interval to arm every started tab with.
 * @returns {Promise<{started: number, failed: number, capped: number}>}
 */
async function admitAndArmEligibleTabs(eligible, interval) {
    // Only tabs without a running timer draw down capacity; already-running ones are left as-is. The
    // running-checks are independent per-tab reads, so run them concurrently before the sequential arm.
    const running = await Promise.all(eligible.map((tab) => isTabRunning(tab.id)));
    const needStart = eligible.filter((_, i) => !running[i]);
    const active = await countActiveRefreshTimers();
    const capacity = Math.max(0, MAX_ACTIVE_REFRESH_TABS - active);
    const toStart = needStart.slice(0, capacity);
    const capped = needStart.length - toStart.length;

    let started = 0;
    let failed = 0;
    for (const tab of toStart) {
        try {
            const result = await startRefreshForTab(tab.id, { interval, isCustom: false });
            if (result && result.ok) started++;
            else failed++;
        } catch (error) {
            if (!isTabNotFoundError(error)) console.warn('bulkActions: start failed for tab', tab.id, error);
            failed++;
        }
    }
    return { started, failed, capped };
}

/**
 * Stop refresh on every active tab in a scope, including paused tabs and regardless of URL.
 *
 * Unlike start, stop must NOT filter by isRefreshableUrl: a tab that started on an http page and then
 * navigated to chrome:// still has a live timer, and "stop all" must reach it. Uncapped, best-effort
 * per tab; only tabs whose state is active are counted as stopped.
 * @param {chrome.tabs.Tab[]} tabs - All scoped tabs (raw query result, not URL-filtered).
 * @returns {Promise<{stopped: number, failed: number}>}
 */
async function stopTabs(tabs) {
    let stopped = 0;
    let failed = 0;
    for (const tab of tabs) {
        if (!Number.isInteger(tab.id) || tab.id <= 0) continue;
        try {
            const s = await getTabState(tab.id);
            if (!(s && s.isActive)) continue; // nothing to stop
            await stopRefreshForTab(tab.id);
            stopped++;
        } catch (error) {
            if (!isTabNotFoundError(error)) console.warn('bulkActions: stop failed for tab', tab.id, error);
            failed++;
        }
    }
    return { stopped, failed };
}

/**
 * Resolve a usable windowId. The popup passes its active tab's windowId explicitly; this guards the
 * case where it is missing or invalid, resolving the active tab's window rather than letting
 * chrome.tabs.query({windowId: undefined}) fan out to EVERY window. Never uses {currentWindow:true},
 * which in a service worker means the last-focused window and can drift after a focus change.
 * @param {*} windowId - The requested window id, possibly undefined.
 * @returns {Promise<number|null>} A concrete window id, or null when none can be resolved.
 */
async function resolveWindowId(windowId) {
    if (Number.isInteger(windowId)) return windowId;
    try {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return active && Number.isInteger(active.windowId) ? active.windowId : null;
    } catch (error) {
        console.warn('bulkActions: could not resolve the active window', error);
        return null;
    }
}

/**
 * Partition a raw tab list into the refreshable (http/https) ones and a skipped count.
 * @param {chrome.tabs.Tab[]} tabs - Raw query result.
 * @returns {{eligible: chrome.tabs.Tab[], skipped: number, total: number}}
 */
function partitionEligible(tabs) {
    const eligible = tabs.filter((t) => Number.isInteger(t.id) && t.id > 0 && isRefreshableUrl(t.url));
    return { eligible, skipped: tabs.length - eligible.length, total: tabs.length };
}

/**
 * Start auto-refresh on every refreshable tab of a window.
 * @param {number} requestedWindowId - The requested window id; resolved when omitted or invalid.
 * @returns {Promise<{scope: string, started: number, skipped: number, failed: number, capped: number, total: number}>}
 */
async function bulkStartWindow(requestedWindowId) {
    if (!(await ensureGlobalSettingsLoaded('bulkActions'))) return { scope: 'window', started: 0, skipped: 0, failed: 0, capped: 0, total: 0 };
    const windowId = await resolveWindowId(requestedWindowId);
    if (windowId === null) return { scope: 'window', started: 0, skipped: 0, failed: 0, capped: 0, total: 0 };
    const tabs = await chrome.tabs.query({ windowId });
    const { eligible, skipped, total } = partitionEligible(tabs);
    const interval = await resolveStartInterval(null);
    const { started, failed, capped } = await startEligibleTabs(eligible, interval);
    return { scope: 'window', started, skipped, failed, capped, total };
}

/**
 * Stop auto-refresh on every active tab of a window, regardless of its current URL.
 * @param {number} requestedWindowId - The requested window id; resolved when omitted or invalid.
 * @returns {Promise<{scope: string, stopped: number, failed: number, total: number}>}
 */
async function bulkStopWindow(requestedWindowId) {
    const windowId = await resolveWindowId(requestedWindowId);
    if (windowId === null) return { scope: 'window', stopped: 0, failed: 0, total: 0 };
    const tabs = await chrome.tabs.query({ windowId });
    // Stop considers EVERY scoped tab, not just refreshable ones: a running timer on a tab that
    // navigated to chrome:// must still be stopped.
    const { stopped, failed } = await stopTabs(tabs);
    return { scope: 'window', stopped, failed, total: tabs.length };
}

/**
 * Start auto-refresh on every refreshable tab of a tab group.
 *
 * groupId is read natively from chrome.tabs.query under the already-granted "tabs" permission; the
 * tabGroups permission is deliberately NOT requested (it carries an install-time warning that would
 * disable the published extension for existing users). Guards BEFORE querying: a negative groupId is
 * TAB_GROUP_ID_NONE, and chrome.tabs.query({groupId: -1}) would match every ungrouped tab in every
 * window — applying to that is the catastrophe this guard exists to prevent.
 * @param {number} groupId - The active tab's group id.
 * @returns {Promise<object>} A window-shaped result, or {ineligible:true} when the tab is ungrouped.
 */
async function bulkStartGroup(groupId) {
    if (!isRealGroupId(groupId)) {
        return { scope: 'group', ineligible: true };
    }
    if (!(await ensureGlobalSettingsLoaded('bulkActions'))) return { scope: 'group', started: 0, skipped: 0, failed: 0, capped: 0, total: 0 };
    const tabs = await chrome.tabs.query({ groupId });
    const { eligible, skipped, total } = partitionEligible(tabs);
    const interval = await resolveStartInterval(null);
    const { started, failed, capped } = await startEligibleTabs(eligible, interval);
    return { scope: 'group', started, skipped, failed, capped, total };
}

/**
 * Stop auto-refresh on every active tab of a tab group, regardless of its current URL.
 * @param {number} groupId - The active tab's group id.
 * @returns {Promise<object>} A window-shaped result, or {ineligible:true} when the tab is ungrouped.
 */
async function bulkStopGroup(groupId) {
    if (!isRealGroupId(groupId)) {
        return { scope: 'group', ineligible: true };
    }
    const tabs = await chrome.tabs.query({ groupId });
    // Stop considers every scoped tab regardless of URL (see bulkStopWindow).
    const { stopped, failed } = await stopTabs(tabs);
    return { scope: 'group', stopped, failed, total: tabs.length };
}

/**
 * Decide whether a bulk toggle over a tab set should start or stop: stop if any scoped tab is active,
 * otherwise start. Considers every scoped tab regardless of URL, including paused tabs.
 * @param {chrome.tabs.Tab[]} tabs - All scoped tabs.
 * @returns {Promise<boolean>} true if at least one scoped tab is currently active.
 */
async function anyActive(tabs) {
    for (const tab of tabs) {
        if (!Number.isInteger(tab.id) || tab.id <= 0) continue;
        try {
            const s = await getTabState(tab.id);
            if (s && s.isActive) return true;
        } catch (error) {
            // A tab that vanished mid-check simply doesn't count as active.
        }
    }
    return false;
}

/**
 * Toggle auto-refresh across a window. Stops all if any scoped tab is active, else starts all.
 * Returns the same result shape as the explicit start/stop actions.
 * @param {number} windowId - The window to toggle (the active tab's window).
 * @returns {Promise<object>}
 */
export async function bulkToggleWindow(windowId) {
    const resolved = await resolveWindowId(windowId);
    if (resolved === null) return { scope: 'window', started: 0, skipped: 0, failed: 0, capped: 0, total: 0 };
    const tabs = await chrome.tabs.query({ windowId: resolved });
    return (await anyActive(tabs)) ? bulkStopWindow(resolved) : bulkStartWindow(resolved);
}

/**
 * Toggle auto-refresh across the active tab's group.
 * @param {number} groupId - The active tab's group id.
 * @returns {Promise<object>}
 */
export async function bulkToggleGroup(groupId) {
    if (!isRealGroupId(groupId)) {
        return { scope: 'group', ineligible: true };
    }
    const tabs = await chrome.tabs.query({ groupId });
    return (await anyActive(tabs)) ? bulkStopGroup(groupId) : bulkStartGroup(groupId);
}

/**
 * Dispatch a bulk message to the matching action. Called from the injected branch in
 * setupMessageHandler; window fallback resolution is handled by the window-scoped operations.
 * @param {object} request - { action, windowId?, groupId? }.
 * @returns {Promise<object|null>} The bulk result object, or null for an unknown action.
 */
export async function handleBulkMessage(request) {
    switch (request.action) {
        case BULK_START_WINDOW: return bulkStartWindow(request.windowId);
        case BULK_STOP_WINDOW: return bulkStopWindow(request.windowId);
        case BULK_START_GROUP: return bulkStartGroup(request.groupId);
        case BULK_STOP_GROUP: return bulkStopGroup(request.groupId);
        case BULK_TOGGLE_GROUP: return bulkToggleGroup(request.groupId);
        default: return null;
    }
}

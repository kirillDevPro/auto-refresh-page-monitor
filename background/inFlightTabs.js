/**
 * Shared per-tab "reload in flight" lock.
 *
 * A single source of truth so every code path that reloads a tab is serialized against the others:
 * the normal refresh alarm (alarmHandler.handleAlarm) and every recovery reload (navigationRecovery's
 * alarm delivery, stuck-load sweep, and reconnect acceleration all funnel through doRecoveryReload).
 * Without one shared lock a recovery reload triggered directly (not via the alarm dispatcher) could race
 * a normal refresh or another recovery for the same tab and cause a duplicate/aborted reload.
 *
 * tryAcquireTab is atomic in JS's single-threaded model (the has()+add() pair has no await between them),
 * so two interleaved async callers cannot both acquire the same tab.
 */

const inFlight = new Set();

/**
 * Try to mark a tab as having a reload in flight.
 * @param {number} tabId
 * @returns {boolean} true if the lock was acquired (caller must release it), false if already held.
 */
export function tryAcquireTab(tabId) {
    if (inFlight.has(tabId)) return false;
    inFlight.add(tabId);
    return true;
}

/**
 * Release a tab's in-flight lock. Safe to call even if not held.
 * @param {number} tabId
 * @returns {void}
 */
export function releaseTab(tabId) {
    inFlight.delete(tabId);
}

/**
 * Whether a tab currently has a reload in flight.
 * @param {number} tabId
 * @returns {boolean}
 */
export function isTabInFlight(tabId) {
    return inFlight.has(tabId);
}

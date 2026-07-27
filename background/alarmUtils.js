/**
 * Provides service-worker alarm scheduling and teardown helpers.
 *
 * scheduleAlarm wraps chrome.alarms creation with verification, scheduleTabRefresh is the single
 * refresh-alarm arming entry point, and clearTabAlarms removes refresh and recovery records for a
 * stopped tab. Refresh alarms are periodic only for intervals >= 60 seconds without jitter.
 */
import { tabAlarmName, recoverAlarmName, clampInterval, TAB_ALARM_PREFIX } from './constants.js';
import { resolveJitterPercent } from './settings.js';
import { applyJitter } from './jitter.js';

/**
 * Clear a tab's refresh alarms: the canonical `refresh_tab_<tabId>` and, if it
 * differs, a previously-recorded alarm name. Idempotent and best-effort:
 * clearing a non-existent alarm is a no-op and clear failures never abort teardown.
 * Shared by stop / scheduled-deactivation / tab-close cleanup paths. Also removes the
 * `tab_{tabId}_lastArmed` stamp from `chrome.storage.local` so the orphan watchdog
 * (`checkAndRearmOrphanedAlarms`) does not re-arm a deliberately stopped tab, AND tears down any
 * auto-recovery state (the `recover_tab_<id>` alarm + the `tab_{id}_recovery` / `tab_{id}_loadStartedAt`
 * keys written by navigationRecovery.js) so a stopped/closed tab leaves no pending recovery reload.
 *
 * @param {number} tabId - id of the tab whose alarms should be cleared
 * @param {string} [knownAlarmName] - previously-recorded alarm name (tabSettings.alarmName)
 * @returns {Promise<void>}
 */
export async function clearTabAlarms(tabId, knownAlarmName) {
    const canonical = tabAlarmName(tabId);
    try {
        await chrome.alarms.clear(canonical);
    } catch (e) {
        // best-effort: a clear failure must not abort teardown
    }
    if (knownAlarmName && knownAlarmName !== canonical) {
        try {
            await chrome.alarms.clear(knownAlarmName);
        } catch (e) {
            // best-effort
        }
    }
    // Tear down the auto-recovery state too. navigationRecovery.js owns these keys but must not be
    // imported here because it imports alarmUtils, so the dependency stays one-way.
    // the pending recovery alarm and the retry/stuck-marker records. Otherwise a stop/close could leave
    // a recover_tab_<id> alarm that later reloads a tab the user already stopped.
    try {
        await chrome.alarms.clear(recoverAlarmName(tabId));
    } catch (e) {
        // Best-effort storage cleanup; stop/close teardown must continue.
    }
    // Also remove the last-armed timestamp (written by scheduleTabRefresh, read by the
    // checkAndRearmOrphanedAlarms watchdog) and the recovery records (tab_{id}_recovery / _loadStartedAt).
    try {
        await chrome.storage.local.remove([
            `tab_${tabId}_lastArmed`,
            `tab_${tabId}_recovery`,
            `tab_${tabId}_loadStartedAt`
        ]);
    } catch (e) {
        // best-effort
    }
}

/**
 * Create (or re-create) a single alarm, returning whether it is periodic. Clears any existing
 * alarm of the same name first, then verifies registration with one retry. Periodic
 * (periodInMinutes) only when intervalSeconds >= 60 AND options.oneShot is falsy; otherwise the
 * alarm is one-shot and the caller must reschedule on each fire.
 *
 * @param {string} alarmName
 * @param {number} intervalSeconds - nominal interval; also the periodInMinutes basis when periodic
 * @param {object} [options]
 * @param {number} [options.initialDelaySeconds] - delay until first fire (default = intervalSeconds), floored at 1s
 * @param {boolean} [options.oneShot] - force a one-shot alarm even for intervals >= 60s (jitter path)
 * @returns {Promise<boolean>} true if the created alarm is periodic (intervalSeconds >= 60 && !oneShot)
 */
export async function scheduleAlarm(alarmName, intervalSeconds, options = {}) {
    const defaultDelay = intervalSeconds || 0;
    const configuredDelay = options.initialDelaySeconds !== undefined ? options.initialDelaySeconds : defaultDelay;
    const safeDelaySeconds = Math.max(Number(configuredDelay) || 0, 1); // enforce at least 1 second
    const delayInMinutes = Math.max(safeDelaySeconds / 60, 1 / 60);

    const alarmOptions = { delayInMinutes };
    // Periodic alarm for >=60s unless the caller requires one-shot. Jitter needs a fresh
    // random period on every fire; a fixed periodInMinutes cannot do that, so jittered
    // alarms are always one-shot and rescheduled manually.
    if (intervalSeconds >= 60 && !options.oneShot) {
        alarmOptions.periodInMinutes = intervalSeconds / 60;
    }

    // Clear existing alarm first to avoid race conditions
    await chrome.alarms.clear(alarmName);
    await chrome.alarms.create(alarmName, alarmOptions);

    // Verify the alarm actually registered. If not, retry the create once and warn; otherwise
    // the caller assumes the timer is armed when it is not.
    let alarm = await chrome.alarms.get(alarmName);
    if (!alarm) {
        await new Promise(resolve => setTimeout(resolve, 50));
        alarm = await chrome.alarms.get(alarmName);
        if (!alarm) {
            await chrome.alarms.create(alarmName, alarmOptions);
            alarm = await chrome.alarms.get(alarmName);
            if (!alarm) {
                console.warn(`scheduleAlarm: alarm "${alarmName}" failed to register after retry`);
            }
        }
    }

    return intervalSeconds >= 60 && !options.oneShot;
}

/**
 * Schedule (or reschedule) a tab's refresh alarm, applying interval jitter when the
 * tab/rule's jitterMode resolves to a non-zero percent. With jitter active the alarm is
 * always one-shot (a fixed periodInMinutes can't vary the period), so callers on the
 * reload path must reschedule on each fire. The alarm is created with the jittered delay,
 * so the badge/popup countdown, which read alarm.scheduledTime, stay accurate.
 *
 * Side effect: for any alarmName prefixed with `TAB_ALARM_PREFIX`, writes `tab_{id}_lastArmed`
 * (ms timestamp) to `chrome.storage.local`. Read by the orphan watchdog
 * (`checkAndRearmOrphanedAlarms`) to tell a genuinely lost alarm from a tab in the normal
 * fire->re-arm gap (grace = interval*1.5s + 10s).
 *
 * @param {string} alarmName
 * @param {number} intervalSeconds - nominal interval, clamped to [MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS] before use (base for jitter, dedup, badge)
 * @param {('default'|'on'|'off'|undefined)} jitterMode
 * @param {{initialDelaySeconds?: number, jitterPercent?: number}} [options] - initialDelaySeconds,
 *        when set, is used as the delay verbatim (not jittered), e.g. resume's remaining time; jitter
 *        still forces one-shot so the next fire reschedules with a fresh offset. jitterPercent is the
 *        per-item strength from an interval RANGE, honored only when jitterMode === 'on'.
 * @returns {Promise<boolean>} true if the created alarm is periodic.
 */
export async function scheduleTabRefresh(alarmName, intervalSeconds, jitterMode, options = {}) {
    // Clamp at the single arming chokepoint: guards against a non-numeric/out-of-bounds
    // interval from ANY path (e.g. a scheduled rule from an imported profile bypasses
    // sanitizeInterval). Otherwise NaN>=60 === false would create a one-shot that never
    // reschedules after its first fire (NaN<60 === false too) and the timer dies silently.
    const interval = clampInterval(intervalSeconds);
    const percent = resolveJitterPercent(jitterMode, options.jitterPercent);
    const delay = options.initialDelaySeconds !== undefined
        ? options.initialDelaySeconds
        : applyJitter(interval, percent);
    // Write the last-armed stamp BEFORE arming. Single chokepoint — every path funnels here
    // (start/scheduled/resume/finalizeAfterFire/reapply/jitter-mode). Before arming, because
    // otherwise if the SW died in the gap between chrome.alarms.create and the stamp write, an
    // active tab would be left WITHOUT a stamp, and the watchdog (checkAndRearmOrphanedAlarms)
    // would skip it on !lastArmed (and a warm wake below the threshold does not run reapply).
    // Via this stamp the watchdog distinguishes "just armed / mid re-arm" from "long gone"
    // (grace = interval*1.5 + 10s), so it does not fight the normal fire->re-arm cycle.
    if (alarmName.startsWith(TAB_ALARM_PREFIX)) {
        const tabId = alarmName.slice(TAB_ALARM_PREFIX.length);
        try {
            await chrome.storage.local.set({ [`tab_${tabId}_lastArmed`]: Date.now() });
        } catch (e) {
            // best-effort: on a write failure the prior stamp (from the previous arming) remains
            // and stays valid for the watchdog. If there is no stamp at all, the watchdog skips the
            // tab; an orphan without a stamp is handled by reapplyTimersOnStartup on cold start.
        }
    }
    return scheduleAlarm(alarmName, interval, {
        initialDelaySeconds: delay,
        oneShot: percent > 0,
    });
}


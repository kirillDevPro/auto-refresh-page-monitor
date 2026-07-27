/**
 * Centralizes service-worker constants for icons, sounds, logs, storage quota, refresh interval
 * bounds, jitter bounds, smart-pause idle thresholds, alarm names, recovery tuning, lifecycle
 * timing, and interval clamping.
 */
/**
 * Default toolbar icon paths used when a tab is idle or has no active refresh state.
 * @type {Record<string, string>}
 */
export const DEFAULT_ICON_PATH = { 
    "16": "../icons/icon16.png", 
    "32": "../icons/icon32.png", 
    "48": "../icons/icon48.png" 
};
/**
 * Toolbar icon paths used while a tab has an active refresh timer.
 * @type {Record<string, string>}
 */
export const ACTIVE_ICON_PATH = { 
    "16": "../icons/icon16_active.png", 
    "32": "../icons/icon32_active.png", 
    "48": "../icons/icon48_active.png" 
};
/**
 * Toolbar icon paths shown briefly after an extension-triggered refresh.
 * @type {Record<string, string>}
 */
export const UPDATED_ICON_PATH = { 
    "16": "../icons/icon16_updated.png", 
    "32": "../icons/icon32_updated.png", 
    "48": "../icons/icon48_updated.png" 
};

/** Notification sound path resolved from offscreen.html. */
export const SOUND_FILE = '../sounds/notification.wav';
/** Maximum number of activity-log entries kept in storage. */
export const MAX_LOG_ENTRIES = 200;
/** Chrome local-storage quota used by graduated statistics cleanup. */
export const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;

/**
 * Minimum allowed refresh interval in seconds.
 *
 * In a PACKED extension Chrome ignores delayInMinutes/periodInMinutes < 0.5
 * (the alarm floor is 30 seconds, Chrome 120+) and clamps them to 30s. Intervals shorter
 * than this value physically cannot fire more often in the published build, so the
 * UI/validation must not offer them. Single source of truth for the lower bound.
 */
export const MIN_INTERVAL_SECONDS = 30;
/** Maximum allowed refresh interval in seconds (24 hours), matching the largest preset. */
export const MAX_INTERVAL_SECONDS = 86400;

/**
 * Fallback interval in seconds for NON-INTERACTIVE start paths only (keyboard shortcuts, bulk
 * actions) — never for the popup, which resolves from its own live DOM (typed value / highlighted
 * preset) that the service worker cannot see.
 *
 * Last rung of resolveStartInterval()'s ladder when no usable tab or stored interval is available.
 * Deliberately NOT MIN_INTERVAL_SECONDS: a shortcut fires with no confirmation
 * and no visible dialog, so defaulting to the 30s floor would let one keystroke hammer a site at the
 * fastest rate the extension allows. 60s is twice the floor and equals INTERVAL_PRESETS[1], so a
 * shortcut-started tab opens the popup with the "1 minute" preset already highlighted instead of
 * looking like no preset is selected.
 */
export const DEFAULT_START_INTERVAL_SECONDS = 60;

/**
 * Global ceiling on simultaneously running refresh timers.
 *
 * Enforced by the bulk-apply actions (start-all-in-window / start-all-in-group), NOT per action: two
 * consecutive bulk starts must not be able to sum past this. Every running timer costs one 1s
 * setInterval in iconController plus a per-tab getTabState + chrome.alarms.get on every ~30s
 * keepalive sweep, on a service worker whose whole premise is that it gets suspended — so an
 * unbounded bulk start is a real resource hazard. A bulk start counts the live refresh alarms and
 * only fills the remaining capacity; it never evicts an existing timer, and STOP is never capped
 * (stopping only reduces load). Not a hard cap on manual single-tab starts, which stay the user's
 * explicit choice one tab at a time.
 */
export const MAX_ACTIVE_REFRESH_TABS = 30;

/**
 * Sentinel groupId for a tab that belongs to no tab group.
 *
 * Mirrors chrome.tabGroups.TAB_GROUP_ID_NONE (-1) without importing the tabGroups API, which this
 * extension deliberately does not use (its permission carries an install-time warning). A negative
 * groupId must never be passed to chrome.tabs.query({groupId}) — that would match every ungrouped
 * tab in every window.
 */
export const TAB_GROUP_ID_NONE = -1;

/**
 * Defensive clamp for ANY interval that reaches the alarm scheduler (e.g. a corrupted
 * interval from an imported scheduled rule that slipped past sanitizeInterval). Non-number -> MIN;
 * otherwise round and clamp into [MIN, MAX]. Unlike messageHandler.sanitizeInterval (which
 * REJECTS bad input up front by returning null), this never returns null - a bad value is made
 * safe so the timer still arms and does not die as a one-shot after the first fire.
 * @param {*} raw - Raw interval value (seconds), possibly non-finite or corrupted.
 * @returns {number} Interval in seconds, rounded and clamped to [MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS].
 */
export function clampInterval(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return MIN_INTERVAL_SECONDS;
    return Math.min(Math.max(Math.round(n), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
}

/**
 * Default interval-randomization strength, in percent.
 *
 * Single source of truth for the background jitter default; UI trees keep their own copy.
 */
export const DEFAULT_JITTER_PERCENT = 20;
/**
 * Maximum interval-randomization strength accepted by the background scheduler, in percent.
 *
 * UI trees keep their own copy of this bound, as they do for MIN_INTERVAL_SECONDS.
 */
export const MAX_JITTER_PERCENT = 100;

/**
 * chrome.idle.queryState threshold used by smart pause, in seconds.
 *
 * When the user is "active" a refresh skips its cycle so an auto-reload never disrupts active work.
 * The user counts as active if input was detected within this many seconds. Must stay >= 15 because
 * Chrome's idle API rejects lower thresholds; 60s means "skip the refresh if mouse or keyboard input
 * happened in the last minute".
 */
export const ACTIVITY_IDLE_THRESHOLD_SECONDS = 60;

/** Alarm names for service-worker lifecycle management. */
export const ALARM_NAMES = {
    KEEPALIVE: 'pau_keepalive'
};

/**
 * Prefix for per-tab refresh alarms.
 *
 * Single source of truth for producers and the parser (slice/startsWith) in alarmHandler.
 */
export const TAB_ALARM_PREFIX = 'refresh_tab_';
/**
 * Build the canonical refresh alarm name for a tab.
 * @param {number|string} tabId - Tab id to encode in the alarm name.
 * @returns {string} Alarm name in the `refresh_tab_<id>` namespace.
 */
export const tabAlarmName = (tabId) => `${TAB_ALARM_PREFIX}${tabId}`;

/**
 * Prefix for per-tab recovery alarms.
 *
 * Recovery alarms are one-shot backoff timers armed when a monitored tab's load fails
 * (webNavigation.onErrorOccurred) or hangs. A namespace separate from refresh alarms prevents
 * collisions; alarmHandler parses it with the same slice/startsWith pattern.
 */
export const RECOVER_ALARM_PREFIX = 'recover_tab_';
/**
 * Build the canonical recovery alarm name for a tab.
 * @param {number|string} tabId - Tab id to encode in the alarm name.
 * @returns {string} Alarm name in the `recover_tab_<id>` namespace.
 */
export const recoverAlarmName = (tabId) => `${RECOVER_ALARM_PREFIX}${tabId}`;

/**
 * Auto-recovery backoff schedule in seconds.
 *
 * Auto-recovery is an opt-in feature gated by the optional webNavigation permission. For the Nth
 * failed or stuck load of a tab, recovery waits SCHEDULE[N - 1] before the next reload; after the
 * schedule is exhausted it keeps retrying at the last value (every 30 minutes). Each delay gets a
 * small jitter and every value stays at or above the 30s packed-build alarm floor.
 * @type {number[]}
 */
export const RECOVERY_BACKOFF_SCHEDULE_SECONDS = [30, 60, 120, 300, 600, 1800];
/**
 * Percent jitter applied to each recovery backoff delay so many tabs failing at once do not reload
 * together. applyJitter floors the result at MIN_INTERVAL_SECONDS.
 */
export const RECOVERY_BACKOFF_JITTER_PERCENT = 15;
/**
 * Seconds after which a committed main-frame load without completion or error is treated as hung.
 *
 * The keepalive stuck-load sweep uses this threshold to arm recovery. It is above the 30s alarm floor
 * and keepalive tick.
 */
export const STUCK_LOAD_TIMEOUT_SECONDS = 45;

/**
 * Keepalive alarm period in minutes.
 *
 * 30 seconds is the effective minimum: in a packed extension Chrome clamps alarm periods
 * < 0.5 min to 30s, so a smaller value here is meaningless. A periodic alarm does not keep
 * the service worker alive between fires; it only wakes it up to run the handler.
 */
export const KEEPALIVE_INTERVAL_MINUTES = 0.5;
/**
 * Service-worker suspension threshold in milliseconds.
 *
 * 35s is just above MIN_INTERVAL_SECONDS=30, so sleep long enough to drop a 30-second one-shot alarm
 * triggers a re-bootstrap (reapplyTimersOnStartup). A higher threshold misses 31-59s sleeps where a
 * consumed one-shot was not restored until the next cold start.
 */
export const SUSPENSION_THRESHOLD_MS = 35000;
/** Consecutive keepalive failures allowed before lifecycle code performs a full reset. */
export const MAX_KEEPALIVE_FAILURES = 3;

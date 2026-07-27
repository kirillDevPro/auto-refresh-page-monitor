/**
 * Owns global application settings for the service worker.
 *
 * Small preferences are stored in chrome.storage.sync.globalSettings, large rule lists are stored
 * in chrome.storage.local.globalLists, and the in-memory settings object is the merge. This module
 * also provides the single decision points for cache mode, interval jitter, and auto-recovery mode;
 * smart pause is a global-only flag read directly by the alarm handler.
 */
import { DEFAULT_JITTER_PERCENT, MAX_JITTER_PERCENT } from './constants.js';

/**
 * Build a fresh default global-settings object with newly allocated arrays.
 * Used as the initial in-memory value and the fresh-install seed. Degraded storage reads start from
 * this object but force pauseWhileActiveEnabled off before returning.
 * @returns {object} a new default settings object
 */
function makeDefaultGlobalSettings() {
    return {
        theme: 'auto',
        defaultSoundEnabled: false,
        bypassCacheOnRefresh: false,
        intervalJitterEnabled: true,
        intervalJitterPercent: DEFAULT_JITTER_PERCENT,
        autoRecoverEnabled: false,
        pauseWhileActiveEnabled: true,
        whitelist: [],
        blacklist: [],
        scheduledRefreshes: []
    };
}

/**
 * Global settings keys stored in chrome.storage.sync.globalSettings.
 *
 * Keep this byte-identical to settings/settings.global.js; divergence routes a field to the wrong
 * store and breaks migration/saving. Large lists are intentionally excluded because sync has an
 * 8KB-per-item limit.
 * @type {string[]}
 */
const SYNC_KEYS = ['theme', 'language', 'defaultSoundEnabled', 'autoRestoreTimers', 'bypassCacheOnRefresh', 'intervalJitterEnabled', 'intervalJitterPercent', 'autoRecoverEnabled', 'pauseWhileActiveEnabled'];
/**
 * Global settings keys stored in chrome.storage.local.globalLists.
 *
 * These lists can exceed the chrome.storage.sync item limit and are merged with SYNC_KEYS in memory.
 * @type {string[]}
 */
const LOCAL_KEYS = ['whitelist', 'blacklist', 'scheduledRefreshes'];
/**
 * Return a new object containing only the given keys of `obj` that are defined.
 * Used to partition the merged in-memory settings into the sync vs local subsets.
 * @param {object} obj source object
 * @param {string[]} keys keys to copy when their value is not undefined
 * @returns {object} a new object with the selected, defined keys
 */
function pickKeys(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}

// Stores the global application settings (merged sync prefs + local rule lists)
let globalAppSettings = makeDefaultGlobalSettings();
// true after the first successful load. Consumers (tabLifecycle) need it to tell whether
// the in-memory state has warmed up after a SW cold start (onChanged stays silent without a write).
let settingsLoaded = false;
/**
 * Report whether global settings have been loaded into memory at least once.
 * Consumers gate on this after a SW cold start, since storage.onChanged does not
 * fire without a write and the in-memory object is otherwise still the seed defaults.
 * @returns {boolean} true once loadGlobalSettings has succeeded
 */
export function isGlobalSettingsLoaded() {
    return settingsLoaded;
}

/**
 * Load global settings from storage and merge them into the in-memory object.
 * Reads sync prefs (globalSettings) and local rule lists (globalLists), runs the one-time
 * legacy-lists migration out of sync into local, applies fresh-install-vs-upgrade defaults
 * for intervalJitterEnabled, theme, and autoRecoverEnabled, seeds defaults into both stores on
 * first run, and sets settingsLoaded. Smart pause (pauseWhileActiveEnabled) deliberately has no
 * upgrade guard - it defaults ON for everyone. On degraded reads it falls back to defaults but
 * forces pauseWhileActiveEnabled off so refreshes are not silently skipped.
 * @returns {Promise<object>} the merged in-memory globalAppSettings
 */
export async function loadGlobalSettings() {
    try {
        const syncData = await chrome.storage.sync.get('globalSettings');
        let localData = await chrome.storage.local.get('globalLists');
        const syncPart = syncData.globalSettings || {};

        // Migration: previously EVERYTHING (including the large lists) lived in sync.globalSettings
        // and ran into the 8KB-per-item limit. If the lists are not in local yet, move them from
        // the legacy sync object into local.globalLists and strip them from sync (freeing quota).
        if (!localData.globalLists) {
            const legacyLists = pickKeys(syncPart, LOCAL_KEYS);
            if (Object.keys(legacyLists).length > 0) {
                await chrome.storage.local.set({ globalLists: legacyLists });
                localData = { globalLists: legacyLists };
                await chrome.storage.sync.set({ globalSettings: pickKeys(syncPart, SYNC_KEYS) });
                console.log("Migrated rule lists from sync to local storage");
            }
        }

        const listsPart = localData.globalLists || {};
        globalAppSettings = { ...makeDefaultGlobalSettings(), ...pickKeys(syncPart, SYNC_KEYS), ...listsPart };

        // Jitter defaults ON only for FRESH installs. Existing users (settings saved before this
        // feature, so no intervalJitterEnabled key) keep their prior no-jitter behavior - don't
        // silently flip their refresh timing on update.
        if (syncData.globalSettings && !('intervalJitterEnabled' in syncPart)) {
            globalAppSettings.intervalJitterEnabled = false;
        }

        // Theme 'auto' (follow the OS) is the default for FRESH installs only. Existing users whose
        // settings were saved before the 'auto' option existed (no theme key) stay on 'dark', so an
        // update never changes their look. Same migration shape as jitter.
        if (syncData.globalSettings && !('theme' in syncPart)) {
            globalAppSettings.theme = 'dark';
        }

        // Auto-recovery stays OFF for existing users (settings saved before this feature, so no
        // autoRecoverEnabled key) - an update must never silently start reloading their tabs on a
        // failed load, and never trigger the runtime webNavigation permission prompt unasked. Same
        // migration shape as jitter/theme. Fresh installs already get false from makeDefaultGlobalSettings.
        if (syncData.globalSettings && !('autoRecoverEnabled' in syncPart)) {
            globalAppSettings.autoRecoverEnabled = false;
        }

        // Smart pause defaults ON for EVERYONE - fresh installs AND existing users (product decision).
        // Unlike jitter/theme/auto-recover above, there is deliberately NO upgrade guard here: an
        // existing user with no pauseWhileActiveEnabled key inherits the `true` from the defaults merge.

        // First run (nothing stored yet) - seed defaults into both stores.
        if (!syncData.globalSettings && !localData.globalLists) {
            await chrome.storage.sync.set({ globalSettings: pickKeys(globalAppSettings, SYNC_KEYS) });
            await chrome.storage.local.set({ globalLists: pickKeys(globalAppSettings, LOCAL_KEYS) });
        }
        settingsLoaded = true;
        console.log("Global settings loaded/initialized in background/settings.js:", globalAppSettings);
    } catch (error) {
        console.error("Error loading global settings:", error);
        // Fallback to defaults on a degraded read. Although smart pause now defaults ON for everyone,
        // force it OFF on a FAILED load: when settings are unreadable the fail-safe for the refresh core
        // is to KEEP refreshing rather than silently skip cycles while the user is active (a skip writes
        // no activity-log entry, so it would look like the extension stopped working). settingsLoaded
        // stays false, so a later successful load restores the real ON value.
        globalAppSettings = makeDefaultGlobalSettings();
        globalAppSettings.pauseWhileActiveEnabled = false;
    }
    return globalAppSettings;
}

/**
 * Return a deep copy of the current in-memory global settings.
 * Cloned via JSON so callers can mutate the result without affecting module state.
 * @returns {object} a deep copy of globalAppSettings
 */
export function getGlobalAppSettings() {
    return JSON.parse(JSON.stringify(globalAppSettings));
}

/**
 * Resolve the effective bypassCache (hard reload) flag for a tab or scheduled rule.
 * Tri-state refreshMode: 'hard' forces a cache-bypassing reload (Ctrl+Shift+R),
 * 'normal' forces a cached reload, and 'default'/undefined falls back to the global
 * bypassCacheOnRefresh setting (the "default for new tabs/rules").
 * @param {('default'|'hard'|'normal'|undefined)} itemMode
 * @returns {boolean}
 */
export function resolveBypassCache(itemMode) {
    if (itemMode === 'hard') return true;
    if (itemMode === 'normal') return false;
    return globalAppSettings.bypassCacheOnRefresh === true;
}

/**
 * Resolve the effective interval-jitter percent for a tab or scheduled rule.
 * Tri-state jitterMode mirrors refreshMode: 'on' forces jitter, 'off' disables it,
 * 'default'/undefined inherits the global intervalJitterEnabled toggle. Returns the
 * configured strength, clamped to MAX_JITTER_PERCENT, when active; otherwise returns 0. A positive
 * per-item percent overrides the global strength only when itemMode is explicitly 'on'.
 * @param {('default'|'on'|'off'|undefined)} itemMode
 * @param {number} [itemPercent] - Per-item strength from a range; used only when itemMode === 'on'.
 * @returns {number} jitter percent (0 = no jitter)
 */
export function resolveJitterPercent(itemMode, itemPercent) {
    const active = itemMode === 'on' ||
        (itemMode !== 'off' && globalAppSettings.intervalJitterEnabled === true);
    if (!active) return 0;
    // A per-item range percent wins over the global strength, but only under an explicit 'on'
    // (sanitizeJitterPercent enforces that pairing); otherwise fall back to the global strength.
    const item = sanitizeJitterPercent(itemMode, itemPercent);
    const pct = item > 0 ? item : Number(globalAppSettings.intervalJitterPercent);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.min(pct, MAX_JITTER_PERCENT);
}

/**
 * Validate a per-item interval-range strength for storage and scheduling.
 * @param {('default'|'on'|'off'|undefined)} mode - The item's jitter mode.
 * @param {*} percent - The raw per-item percent (from a range), possibly undefined/NaN.
 * @returns {number} The positive finite percent when mode is 'on'; otherwise 0.
 */
export function sanitizeJitterPercent(mode, percent) {
    const p = Number(percent);
    return mode === 'on' && Number.isFinite(p) && p > 0 ? p : 0;
}

/**
 * Ensure global settings are loaded before a cold-worker caller arms a tab. A failed settings read
 * leaves the loaded flag false so the caller can abort instead of using seed defaults.
 * @param {string} contextLabel - Short caller tag for the degraded-read warning.
 * @returns {Promise<boolean>} true if settings are usable; false if the caller should abort arming.
 */
export async function ensureGlobalSettingsLoaded(contextLabel) {
    if (isGlobalSettingsLoaded()) return true;
    await loadGlobalSettings();
    if (!isGlobalSettingsLoaded()) {
        console.warn(`${contextLabel}: global settings unavailable (degraded read); aborting`);
        return false;
    }
    return true;
}

/**
 * Resolve whether auto-recovery (reload a monitored tab whose load failed/hung) is active for a
 * tab or scheduled rule. Tri-state recoverMode mirrors refreshMode/jitterMode: 'on' forces it,
 * 'off' disables it, 'default'/undefined inherits the global autoRecoverEnabled toggle. The
 * navigationRecovery module reads this at error/stuck-detection time. Note this only decides
 * intent; recovery additionally requires the optional webNavigation permission to be granted,
 * without which no navigation listeners are registered.
 * @param {('default'|'on'|'off'|undefined)} itemMode
 * @returns {boolean}
 */
export function resolveRecoverMode(itemMode) {
    if (itemMode === 'on') return true;
    if (itemMode === 'off') return false;
    return globalAppSettings.autoRecoverEnabled === true;
}

/**
 * Merge newSettings into the in-memory globalAppSettings (e.g. from a message).
 * Does not persist anything; writing to sync (prefs) and local (lists) is the caller's job.
 * No-op when newSettings is falsy.
 * @param {object} newSettings partial settings to shallow-merge over the current state
 * @returns {void}
 */
export function updateGlobalAppSettings(newSettings) {
    if (newSettings) {
        globalAppSettings = { ...globalAppSettings, ...newSettings };
        console.log("In-memory globalAppSettings updated in background/settings.js:", globalAppSettings);
    }
}


/**
 * Register a chrome.storage.onChanged listener that incrementally re-merges global settings.
 * Sync changes to `globalSettings` update the SYNC_KEYS half; local changes to `globalLists`
 * update the LOCAL_KEYS half without clobbering the other half. Invokes the callback with
 * the updated settings whenever either half changed (e.g. edits from the options page).
 * @param {(settings: object) => void} onSettingsChangedCallback called after a change is merged
 * @returns {void}
 */
export function setupGlobalSettingsListener(onSettingsChangedCallback) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        // Prefs change in sync.globalSettings, lists in local.globalLists.
        // Merge incrementally, without clobbering the "other half" of the state.
        let changed = false;
        if (namespace === 'sync' && changes.globalSettings) {
            globalAppSettings = { ...globalAppSettings, ...pickKeys(changes.globalSettings.newValue || {}, SYNC_KEYS) };
            changed = true;
        }
        if (namespace === 'local' && changes.globalLists) {
            globalAppSettings = { ...globalAppSettings, ...pickKeys(changes.globalLists.newValue || {}, LOCAL_KEYS) };
            changed = true;
        }
        if (changed) {
            console.log("Global settings changed, reloaded in background/settings.js.");
            if (onSettingsChangedCallback) {
                onSettingsChangedCallback(globalAppSettings);
            }
        }
    });
}

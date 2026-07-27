/**
 * Manages the options page General tab and its hybrid-stored global settings.
 *
 * Holds the in-memory globalSettings object, loads and saves sync preferences plus local rule lists,
 * resolves the display theme, populates language choices, and wires controls for sound, auto-restore,
 * cache bypass, interval jitter, auto-recovery, smart pause, and language.
 */
import { setLanguage, getCurrentLanguage, showLanguageChangeNotification, getAvailableLanguages, t } from './chromeI18n.js';
import { showToast } from './modal.js';
import { confirmAndRequestWebNavigation, hasWebNavigationPermission } from './permissions.js';

/**
 * In-memory copy of the merged global settings used by the options page.
 *
 * Small preferences are saved to sync.globalSettings and large rule lists are saved to
 * local.globalLists. Fresh installs default interval jitter and smart pause on, while existing-user
 * migrations in loadGlobalSettings can turn them off when their keys are absent.
 * @type {Object}
 */
export let globalSettings = {
    theme: 'auto', // 'auto' = follow the system theme (default for fresh installs)
    language: null, // Interface language (null = auto-detect)
    defaultSoundEnabled: false,
    autoRestoreTimers: true, // Auto-restart timers after a browser restart
    bypassCacheOnRefresh: false, // Hard refresh (bypassing the cache), off by default.
    intervalJitterEnabled: true, // Interval randomization, on by default for fresh installs.
    intervalJitterPercent: 20, // Jitter strength, % (duplicate of DEFAULT_JITTER_PERCENT from background/constants.js)
    autoRecoverEnabled: false, // Auto-recover a tab whose load failed or hung; opt-in and needs webNavigation.
    pauseWhileActiveEnabled: true, // Skip a refresh while the user is active (chrome.idle); on by default for everyone.
    whitelist: [],
    blacklist: [],
    scheduledRefreshes: [] // This will be managed by scheduledRefreshes.js but initialized here
};

/**
 * Global settings keys stored in chrome.storage.sync.globalSettings.
 *
 * Keep this identical to background/settings.js so every preference is saved and migrated through
 * the same storage area in both module trees.
 * @type {string[]}
 */
const SYNC_KEYS = ['theme', 'language', 'defaultSoundEnabled', 'autoRestoreTimers', 'bypassCacheOnRefresh', 'intervalJitterEnabled', 'intervalJitterPercent', 'autoRecoverEnabled', 'pauseWhileActiveEnabled'];
/**
 * Global settings keys stored in chrome.storage.local.globalLists because they can exceed sync quota.
 * @type {string[]}
 */
const LOCAL_KEYS = ['whitelist', 'blacklist', 'scheduledRefreshes'];
/**
 * Return a shallow copy of obj containing only the given keys whose value is defined.
 * @param {Object} obj - Source object.
 * @param {string[]} keys - Keys to keep (SYNC_KEYS or LOCAL_KEYS).
 * @returns {Object} New object with the selected, defined keys.
 */
function pickKeys(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}

/**
 * Resolve the effective display theme. 'auto' follows the OS color scheme
 * (prefers-color-scheme); 'light'/'dark' are returned as-is.
 * Intentionally duplicated in popup/ui.js - popup and settings are separate
 * module trees and deliberately share no code; keep both copies in sync.
 * @param {('auto'|'light'|'dark')} theme
 * @returns {('light'|'dark')}
 */
function resolveTheme(theme) {
    if (theme === 'auto') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
}

// --- DOM Elements (passed as arguments or direct access if module handles them) ---
// These will be passed to functions that need them from settings.js initially

// --- Populate Language Select ---
/**
 * Fill a language <select> with the available interface languages, preserving
 * the currently selected value across the rebuild. No-op if the element is null.
 * @param {HTMLSelectElement|null} languageSelect
 * @returns {void}
 */
function populateLanguageSelect(languageSelect) {
    if (!languageSelect) return;

    // Save the currently selected language
    const currentValue = languageSelect.value;

    // Clear the existing options
    languageSelect.innerHTML = '';

    // Get the available languages and create the options
    const availableLanguages = getAvailableLanguages();
    availableLanguages.forEach(lang => {
        const option = document.createElement('option');
        option.value = lang.code;
        option.textContent = lang.name;
        languageSelect.appendChild(option);
    });
    
    // Restore the selected language
    if (currentValue) {
        languageSelect.value = currentValue;
    }
}

// --- Load Initial Settings ---
/**
 * Load globalSettings from hybrid storage and apply it to the General-tab UI.
 * Merges sync.globalSettings (small prefs) with local.globalLists (rule lists),
 * running a one-time migration that moves legacy lists out of sync into local.
 * Applies existing-user migrations so jitter and smart pause default on only for fresh
 * installs, theme 'auto' applies only to fresh installs, and auto-recovery stays off unless
 * explicitly enabled. Then
 * reflects every value onto the passed-in DOM controls and invokes the two
 * injected render callbacks. DOM/callback arguments are optional (null-guarded).
 * @param {HTMLSelectElement} [themeSelect]
 * @param {HTMLInputElement} [globalSoundNotificationCheckbox]
 * @param {HTMLInputElement} [autoRestoreTimersCheckbox]
 * @param {HTMLInputElement} [bypassCacheOnRefreshCheckbox]
 * @param {HTMLTextAreaElement} [whitelistUrlsTextarea]
 * @param {HTMLTextAreaElement} [blacklistUrlsTextarea]
 * @param {Function} [renderScheduledRefreshesFunc] - Re-renders the scheduled-refresh list.
 * @param {Function} [loadActivityLogFunc] - Loads the activity log.
 * @param {HTMLSelectElement|null} [languageSelect]
 * @param {HTMLInputElement|null} [intervalJitterEnabledCheckbox]
 * @param {HTMLElement|null} [intervalJitterPercentButtons] - Container of .jitter-percent-btn presets.
 * @param {HTMLInputElement|null} [autoRecoverEnabledCheckbox] - Global auto-recovery on/off toggle.
 * @param {HTMLInputElement|null} [pauseWhileActiveEnabledCheckbox] - Global smart-pause on/off toggle.
 * @returns {Promise<void>}
 */
export async function loadGlobalSettings(
    themeSelect,
    globalSoundNotificationCheckbox,
    autoRestoreTimersCheckbox,
    bypassCacheOnRefreshCheckbox,
    whitelistUrlsTextarea,
    blacklistUrlsTextarea,
    renderScheduledRefreshesFunc, // Function to call
    loadActivityLogFunc,         // Function to call
    languageSelect = null,       // Language select element
    intervalJitterEnabledCheckbox = null,  // Jitter on/off toggle
    intervalJitterPercentButtons = null,   // Jitter strength (%) preset buttons container
    autoRecoverEnabledCheckbox = null,     // Auto-recovery on/off toggle
    pauseWhileActiveEnabledCheckbox = null // Smart-pause on/off toggle
) {
    // Hybrid storage: small prefs in sync.globalSettings (cross-device), large
    // rule lists in local.globalLists (sync is limited to 8KB per item). Merge both parts.
    // On the first run after an update, move legacy lists out of sync into local.
    const syncData = await chrome.storage.sync.get('globalSettings');
    let localData = await chrome.storage.local.get('globalLists');
    const syncPart = syncData.globalSettings || {};
    if (!localData.globalLists) {
        const legacyLists = pickKeys(syncPart, LOCAL_KEYS);
        if (Object.keys(legacyLists).length > 0) {
            await chrome.storage.local.set({ globalLists: legacyLists });
            localData = { globalLists: legacyLists };
            await chrome.storage.sync.set({ globalSettings: pickKeys(syncPart, SYNC_KEYS) });
        }
    }
    const listsPart = localData.globalLists || {};
    globalSettings = {
        ...globalSettings,                    // Default structure
        ...pickKeys(syncPart, SYNC_KEYS),     // Synced prefs
        // Ensure arrays are always arrays even if loaded data is missing them
        whitelist: listsPart.whitelist || [],
        blacklist: listsPart.blacklist || [],
        scheduledRefreshes: listsPart.scheduledRefreshes || []
    };

    // Same rule as background/settings.js: jitter on by default only for fresh installs; existing
    // users (no intervalJitterEnabled key yet) stay off so the toggle reflects their real state.
    if (syncData.globalSettings && !('intervalJitterEnabled' in syncPart)) {
        globalSettings.intervalJitterEnabled = false;
    }

    // Same migration as in background/settings.js: theme 'auto' is the default only
    // for fresh installs; existing users with no theme key stay on 'dark' so an update
    // does not change their appearance.
    if (syncData.globalSettings && !('theme' in syncPart)) {
        globalSettings.theme = 'dark';
    }

    // Same migration as in background/settings.js: auto-recovery stays off for existing users (no
    // autoRecoverEnabled key) so an update neither starts reloading their tabs nor prompts for the
    // webNavigation permission unasked. Fresh installs default to false too.
    if (syncData.globalSettings && !('autoRecoverEnabled' in syncPart)) {
        globalSettings.autoRecoverEnabled = false;
    }

    // Smart pause defaults ON for EVERYONE (fresh installs and existing users alike) by product
    // decision: unlike jitter/theme/auto-recover above, there is deliberately NO migration guard here,
    // so an existing user with no pauseWhileActiveEnabled key inherits the `true` default.

    if (themeSelect) themeSelect.value = globalSettings.theme;
    document.body.classList.toggle('dark-theme', resolveTheme(globalSettings.theme) === 'dark');
    if (globalSoundNotificationCheckbox) globalSoundNotificationCheckbox.checked = globalSettings.defaultSoundEnabled || false;
    if (autoRestoreTimersCheckbox) autoRestoreTimersCheckbox.checked = globalSettings.autoRestoreTimers !== false; // Default true
    if (bypassCacheOnRefreshCheckbox) bypassCacheOnRefreshCheckbox.checked = globalSettings.bypassCacheOnRefresh === true; // Default false
    if (intervalJitterEnabledCheckbox) intervalJitterEnabledCheckbox.checked = globalSettings.intervalJitterEnabled === true; // On for fresh installs; existing users migrated to off
    // Reflect the auto-recover checkbox as checked only when the setting is on AND the optional
    // webNavigation permission is actually granted. Otherwise recovery is inert (no listeners registered),
    // so showing it "on" would lie - e.g. when autoRecoverEnabled synced from another device where the
    // permission was granted, or the user revoked it in chrome://extensions. Display-only: the stored
    // value is left untouched (mutating it would fight cross-device sync); re-checking re-requests it.
    if (autoRecoverEnabledCheckbox) {
        autoRecoverEnabledCheckbox.checked = globalSettings.autoRecoverEnabled === true && (await hasWebNavigationPermission());
    }
    // Smart pause needs no extra permission (chrome.idle is declared in the manifest), so the checkbox
    // simply reflects the stored flag. On by default for everyone (no migration guard).
    if (pauseWhileActiveEnabledCheckbox) pauseWhileActiveEnabledCheckbox.checked = globalSettings.pauseWhileActiveEnabled === true;
    if (intervalJitterPercentButtons) {
        const jitterPct = Number(globalSettings.intervalJitterPercent ?? 20);
        intervalJitterPercentButtons.querySelectorAll('.jitter-percent-btn').forEach(btn => {
            btn.classList.toggle('active', Number(btn.dataset.percent) === jitterPct);
        });
    }
    if (whitelistUrlsTextarea) whitelistUrlsTextarea.value = (globalSettings.whitelist || []).join('\n');
    if (blacklistUrlsTextarea) blacklistUrlsTextarea.value = (globalSettings.blacklist || []).join('\n');
    
    // Populate the language dropdown and set the selected language
    if (languageSelect) {
        populateLanguageSelect(languageSelect);
        const savedLanguage = globalSettings.language || getCurrentLanguage();
        languageSelect.value = savedLanguage;
    }

    if (renderScheduledRefreshesFunc) renderScheduledRefreshesFunc();
    if (loadActivityLogFunc) loadActivityLogFunc();
}

/**
 * Persist globalSettings to hybrid storage (sync prefs + local lists) and notify
 * the background service worker. On a write failure shows an error toast and
 * returns false instead of falsely reporting success.
 * @returns {Promise<boolean>} true on a successful write, false on failure.
 */
export async function saveAndApplyGlobalSettings() {
    try {
        // Split write: small prefs to sync (cross-device), lists to local (no 8KB limit).
        await chrome.storage.sync.set({ globalSettings: pickKeys(globalSettings, SYNC_KEYS) });
        await chrome.storage.local.set({ globalLists: pickKeys(globalSettings, LOCAL_KEYS) });
    } catch (error) {
        console.error('Failed to save global settings:', error);
        showToast(`${t('settings_save_error')}: ${error.message}`, 'error');
        return false;
    }
    chrome.runtime.sendMessage({ action: 'globalSettingsUpdated', newSettings: globalSettings })
        .catch(() => { /* Background is still asleep or has no listener; onChanged will pick up the change. */ });
    console.log("Global settings saved and background notified:", globalSettings);
    return true;
}

/**
 * Attach change handlers to every General-tab control. Each handler updates the
 * in-memory globalSettings and calls saveAndApplyGlobalSettings(). Also registers
 * a prefers-color-scheme listener that live-updates the body theme while theme==='auto',
 * lazily populates the language select, and reloads the interface language on change.
 * All arguments are optional and null-guarded.
 * @param {HTMLSelectElement} [themeSelect]
 * @param {HTMLInputElement} [globalSoundNotificationCheckbox]
 * @param {HTMLInputElement} [autoRestoreTimersCheckbox]
 * @param {HTMLInputElement} [bypassCacheOnRefreshCheckbox]
 * @param {HTMLSelectElement|null} [languageSelect]
 * @param {HTMLInputElement|null} [intervalJitterEnabledCheckbox]
 * @param {HTMLElement|null} [intervalJitterPercentButtons] - Container of .jitter-percent-btn presets.
 * @param {HTMLInputElement|null} [autoRecoverEnabledCheckbox] - Global auto-recovery toggle (requests the webNavigation permission when checked).
 * @param {HTMLInputElement|null} [pauseWhileActiveEnabledCheckbox] - Global smart-pause toggle (no extra permission needed).
 * @returns {void}
 */
export function setupGeneralSettingsHandlers(themeSelect, globalSoundNotificationCheckbox, autoRestoreTimersCheckbox, bypassCacheOnRefreshCheckbox, languageSelect = null, intervalJitterEnabledCheckbox = null, intervalJitterPercentButtons = null, autoRecoverEnabledCheckbox = null, pauseWhileActiveEnabledCheckbox = null) {
    if (themeSelect) {
        themeSelect.addEventListener('change', () => {
            globalSettings.theme = themeSelect.value;
            document.body.classList.toggle('dark-theme', resolveTheme(globalSettings.theme) === 'dark');
            saveAndApplyGlobalSettings();
        });
        // Live reaction to a system theme change - only while the 'auto' mode is selected.
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (globalSettings.theme === 'auto') {
                document.body.classList.toggle('dark-theme', resolveTheme('auto') === 'dark');
            }
        });
    }
    if (globalSoundNotificationCheckbox) {
        globalSoundNotificationCheckbox.addEventListener('change', () => {
            globalSettings.defaultSoundEnabled = globalSoundNotificationCheckbox.checked;
            saveAndApplyGlobalSettings();
        });
    }
    if (autoRestoreTimersCheckbox) {
        autoRestoreTimersCheckbox.addEventListener('change', () => {
            globalSettings.autoRestoreTimers = autoRestoreTimersCheckbox.checked;
            saveAndApplyGlobalSettings();
        });
    }
    if (bypassCacheOnRefreshCheckbox) {
        bypassCacheOnRefreshCheckbox.addEventListener('change', () => {
            globalSettings.bypassCacheOnRefresh = bypassCacheOnRefreshCheckbox.checked;
            saveAndApplyGlobalSettings();
        });
    }
    if (intervalJitterEnabledCheckbox) {
        intervalJitterEnabledCheckbox.addEventListener('change', () => {
            globalSettings.intervalJitterEnabled = intervalJitterEnabledCheckbox.checked;
            saveAndApplyGlobalSettings();
        });
    }
    if (autoRecoverEnabledCheckbox) {
        autoRecoverEnabledCheckbox.addEventListener('change', async () => {
            if (autoRecoverEnabledCheckbox.checked) {
                // Enabling the feature needs the optional webNavigation permission. Show an explanation
                // dialog first (what the permission is and why), then request it from within that
                // dialog's Enable-button gesture. If the user cancels or declines, revert the checkbox.
                const granted = await confirmAndRequestWebNavigation();
                if (!granted) {
                    autoRecoverEnabledCheckbox.checked = false;
                    showToast(t('recover_permission_denied'), 'info');
                    return;
                }
            }
            // Unchecking leaves the granted permission in place; recovery simply stops
            // running because no rule/tab resolves to on.
            globalSettings.autoRecoverEnabled = autoRecoverEnabledCheckbox.checked;
            saveAndApplyGlobalSettings();
        });
    }
    if (pauseWhileActiveEnabledCheckbox) {
        // Smart pause needs no permission prompt - chrome.idle is a manifest permission. A plain toggle.
        pauseWhileActiveEnabledCheckbox.addEventListener('change', () => {
            globalSettings.pauseWhileActiveEnabled = pauseWhileActiveEnabledCheckbox.checked;
            saveAndApplyGlobalSettings();
        });
    }
    if (intervalJitterPercentButtons) {
        // Preset percent buttons (no free entry): one active at a time, picks intervalJitterPercent.
        intervalJitterPercentButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('.jitter-percent-btn');
            if (!btn) return;
            const pct = Number(btn.dataset.percent);
            if (!Number.isFinite(pct)) return;
            globalSettings.intervalJitterPercent = pct;
            intervalJitterPercentButtons.querySelectorAll('.jitter-percent-btn').forEach(b =>
                b.classList.toggle('active', b === btn));
            saveAndApplyGlobalSettings();
        });
    }
    if (languageSelect) {
        // Populate the language list if it is not filled yet
        if (languageSelect.children.length === 0) {
            populateLanguageSelect(languageSelect);
            const savedLanguage = globalSettings.language || getCurrentLanguage();
            languageSelect.value = savedLanguage;
        }
        
        languageSelect.addEventListener('change', async () => {
            const newLanguage = languageSelect.value;
            globalSettings.language = newLanguage;
            
            // Set the new language
            await setLanguage(newLanguage);

            // Save the settings
            await saveAndApplyGlobalSettings();

            // Show the language-change notification
            showLanguageChangeNotification();
        });
    }
}

/**
 * Return a deep copy of globalSettings, or of a single key's value if provided.
 * Uses JSON round-trip, so values must be JSON-serializable.
 * @param {string} [key] - Optional setting key to read.
 * @returns {Object|*|undefined} Deep copy of the whole object, or of the keyed value; undefined when the key's value is absent or falsy.
 */
export function getGlobalSettings(key) {
    if (key) {
        return globalSettings[key] ? JSON.parse(JSON.stringify(globalSettings[key])) : undefined;
    }
    return JSON.parse(JSON.stringify(globalSettings)); // Return a copy
}

/**
 * Replace the in-memory globalSettings object wholesale (used by profile import).
 * Stores the reference directly - no copy is made.
 * @param {Object} newSettings - The full settings object to set.
 * @returns {void}
 */
export function setGlobalSettings(newSettings) {
    globalSettings = newSettings;
}

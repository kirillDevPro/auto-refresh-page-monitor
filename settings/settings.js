/**
 * Orchestrates the options page after DOMContentLoaded.
 *
 * Queries settings-page DOM elements, coalesces storage-change reloads for sync prefs and local
 * rule lists, loads global settings, initializes i18n and sub-modules, and installs global
 * scheduled-refresh counter helpers on window. The General-tab wiring includes the global
 * smart-pause checkbox and threads it through settings load, handler setup, and profile import.
 */
import { initializeTabs } from './settings.tabs.js';
import {
    // globalSettings, // Not directly used, managed via get/set/update
    loadGlobalSettings,
    saveAndApplyGlobalSettings,
    setupGeneralSettingsHandlers,
    getGlobalSettings,
    setGlobalSettings
} from './settings.global.js';
import { setupUrlRulesHandlers } from './settings.urlRules.js';
import {
    initializeScheduledRefreshesUI,
    renderScheduledRefreshes, // Imported to be passed to loadGlobalSettings
    MAX_SCHEDULES
} from './settings.scheduledRefreshes.js';
import { initializeStatisticsUI } from './settings.statistics.js';
import { setupProfileHandlers } from './settings.profiles.js';
import { initializeActivityLogUI, loadActivityLog } from './settings.activityLog.js';
import { initializeShortcutsUI } from './settings.shortcuts.js';
import { initializeI18n } from './chromeI18n.js';

/**
 * Initialize the options page once its DOM is available.
 * @returns {void}
 */
document.addEventListener('DOMContentLoaded', () => {
    // Tab navigation
    const tabLinks = document.querySelectorAll('.tabs-navigation .tab-link');
    const tabContents = document.querySelectorAll('.tab-content');

    // General-tab controls, including smart pause (pauseWhileActiveEnabled).
    const themeSelect = document.getElementById('theme-select');
    const languageSelect = document.getElementById('language-select');
    const globalSoundNotificationCheckbox = document.getElementById('global-sound-notification');
    const autoRestoreTimersCheckbox = document.getElementById('auto-restore-timers');
    const bypassCacheOnRefreshCheckbox = document.getElementById('bypass-cache-on-refresh');
    const intervalJitterEnabledCheckbox = document.getElementById('interval-jitter-enabled');
    const intervalJitterPercentButtons = document.getElementById('interval-jitter-percent');
    const autoRecoverEnabledCheckbox = document.getElementById('auto-recover-enabled');
    const pauseWhileActiveEnabledCheckbox = document.getElementById('pause-while-active-enabled');

    // URL Rules
    const whitelistUrlsTextarea = document.getElementById('whitelist-urls');
    const blacklistUrlsTextarea = document.getElementById('blacklist-urls');
    const saveUrlPatternsButton = document.getElementById('save-url-patterns');

    // Scheduled Refreshes; add/edit happens in the schedule modal.
    const addScheduledRefreshButton = document.getElementById('add-scheduled-refresh');
    const scheduledListUl = document.getElementById('scheduled-list-ul');

    // Profiles
    const exportProfilesButton = document.getElementById('export-profiles');
    const importProfilesInput = document.getElementById('import-profiles-input');
    const importProfilesButton = document.getElementById('import-profiles');

    // Activity Log
    const clearLogButton = document.getElementById('clear-log');
    const logContainer = document.getElementById('log-container');

    // Coalesced settings reload listener and initial load.
    let _settingsReloadTimer = null;
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.activityLogs) loadActivityLog();
        // Prefs change in sync.globalSettings; rule lists change in local.globalLists.
        // A single save fires both events back-to-back; coalesce them into one reload and
        // update the counter AFTER the load completes (not via a setTimeout race against stale state).
        if ((namespace === 'sync' && changes.globalSettings) || (namespace === 'local' && changes.globalLists)) {
            if (_settingsReloadTimer) clearTimeout(_settingsReloadTimer);
            _settingsReloadTimer = setTimeout(() => {
                _settingsReloadTimer = null;
                loadGlobalSettings(
                    themeSelect, globalSoundNotificationCheckbox, autoRestoreTimersCheckbox, bypassCacheOnRefreshCheckbox,
                    whitelistUrlsTextarea, blacklistUrlsTextarea,
                    renderScheduledRefreshes, loadActivityLog, languageSelect,
                    intervalJitterEnabledCheckbox, intervalJitterPercentButtons, autoRecoverEnabledCheckbox,
                    pauseWhileActiveEnabledCheckbox
                ).then(() => {
                    if (window.updateSchedulesCounterGlobal) window.updateSchedulesCounterGlobal();
                });
            }, 150);
        }
    });
    
    // Initialize tab switching
    initializeTabs(); 

    // Initial load of settings and setup of general settings handlers.
    loadGlobalSettings(
        themeSelect, globalSoundNotificationCheckbox, autoRestoreTimersCheckbox, bypassCacheOnRefreshCheckbox,
        whitelistUrlsTextarea, blacklistUrlsTextarea,
        renderScheduledRefreshes, loadActivityLog, languageSelect,
        intervalJitterEnabledCheckbox, intervalJitterPercentButtons, autoRecoverEnabledCheckbox,
        pauseWhileActiveEnabledCheckbox
    ).then(async () => {
        // Initialize localization with the saved language, or the browser language otherwise.
        await initializeI18n();
        
        setupGeneralSettingsHandlers(themeSelect, globalSoundNotificationCheckbox, autoRestoreTimersCheckbox, bypassCacheOnRefreshCheckbox, languageSelect, intervalJitterEnabledCheckbox, intervalJitterPercentButtons, autoRecoverEnabledCheckbox, pauseWhileActiveEnabledCheckbox);
        setupUrlRulesHandlers(saveUrlPatternsButton, whitelistUrlsTextarea, blacklistUrlsTextarea);
        initializeScheduledRefreshesUI({
            addScheduledRefreshButton,
            scheduledListUl,
            schedulesCountElement: document.getElementById('schedules-count')
        });
        setupProfileHandlers(
            exportProfilesButton,
            importProfilesButton,
            importProfilesInput,
            themeSelect,
            globalSoundNotificationCheckbox,
            autoRestoreTimersCheckbox,
            bypassCacheOnRefreshCheckbox,
            whitelistUrlsTextarea,
            blacklistUrlsTextarea,
            renderScheduledRefreshes, // from scheduledRefreshes.js
            loadActivityLog,          // from activityLog.js
            languageSelect,           // language selector
            intervalJitterEnabledCheckbox, intervalJitterPercentButtons, autoRecoverEnabledCheckbox,
            pauseWhileActiveEnabledCheckbox
        );
        initializeActivityLogUI({ logContainer, clearLogButton });
        
        // Initialize the statistics module
        initializeStatisticsUI();

        // Populate the keyboard-shortcuts card with the live bindings (descriptions are static data-i18n).
        initializeShortcutsUI();
        
        /**
         * Update the schedules-counter element: set its "(count/max)" text and apply
         * the 'warning'/'danger' class (>=75% / >=90% of MAX_SCHEDULES), then force it visible.
         * @param {HTMLElement} element - the schedules-count span to update.
         * @returns {void}
         */
        function updateCounterElement(element) {
            // Read the current global settings
            const settings = getGlobalSettings();
            const count = (settings && settings.scheduledRefreshes) ? settings.scheduledRefreshes.length : 0;
            const maxCount = MAX_SCHEDULES;

            // Update the displayed text
            element.textContent = `(${count}/${maxCount})`;

            // Remove the previous state classes
            element.classList.remove('warning', 'danger');

            // Add the appropriate state class (thresholds scale with the limit)
            if (count >= maxCount * 0.9) {
                element.classList.add('danger');
            } else if (count >= maxCount * 0.75) {
                element.classList.add('warning');
            }
            
            // Force the element to be visible
            element.style.display = 'inline';
            element.style.visibility = 'visible';
            element.style.opacity = '1';
        }
        
        /**
         * Install window.startSchedulesCounterUpdater: starts a 2-second setInterval that
         * calls updateSchedulesCounterGlobal. Idempotent; a second call is a no-op if the
         * timer (window._schedulesCounterTimerId) already exists.
         * @returns {void}
         */
        window.startSchedulesCounterUpdater = function() {
            // Idempotent: a repeat call must not spawn a second interval (guards against UI re-initialization).
            if (window._schedulesCounterTimerId) return;
            // Refresh the counter every 2 seconds
            window._schedulesCounterTimerId = setInterval(() => {
                if (window.updateSchedulesCounterGlobal) {
                    window.updateSchedulesCounterGlobal();
                }
            }, 2000);
        };
        
        /**
         * Install window.ensureSchedulesCounter: returns the #schedules-count element,
         * creating and appending it to the "Current Schedules" heading if absent.
         * @returns {HTMLElement|null} the counter element, or null if the heading is missing.
         */
        window.ensureSchedulesCounter = function() {
            let counterElement = document.getElementById('schedules-count');

            if (!counterElement) {
                // Find the "Current Schedules" heading so the counter can be created if needed
                const heading = document.querySelector('h3[data-i18n="current_schedules"]');
                if (heading) {
                    // Create the counter element
                    counterElement = document.createElement('span');
                    counterElement.id = 'schedules-count';
                    counterElement.className = 'schedules-counter';
                    counterElement.textContent = `(0/${MAX_SCHEDULES})`;

                    // Append it to the heading
                    heading.appendChild(document.createTextNode(' '));
                    heading.appendChild(counterElement);
                } else {
                    console.warn('"Current Schedules" heading not found');
                }
            }
            
            return counterElement;
        };
        
        /**
         * Install window.updateSchedulesCounterGlobal: ensures the counter element exists
         * (via ensureSchedulesCounter) and updates it (via updateCounterElement).
         * @returns {void}
         */
        window.updateSchedulesCounterGlobal = function() {
            const counterElement = window.ensureSchedulesCounter();
            
            if (!counterElement) {
                console.warn('Failed to find or create the counter element');
                return;
            }
            
            updateCounterElement(counterElement);
        };
        
        // Trigger the counter update after full initialization
        setTimeout(() => {
            if (window.updateSchedulesCounterGlobal) {
                window.updateSchedulesCounterGlobal();
            }
            // Start the periodic refresh
            if (window.startSchedulesCounterUpdater) {
                window.startSchedulesCounterUpdater();
            }
        }, 1000);
    });
});

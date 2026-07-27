// Popup entry point. On DOMContentLoaded it initializes localization, queries the
// active tab, wires all popup event-handler and listener modules to that tab id, and
// live-reapplies localization when the language preference changes in sync storage.
import {
    statusMessageEl,
    presetButtons,
    buildPresetButtons,
    customIntervalInput,
    setCustomIntervalButton,
    rangeMinInput,
    rangeMaxInput,
    setRangeButton,
    startButton,
    pauseButton,
    stopButton,
    soundNotificationCheckbox,
    refreshModeSelect,
    jitterModeSelect,
    recoverModeSelect,
    settingsButton,
    fetchAndUpdateUIPopup
} from './ui.js';
import {
    setupPresetButtonListeners,
    setupCustomIntervalButtonListener,
    setupStartButtonListener,
    setupPauseButtonListener,
    setupStopButtonListener,
    setupSoundNotificationListener,
    setupRefreshModeListener,
    setupJitterModeListener,
    setupRecoverModeListener,
    setupSettingsButtonListener,
    setupBulkListeners,
    setupRangeButtonListener
} from './eventHandlers.js';
import {
    setupStorageChangeListener,
    setupRuntimeMessageListener,
    setupSystemThemeChangeListener
} from './listeners.js';
import {
    initializeLanguage,
    loadTranslations,
    setUserSelectedLanguage,
    localizePageElements,
    t
} from './i18n.js';

/**
 * Initializes popup localization: loads the saved language preference, builds the
 * preset buttons from the shared list before localizing so they translate in the
 * same pass, then localizes all page elements.
 * @returns {Promise<void>}
 */
async function initializePopupI18n() {
    // Load the saved language preference
    await initializeLanguage();
    // Render the preset buttons from the shared list BEFORE localization so they are
    // translated in the same pass (single source of truth — shared/intervalPresets.js).
    buildPresetButtons();
    // Localize all page elements
    localizePageElements();
}

document.addEventListener('DOMContentLoaded', async () => {
    // Initialize localization
    await initializePopupI18n();
    let currentTabId = null;
    const getCurrentTabId = () => currentTabId;

    // Use async/await instead of the callback API
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs?.length > 0 && tabs[0]?.id) {
            const currentTab = tabs[0];
            currentTabId = currentTab.id;
            fetchAndUpdateUIPopup(currentTabId); // Fetch fresh state from background

            // Setup event listeners once currentTabId is known
            if (presetButtons) setupPresetButtonListeners(currentTabId);
            if (customIntervalInput && setCustomIntervalButton) {
                setupCustomIntervalButtonListener(currentTabId, customIntervalInput, setCustomIntervalButton);
            }
            if (startButton && customIntervalInput) {
                setupStartButtonListener(currentTabId, startButton, customIntervalInput);
            }
            if (setRangeButton && rangeMinInput && rangeMaxInput) {
                setupRangeButtonListener(currentTabId, rangeMinInput, rangeMaxInput, setRangeButton);
            }
            if (pauseButton) {
                setupPauseButtonListener(currentTabId, pauseButton);
            }
            if (stopButton) {
                setupStopButtonListener(currentTabId, stopButton);
            }
            if (soundNotificationCheckbox) {
                setupSoundNotificationListener(currentTabId);
            }
            if (refreshModeSelect) {
                setupRefreshModeListener(currentTabId);
            }
            if (jitterModeSelect) {
                setupJitterModeListener(currentTabId);
            }
            if (recoverModeSelect) {
                setupRecoverModeListener(currentTabId);
            }
            if (settingsButton) {
                setupSettingsButtonListener(settingsButton);
            }
            // Bulk actions are scoped by the active tab's windowId / groupId (resolved in the background).
            setupBulkListeners(currentTab);
        } else {
            if (statusMessageEl) statusMessageEl.textContent = t('popup_no_active_tab');
        }
    } catch (error) {
        console.error('Failed to query active tab:', error);
        if (statusMessageEl) statusMessageEl.textContent = t('popup_tab_error');
    }

    // Setup global listeners
    setupStorageChangeListener(getCurrentTabId);
    setupRuntimeMessageListener(getCurrentTabId);
    setupSystemThemeChangeListener(getCurrentTabId); // The 'auto' theme follows the OS scheme live
    
    // Watch settings changes to update the language
    chrome.storage.onChanged.addListener(async (changes, namespace) => {
        if (namespace === 'sync' && changes.globalSettings) {
            const newSettings = changes.globalSettings.newValue;
            const oldSettings = changes.globalSettings.oldValue;

            // If the language changed, re-apply localization
            if (newSettings?.language !== oldSettings?.language) {
                setUserSelectedLanguage(newSettings?.language);
                if (newSettings?.language) {
                    await loadTranslations(newSettings.language);
                }
                // Refresh all popup texts
                await initializePopupI18n();
                // Refresh the UI with the new translations
                if (currentTabId) {
                    fetchAndUpdateUIPopup(currentTabId);
                }
            }
        }
    });
});

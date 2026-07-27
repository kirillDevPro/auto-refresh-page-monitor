// Popup reactive listeners: wires chrome.storage.onChanged, the prefers-color-scheme media query,
// and chrome.runtime.onMessage so the popup UI re-syncs whenever this tab's state, the global
// settings, the OS color scheme, or a background-pushed update changes. Each listener refetches the
// full UI for the current tab via fetchAndUpdateUIPopup to keep rendering consistent.
import { fetchAndUpdateUIPopup } from './ui.js';

/**
 * Register a chrome.storage.onChanged listener that refetches the popup UI when the
 * current tab's persisted state changes. Refetches on a write to local `tab_{id}` or
 * `tab_{id}_remainingTime`, or to `sync.globalSettings`; ignores changes when there is
 * no current tab.
 * @param {() => (number|undefined)} getCurrentTabId - Returns the active tab id, or falsy if none.
 */
export function setupStorageChangeListener(getCurrentTabId) {
    chrome.storage.onChanged.addListener(async (changes, namespace) => {
        const currentTabId = getCurrentTabId();
        if (currentTabId) {
            // If relevant tab data or global settings changed, fetch everything fresh.
            if ( (namespace === 'local' && (changes[`tab_${currentTabId}`] || changes[`tab_${currentTabId}_remainingTime`])) ||
                 (namespace === 'sync' && changes.globalSettings) ) {
                fetchAndUpdateUIPopup(currentTabId);
            }
        }
    });
}

// Re-applies the theme when the OS color scheme changes (prefers-color-scheme). A full refetch
// keeps the dark-theme class in sync via resolveTheme inside updateUIDisplay — for explicit
// light/dark the theme does not move (resolveTheme returns that value), for 'auto' it follows the OS.
/**
 * Register a prefers-color-scheme media-query listener that refetches the popup UI on OS
 * scheme change, so resolveTheme re-syncs the dark-theme class while theme==='auto'.
 * @param {() => (number|undefined)} getCurrentTabId - Returns the active tab id, or falsy if none.
 */
export function setupSystemThemeChangeListener(getCurrentTabId) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const currentTabId = getCurrentTabId();
        if (currentTabId) fetchAndUpdateUIPopup(currentTabId);
    });
}

/**
 * Register a chrome.runtime.onMessage listener that refetches the popup UI when the background
 * sends an 'updatePopupUI' message for the current tab (data potentially fresher than the
 * storage listener alone), then acknowledges. Returns true to keep the message channel open
 * for any async response elsewhere.
 * @param {() => (number|undefined)} getCurrentTabId - Returns the active tab id, or falsy if none.
 */
export function setupRuntimeMessageListener(getCurrentTabId) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const currentTabId = getCurrentTabId();
        if (message.action === 'updatePopupUI' && message.tabId === currentTabId) {
            // This message comes from background with potentially fresher data than storage listener alone
             fetchAndUpdateUIPopup(currentTabId); // Re-fetch all to ensure consistency
            sendResponse({status: "Popup UI update triggered by background message"});
        }
        return true; // Keep channel open for async response if needed elsewhere
    });
}

// settings.urlRules.js — Settings page: whitelist/blacklist URL-pattern editor.
// Wires the "Save URL patterns" button to parse both textareas (one trimmed,
// non-empty pattern per line) into global settings, then persist and apply them.
import { getGlobalSettings, setGlobalSettings, saveAndApplyGlobalSettings } from './settings.global.js';
import { showToast } from './modal.js';
import { t } from './chromeI18n.js';

/**
 * Wire the click handler on the "Save URL patterns" button.
 * On click, splits each textarea by newline into trimmed, non-empty patterns,
 * writes them to globalSettings.whitelist / .blacklist, persists and applies the
 * settings, and shows a success toast. No-op if any element argument is missing.
 * @param {HTMLButtonElement} saveUrlPatternsButton - the save button.
 * @param {HTMLTextAreaElement} whitelistUrlsTextarea - textarea holding whitelist patterns.
 * @param {HTMLTextAreaElement} blacklistUrlsTextarea - textarea holding blacklist patterns.
 * @returns {void}
 */
export function setupUrlRulesHandlers(saveUrlPatternsButton, whitelistUrlsTextarea, blacklistUrlsTextarea) {
    if (saveUrlPatternsButton && whitelistUrlsTextarea && blacklistUrlsTextarea) {
        saveUrlPatternsButton.addEventListener('click', () => {
            // getGlobalSettings() always returns an object (a copy of globalSettings),
            // so a falsy check is unnecessary.
            let currentSettings = getGlobalSettings();

            currentSettings.whitelist = whitelistUrlsTextarea.value.split('\n')
                .map(s => s.trim())
                .filter(s => s);
            currentSettings.blacklist = blacklistUrlsTextarea.value.split('\n')
                .map(s => s.trim())
                .filter(s => s);

            setGlobalSettings(currentSettings);
            saveAndApplyGlobalSettings();
            showToast(t('url_rules_saved'), 'success');
        });
    }
}

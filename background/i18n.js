/**
 * Minimal service-worker i18n for chrome.contextMenus labels.
 *
 * Mirrors popup/i18n.js — background and popup are deliberately separate module trees that share no
 * code — but has no DOM: it loads the user-selected locale's messages.json so context-menu labels
 * honor the in-extension language override, and falls back to chrome.i18n.getMessage (the browser UI
 * locale) then the raw key. Used only by background/contextMenu.js.
 */

// The currently loaded override language ('en','ru',...) or null when none is selected (rely on chrome.i18n).
let selectedLang = null;
// Parsed messages.json for selectedLang, or null when no override is loaded / the load failed.
let table = null;

/**
 * Load (or clear) the override translation table for the given language.
 * @param {string|null} lang - Locale code, or null/'' to clear the override and rely on chrome.i18n.
 * @returns {Promise<void>}
 */
export async function loadMenuLocale(lang) {
    selectedLang = lang || null;
    table = null;
    if (!selectedLang) return; // No override: tMenu() falls back to chrome.i18n (browser UI locale).
    try {
        const res = await fetch(chrome.runtime.getURL(`_locales/${selectedLang}/messages.json`));
        table = await res.json();
    } catch (e) {
        console.warn(`background i18n: failed to load locale ${selectedLang}:`, e?.message);
        table = null;
    }
}

/**
 * Resolve a localized menu label by key: prefer the loaded override locale, then chrome.i18n
 * (browser UI locale), then the raw key.
 * @param {string} key - Translation key (a messages.json entry name).
 * @returns {string} The translated text, or the key itself if no translation is found.
 */
export function tMenu(key) {
    try {
        if (table && table[key] && table[key].message) return table[key].message;
        const m = chrome.i18n.getMessage(key);
        return m || key;
    } catch (e) {
        return key;
    }
}

// Internationalization (i18n) module for the popup

let userSelectedLanguage = null;
let translations = {};

/**
 * Loads the translation table for the given language by fetching its messages.json from _locales/.
 * @param {string} lang - language code (e.g. 'en', 'ru')
 * @returns {Promise<Object>} the parsed translations object (empty object on fetch/parse failure)
 */
export async function loadTranslations(lang) {
    try {
        const response = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
        const data = await response.json();
        translations[lang] = data;
        return data;
    } catch (error) {
        console.warn(`Failed to load translations for ${lang}:`, error);
        return {};
    }
}

/**
 * Resolves a localized message by key, preferring the user-selected language's loaded
 * translations and falling back to the Chrome i18n API, then to the raw key.
 * @param {string} key - translation key
 * @returns {string} the translated text, or the key itself if no translation is found
 */
export function t(key) {
    try {
        // If the user has selected a language, use it
        if (userSelectedLanguage && translations[userSelectedLanguage]) {
            const userTranslation = translations[userSelectedLanguage][key];
            if (userTranslation && userTranslation.message) {
                return userTranslation.message;
            }
        }

        // Otherwise fall back to the standard Chrome i18n API
        const message = chrome.i18n.getMessage(key);
        return message || key; // Return the key itself if no translation is found
    } catch (error) {
        console.warn(`Failed to get i18n message for key: ${key}`, error);
        return key;
    }
}

/**
 * Sets the currently selected language and syncs document.documentElement.lang
 * (only when lang is provided).
 * @param {string|null} lang - language code, or null to clear the override
 */
export function setUserSelectedLanguage(lang) {
    userSelectedLanguage = lang;
    if (lang) document.documentElement.lang = lang.replace('_', '-');
}

/**
 * Initializes the active language from saved settings (chrome.storage.sync.globalSettings),
 * loading its translations if present, and syncs <html lang> to the resolved language.
 * @returns {Promise<void>}
 */
export async function initializeLanguage() {
    try {
        // Language is a small pref, stored in chrome.storage.sync (cross-device).
        const data = await chrome.storage.sync.get('globalSettings');
        const savedLanguage = data.globalSettings?.language;

        if (savedLanguage) {
            userSelectedLanguage = savedLanguage;
            // Load the translations for the saved language
            await loadTranslations(savedLanguage);
        }
        // Sync <html lang> with the active language (screen readers, hyphenation, spellcheck)
        const activeLang = savedLanguage || (chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage().split('-')[0] : 'en');
        document.documentElement.lang = activeLang.replace('_', '-');
    } catch (error) {
        console.warn('Failed to load language settings:', error);
    }
}

/**
 * Localizes the popup page: sets document.title (key 'extName') and translates all
 * elements carrying data-i18n / data-i18n-placeholder / data-i18n-title attributes.
 */
export function localizePageElements() {
    // Localize the popup window title
    document.title = t('extName');

    // Update the text of elements carrying data-i18n attributes
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(element => {
        const key = element.getAttribute('data-i18n');
        try {
            const translation = t(key);
            if (translation !== key) {
                if (element.tagName === 'INPUT' && element.type === 'button') {
                    element.value = translation;
                } else if (element.tagName === 'BUTTON') {
                    element.textContent = translation;
                } else {
                    element.textContent = translation;
                }
            }
        } catch (error) {
            console.warn(`Failed to get i18n message for key: ${key}`, error);
        }
    });

    // Update placeholder attributes
    const placeholderElements = document.querySelectorAll('[data-i18n-placeholder]');
    placeholderElements.forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        try {
            const translation = t(key);
            if (translation !== key) {
                element.placeholder = translation;
            }
        } catch (error) {
            console.warn(`Failed to get i18n placeholder for key: ${key}`, error);
        }
    });

    // Update title attributes
    const titleElements = document.querySelectorAll('[data-i18n-title]');
    titleElements.forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        try {
            const translation = t(key);
            if (translation !== key) {
                element.title = translation;
            }
        } catch (error) {
            console.warn(`Failed to get i18n title for key: ${key}`, error);
        }
    });
}

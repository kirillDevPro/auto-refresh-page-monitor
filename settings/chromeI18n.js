// chromeI18n.js - Adapter for the Chrome i18n API.
// Separate i18n adapter for the settings page (the popup uses its own popup/i18n.js).

let userSelectedLanguage = null; // Language explicitly chosen by the user
let translations = {}; // Cache of loaded translations, keyed by language code

/**
 * Fetches and caches the messages.json for a locale from the extension bundle.
 * @param {string} lang - Locale code (e.g. 'en', 'pt_PT').
 * @returns {Promise<Object>} The parsed messages object, or {} on failure.
 */
async function loadTranslations(lang) {
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

// Returns the localized message for a key
export function t(key) {
    try {
        // If the user picked a language, use its cached translation first
        if (userSelectedLanguage && translations[userSelectedLanguage]) {
            const userTranslation = translations[userSelectedLanguage][key];
            if (userTranslation && userTranslation.message) {
                return userTranslation.message;
            }
        }
        
        // Otherwise fall back to the standard Chrome i18n API
        const message = chrome.i18n.getMessage(key);
        return message || key; // Return the raw key if no translation was found
    } catch (error) {
        console.warn(`Failed to get i18n message for key: ${key}`, error);
        return key;
    }
}

// Returns the current UI language code
export function getCurrentLanguage() {
    // If the user picked a language, return it
    if (userSelectedLanguage) {
        return userSelectedLanguage;
    }
    
    try {
        const uiLanguage = chrome.i18n.getUILanguage();
        // Convert Chrome's format (en-US) to our format (en)
        return uiLanguage.split('-')[0];
    } catch (error) {
        console.warn('Failed to get UI language', error);
        return 'ru'; // Fallback
    }
}

// Sets the active language.
// Persisting the language is the caller's job via saveAndApplyGlobalSettings (language is a SYNC_KEY).
// This function previously did its own RMW write into sync.globalSettings, which duplicated
// the save and created a lost-update race on a single key. It now only updates in-memory state + UI.
export async function setLanguage(lang) {
    userSelectedLanguage = lang;

    // Load translations for the chosen language
    if (!translations[lang]) {
        await loadTranslations(lang);
    }

    // Re-localize the page texts
    updatePageTexts();
}

// Initializes the localization system
export async function initializeI18n(language = null) {
    // Load saved settings (language is a small pref stored in sync)
    try {
        const data = await chrome.storage.sync.get('globalSettings');
        const savedLanguage = data.globalSettings?.language;
        
        if (savedLanguage) {
            userSelectedLanguage = savedLanguage;
            // Load translations for the saved language
            await loadTranslations(savedLanguage);
        } else if (language) {
            userSelectedLanguage = language;
            await loadTranslations(language);
        }
    } catch (error) {
        console.warn('Failed to load language settings:', error);
    }

    updatePageTexts();
}

// Returns the list of available languages
export function getAvailableLanguages() {
    return [
        { code: 'ar', name: t('arabic') || 'العربية' },
        { code: 'bg', name: t('bulgarian') || 'Български' },
        { code: 'cs', name: t('czech') || 'Čeština' },
        { code: 'da', name: t('danish') || 'Dansk' },
        { code: 'de', name: t('german') || 'Deutsch' },
        { code: 'el', name: t('greek') || 'Ελληνικά' },
        { code: 'en', name: t('english') || 'English' },
        { code: 'es', name: t('spanish') || 'Español' },
        { code: 'et', name: t('estonian') || 'Eesti' },
        { code: 'fa', name: t('persian') || 'فارسی' },
        { code: 'fi', name: t('finnish') || 'Suomi' },
        { code: 'fr', name: t('french') || 'Français' },
        { code: 'hi', name: t('hindi') || 'हिन्दी' },
        { code: 'it', name: t('italian') || 'Italiano' },
        { code: 'ja', name: t('japanese') || '日本語' },
        { code: 'ko', name: t('korean') || '한국어' },
        { code: 'lt', name: t('lithuanian') || 'Lietuvių' },
        { code: 'no', name: t('norwegian') || 'Norsk' },
        { code: 'pl', name: t('polish') || 'Polski' },
        { code: 'pt_PT', name: t('portuguese') || 'Português' },
        { code: 'ro', name: t('romanian') || 'Română' },
        { code: 'ru', name: t('russian') || 'Русский' },
        { code: 'sk', name: t('slovak') || 'Slovenčina' },
        { code: 'sv', name: t('swedish') || 'Svenska' },
        { code: 'tr', name: t('turkish') || 'Türkçe' },
        { code: 'uk', name: t('ukrainian') || 'Українська' },
        { code: 'zh_CN', name: t('chinese_simplified') || '中文 (简体)' }
    ];
}

// Shows a transient toast notifying that the language changed
export function showLanguageChangeNotification() {
    const message = t('language_changed');

    // Create the notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #3498db;
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 10000;
        max-width: 300px;
        font-family: inherit;
        font-size: 14px;
        line-height: 1.4;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Remove the notification after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 5000);
}

// Re-localizes all texts on the page
export function updatePageTexts() {
    // Sync <html lang> with the active language (screen readers, word wrapping, spell check)
    document.documentElement.lang = getCurrentLanguage().replace('_', '-');

    // Update the text of elements carrying a data-i18n attribute
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(element => {
        const key = element.getAttribute('data-i18n');
        const translation = t(key);
        if (translation !== key) {
            if (element.tagName === 'INPUT' && element.type === 'button') {
                element.value = translation;
            } else if (element.tagName === 'BUTTON') {
                element.textContent = translation;
            } else if (element.tagName === 'OPTION') {
                element.textContent = translation;
            } else {
                element.textContent = translation;
            }
        }
    });
    
    // Update placeholder attributes
    const placeholderElements = document.querySelectorAll('[data-i18n-placeholder]');
    placeholderElements.forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        const translation = t(key);
        if (translation !== key) {
            element.placeholder = translation.replace(/\\n/g, '\n');
        }
    });
    
    // Update title attributes
    const titleElements = document.querySelectorAll('[data-i18n-title]');
    titleElements.forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        const translation = t(key);
        if (translation !== key) {
            element.title = translation;
        }
    });
    
    // Rebuild the language list in the selector
    const languageSelect = document.getElementById('language-select');
    if (languageSelect) {
        const currentValue = languageSelect.value;
        languageSelect.innerHTML = '';
        
        const availableLanguages = getAvailableLanguages();
        availableLanguages.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang.code;
            option.textContent = lang.name;
            languageSelect.appendChild(option);
        });
        
        if (currentValue) {
            languageSelect.value = currentValue;
        }
    }
}


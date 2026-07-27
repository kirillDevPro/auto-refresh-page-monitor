// actionUtils.js — thin wrappers around the chrome.action.* API (icon, title,
// badge text/color) plus an isTabNotFoundError helper that classifies an error
// as "the target tab no longer exists". callActionMethod throws if the named
// chrome.action method is unavailable (it does NOT swallow tab-gone errors —
// callers use isTabNotFoundError to decide whether to ignore a rejection).

/**
 * Lowercased substrings that appear in chrome.* error messages when the target
 * tab no longer exists. Matched case-insensitively by isTabNotFoundError.
 */
const TAB_NOT_FOUND_PATTERNS = [
    'no tab with id',
    'invalid tab id',
    'tab closed'
];

/**
 * Returns true if the given error indicates the target tab no longer exists.
 * Matches error.message (lowercased) against TAB_NOT_FOUND_PATTERNS; returns
 * false for a null/empty error or one with no message.
 * @param {Error|{message?: string}|null|undefined} error - The caught error.
 * @returns {boolean} True when the error denotes a missing/closed tab.
 */
export function isTabNotFoundError(error) {
    if (!error || !error.message) {
        return false;
    }
    const normalized = error.message.toLowerCase();
    return TAB_NOT_FOUND_PATTERNS.some(pattern => normalized.includes(pattern));
}

/**
 * Invokes the named chrome.action method, throwing if it is unavailable.
 * @param {string} methodName - chrome.action method to call (e.g. 'setIcon').
 * @param {object} details - Arguments object forwarded to the method.
 * @returns {Promise<*>} The promise returned by the chrome.action method.
 * @throws {Error} If chrome.action or chrome.action[methodName] is missing/falsy.
 */
async function callActionMethod(methodName, details) {
    if (!chrome.action?.[methodName]) {
        throw new Error(`Invalid action method: ${methodName}`);
    }
    return chrome.action[methodName](details);
}

/**
 * Sets the extension toolbar icon via chrome.action.setIcon.
 * @param {object} details - chrome.action.setIcon details (e.g. {path, tabId}).
 * @returns {Promise<*>} The promise from the underlying setIcon call.
 */
export function setActionIcon(details) {
    return callActionMethod('setIcon', details);
}

/**
 * Sets the extension toolbar tooltip via chrome.action.setTitle.
 * @param {object} details - chrome.action.setTitle details (e.g. {title, tabId}).
 * @returns {Promise<*>} The promise from the underlying setTitle call.
 */
export function setActionTitle(details) {
    return callActionMethod('setTitle', details);
}

/**
 * Sets the toolbar badge text via chrome.action.setBadgeText.
 * @param {object} details - chrome.action.setBadgeText details (e.g. {text, tabId}).
 * @returns {Promise<*>} The promise from the underlying setBadgeText call.
 */
export function setActionBadgeText(details) {
    return callActionMethod('setBadgeText', details);
}

/**
 * Sets the toolbar badge background color via chrome.action.setBadgeBackgroundColor.
 * @param {object} details - setBadgeBackgroundColor details (e.g. {color, tabId}).
 * @returns {Promise<*>} The promise from the underlying setBadgeBackgroundColor call.
 */
export function setActionBadgeBackgroundColor(details) {
    return callActionMethod('setBadgeBackgroundColor', details);
}

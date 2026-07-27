// htmlUtils.js - Shared DOM/HTML utilities for the settings page

/**
 * Escapes HTML special characters in arbitrary text so it can be safely
 * inserted via innerHTML (XSS protection). Works through textContent → the
 * browser itself escapes &, <, >, " and the rest.
 *
 * @param {string} text - arbitrary string (e.g. a user-supplied URL)
 * @returns {string} the string with HTML special characters escaped
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

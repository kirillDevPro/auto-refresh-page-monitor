// refreshModes.js - Single source of truth for the tri-state refresh mode used by
// per-tab settings (popup) and scheduled rules. 'default' inherits the global
// bypassCache setting; 'hard' forces a cache-bypassing reload; 'normal' forces a cached reload.

import { t } from './chromeI18n.js';

// Ordered list of modes ({value, i18n key}). Drives the schedule modal dropdown.
export const REFRESH_MODES = [
    { value: 'default', key: 'refresh_mode_default' },
    { value: 'hard', key: 'refresh_mode_hard' },
    { value: 'normal', key: 'refresh_mode_normal' },
];

/**
 * Returns the localized label for a refresh-mode value, falling back to the
 * 'default' entry's label for unknown or missing values.
 * @param {string} mode - One of 'default' | 'hard' | 'normal'.
 * @returns {string} The localized label text from the i18n table.
 */
export function refreshModeLabel(mode) {
    const entry = REFRESH_MODES.find(m => m.value === mode);
    return t((entry || REFRESH_MODES[0]).key);
}

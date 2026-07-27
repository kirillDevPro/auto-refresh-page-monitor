/**
 * Defines the tri-state auto-recovery modes shared by popup tab settings and scheduled rules.
 *
 * The values mirror jitter mode: 'default' inherits the global autoRecoverEnabled flag, 'on'
 * forces recovery for the tab or rule, and 'off' disables it. Recovery still requires the optional
 * webNavigation permission to be granted at runtime.
 */

import { t } from './chromeI18n.js';

// Ordered list of mode values and i18n keys used by recovery-mode selects.
export const RECOVER_MODES = [
    { value: 'default', key: 'recover_mode_default' },
    { value: 'on', key: 'recover_mode_on' },
    { value: 'off', key: 'recover_mode_off' },
];

/**
 * Return the localized label for a recovery mode value.
 * @param {('default'|'on'|'off'|string|undefined)} mode - Recovery mode to display.
 * @returns {string} Localized label, falling back to the default-mode label for unknown values.
 */
export function recoverModeLabel(mode) {
    const entry = RECOVER_MODES.find(m => m.value === mode);
    return t((entry || RECOVER_MODES[0]).key);
}

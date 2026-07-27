// jitterModes.js - Single source of truth for the tri-state interval-jitter mode used by
// per-tab settings (popup) and scheduled rules. Mirrors refreshModes.js. 'default' inherits
// the global intervalJitterEnabled toggle; 'on' forces jitter; 'off' disables it.

import { t } from './chromeI18n.js';

// Ordered list of modes ({value, i18n key}). Drives the schedule modal dropdown.
export const JITTER_MODES = [
    { value: 'default', key: 'jitter_mode_default' },
    { value: 'on', key: 'jitter_mode_on' },
    { value: 'off', key: 'jitter_mode_off' },
];

// Localized label for a mode value (falls back to the 'default' label for unknown/missing values).
export function jitterModeLabel(mode) {
    const entry = JITTER_MODES.find(m => m.value === mode);
    return t((entry || JITTER_MODES[0]).key);
}

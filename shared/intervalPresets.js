// shared/intervalPresets.js — the single source of truth for the list of fixed interval presets.
//
// Ordered list of fixed interval presets (seconds + i18n key). This is the ONE deliberate
// cross-tree shared module: both the popup preset buttons (popup/ui.js → buildPresetButtons)
// and the settings schedule modal dropdown (settings/scheduleModal.js via settings/timeFormat.js)
// pull from this single list, so adding/removing a preset here propagates to both UIs at once.
// Keep it dependency-free (no chrome.* / DOM) so either tree can import it safely.
export const INTERVAL_PRESETS = [
    { value: 30, key: 'seconds_30' },
    { value: 60, key: 'minute_1' },
    { value: 180, key: 'minutes_3' },
    { value: 300, key: 'minutes_5' },
    { value: 600, key: 'minutes_10' },
    { value: 900, key: 'minutes_15' },
    { value: 1800, key: 'minutes_30' },
    { value: 3600, key: 'hour_1' },
    { value: 10800, key: 'hours_3' },
    { value: 21600, key: 'hours_6' },
    { value: 43200, key: 'hours_12' },
    { value: 86400, key: 'hours_24' },
];

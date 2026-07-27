// timeFormat.js - Localized formatting of time intervals
import { t } from './chromeI18n.js';
import { INTERVAL_PRESETS } from '../shared/intervalPresets.js';

// Re-export the canonical preset list (defined in shared/intervalPresets.js — the single
// source of truth shared with the popup buttons) so settings-tree importers (scheduleModal.js)
// keep pulling it from here.
export { INTERVAL_PRESETS };

// Lookup map (seconds → i18n key) derived from INTERVAL_PRESETS. Used when displaying a
// saved schedule: if the interval matches a preset, reuse its translation (e.g. "24 hours").
const PRESET_KEYS = Object.fromEntries(INTERVAL_PRESETS.map(p => [p.value, p.key]));

/**
 * Returns the long form for a preset (e.g. "24 hours") or the compact short form for an arbitrary value.
 * If the seconds value matches a preset, its localized translation is reused; otherwise it delegates to formatIntervalShort.
 * @param {number} seconds - Interval length in seconds.
 * @returns {string} Localized interval label.
 */
export function formatIntervalLong(seconds) {
    const presetKey = PRESET_KEYS[seconds];
    if (presetKey) return t(presetKey);
    return formatIntervalShort(seconds);
}

/**
 * Builds the compact form "1h 30m 15s" with localized unit suffixes.
 * Omits zero-valued components; falls back to "0" + the seconds suffix when the total is zero.
 * @param {number} seconds - Interval length in seconds.
 * @returns {string} Compact localized interval string.
 */
export function formatIntervalShort(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}${t('unit_hour_short')}`);
    if (m > 0) parts.push(`${m}${t('unit_min_short')}`);
    if (s > 0) parts.push(`${s}${t('unit_sec_short')}`);
    return parts.length > 0 ? parts.join(' ') : `0${t('unit_sec_short')}`;
}

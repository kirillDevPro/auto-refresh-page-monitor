/**
 * Manages popup DOM references, preset and range rendering, countdown display, theme resolution,
 * bulk-result output, and state synchronization from background tab state plus global settings.
 */
import { formatTime, sendMessageWithRetry } from './utils.js';
import { t } from './i18n.js';
import { INTERVAL_PRESETS } from '../shared/intervalPresets.js';
import { baseAndPercentToRange } from '../shared/intervalRange.js';

// Popup DOM references used by event handlers and UI rendering.
export const statusMessageEl = document.getElementById('status-message');
export const refreshCountEl = document.getElementById('refresh-count');
// Preset buttons are generated from the shared INTERVAL_PRESETS (single source of truth
// shared with the settings schedule modal — see shared/intervalPresets.js), not hardcoded
// in popup.html. `buildPresetButtons()` populates this live binding before localization.
export let presetButtons = [];
export const customIntervalInput = document.getElementById('custom-interval-value');
export const setCustomIntervalButton = document.getElementById('set-custom-interval');
export const rangeMinInput = document.getElementById('range-min');
export const rangeMaxInput = document.getElementById('range-max');
export const setRangeButton = document.getElementById('set-range');
export const startButton = document.getElementById('start-refresh');
export const pauseButton = document.getElementById('pause-refresh');
export const stopButton = document.getElementById('stop-refresh');
export const soundNotificationCheckbox = document.getElementById('sound-notification');
export const refreshModeSelect = document.getElementById('refresh-mode');
export const jitterModeSelect = document.getElementById('jitter-mode');
export const recoverModeSelect = document.getElementById('recover-mode');
export const jitterIndicator = document.getElementById('jitter-indicator');
export const jitterIndicatorText = document.getElementById('jitter-indicator-text');
export const settingsButton = document.getElementById('settings-button');
export const countdownTimerEl = document.getElementById('countdown-timer');
export const timerDisplaySection = document.querySelector('.timer-display-section');
export const bulkResultEl = document.getElementById('bulk-result');

let countdownIntervalId = null; // setInterval id for the countdown display.
export let currentActiveTabSettings = {}; // Latest known full tabSettings.

// Localization is initialized and refreshed centrally in popup.js
// (initializePopupI18n + a storage.onChanged listener), so there are no duplicate
// initializeLanguage()/listeners here.

/**
 * Store the latest known full tabSettings object in the module-level
 * currentActiveTabSettings cache (read elsewhere, e.g. by the start button handler).
 * @param {object} settings - The tab settings object to cache.
 * @returns {void}
 */
export function setCurrentActiveTabSettings(settings) {
    currentActiveTabSettings = settings;
}

/**
 * Render preset buttons from the shared INTERVAL_PRESETS list and update the presetButtons binding.
 * Idempotent: repeated localization updates reuse the existing buttons so click listeners survive.
 * @returns {void}
 */
export function buildPresetButtons() {
    if (presetButtons.length > 0) return;
    const section = document.querySelector('.presets-section');
    if (!section) return;
    section.replaceChildren(...INTERVAL_PRESETS.map(p => {
        const btn = document.createElement('button');
        btn.dataset.interval = p.value;
        btn.dataset.i18n = p.key;
        btn.textContent = p.key; // placeholder; localizePageElements() replaces it with the translation
        return btn;
    }));
    presetButtons = document.querySelectorAll('.presets-section button');
}


/**
 * Start (or restart) the 1s countdown display from the given remaining seconds. Clears any
 * existing interval first; if the value is NaN or <= 0 it stops the display instead. Shows
 * the timer section and ticks the displayed time down once per second (clamped at 0).
 * @param {number} initialRemainingSeconds - Seconds remaining until the next refresh.
 * @returns {void}
 */
export function startOrUpdateCountdownDisplay(initialRemainingSeconds) {
    if (countdownIntervalId) clearInterval(countdownIntervalId);

    let timeToDisplay = initialRemainingSeconds;
    if (isNaN(timeToDisplay) || timeToDisplay <= 0) {
        stopCountdownDisplay();
        return;
    }

    if (countdownTimerEl) countdownTimerEl.textContent = formatTime(timeToDisplay);
    if (timerDisplaySection) timerDisplaySection.style.display = 'block';
    if (countdownTimerEl) countdownTimerEl.style.display = 'block';

    countdownIntervalId = setInterval(() => {
        timeToDisplay--;
        if (countdownTimerEl) {
            countdownTimerEl.textContent = formatTime(timeToDisplay < 0 ? 0 : timeToDisplay);
        }
    }, 1000);
}

/**
 * Stop the countdown display: clear the 1s interval, reset the id, and hide the timer
 * section and the countdown element.
 * @returns {void}
 */
export function stopCountdownDisplay() {
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    countdownIntervalId = null;
    if (timerDisplaySection) timerDisplaySection.style.display = 'none';
    if (countdownTimerEl) countdownTimerEl.style.display = 'none';
}

/**
 * Resolve the effective display theme. 'auto' follows the OS color scheme
 * (prefers-color-scheme); 'light'/'dark' are returned as-is.
 * Intentionally duplicated in settings/settings.global.js — popup and settings
 * are separate module trees and deliberately share no code; keep both copies in sync.
 * @param {('auto'|'light'|'dark')} theme
 * @returns {('light'|'dark')}
 */
export function resolveTheme(theme) {
    if (theme === 'auto') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
}

/**
 * Synchronize the entire popup UI to the given tab/global state: apply the resolved theme,
 * compute whether jitter is active, set the status text (with a '~' marker when jitter is
 * active), refresh count, sound checkbox, refresh-mode/jitter-mode/recover-mode selects, the
 * jitter badge, preset/custom/range interval controls, button enablement, and the countdown display.
 * No-op when currentTabId is falsy.
 * @param {object} tabSettings - Per-tab refresh state (may be null/empty).
 * @param {object} globalSettings - Global settings (theme, jitter, defaults); falls back to { theme: 'auto' } when null/undefined.
 * @param {number} [remainingTimeForPopup] - Seconds remaining for the countdown; falls back to the interval.
 * @param {number} currentTabId - Active tab id; the function returns early if absent.
 * @returns {void}
 */
export function updateUIDisplay(tabSettings, globalSettings, remainingTimeForPopup, currentTabId) {
    if (!currentTabId) return;
    setCurrentActiveTabSettings(tabSettings || {}); // Store for startButton

    const effectiveTabSettings = tabSettings || {};
    const effectiveGlobalSettings = globalSettings || { theme: 'auto' };

    document.body?.classList.toggle('dark-theme', resolveTheme(effectiveGlobalSettings.theme) === 'dark');

    const currentInterval = effectiveTabSettings.interval;
    const isPaused = effectiveTabSettings.isPaused || false;
    // Is jitter active for this tab? A short copy of the resolveJitterPercent logic: popup is
    // a separate module tree and does not import background (like the duplicated
    // MIN_INTERVAL_SECONDS). Important: also factor in the % strength (as resolveJitterPercent
    // does), otherwise the popup tilde and the icon-title tilde would diverge when enabled=true
    // but percent is <= 0 / invalid.
    // A per-item percent (set by an interval RANGE) wins over the global %, but ONLY under an explicit
    // 'on' — mirroring resolveJitterPercent's total invariant, so a range tab shows its real strength.
    const jitterModeActive = effectiveTabSettings.jitterMode === 'on' ||
        (effectiveTabSettings.jitterMode !== 'off' && effectiveGlobalSettings.intervalJitterEnabled === true);
    const itemPercent = Number(effectiveTabSettings.jitterPercent);
    const usesItemPercent = effectiveTabSettings.jitterMode === 'on' && Number.isFinite(itemPercent) && itemPercent > 0;
    const jitterPercent = usesItemPercent ? itemPercent : Number(effectiveGlobalSettings.intervalJitterPercent);
    const jitterActive = jitterModeActive && Number.isFinite(jitterPercent) && jitterPercent > 0;

    // Use localized status strings
    let statusText;
    if (effectiveTabSettings.isActive) {
        if (isPaused) {
            statusText = t('pause');
        } else {
            // A separate key 'status_active', not 'status': popup.html already renders the
            // static prefix "Status:", otherwise we'd get a duplicated "Status: Status (60s)".
            // The tilde signals that the interval is randomized.
            statusText = `${t('status_active')} (${jitterActive ? '~' : ''}${currentInterval}s)`;
        }
    } else {
        statusText = t('idle');
    }
    if (statusMessageEl) statusMessageEl.textContent = statusText;

    if (refreshCountEl) refreshCountEl.textContent = effectiveTabSettings.refreshCount || 0;
    if (soundNotificationCheckbox) {
        soundNotificationCheckbox.checked = effectiveTabSettings.soundEnabled ?? effectiveGlobalSettings.defaultSoundEnabled ?? false;
    }
    if (refreshModeSelect) {
        refreshModeSelect.value = effectiveTabSettings.refreshMode || 'default';
    }
    if (jitterModeSelect) {
        jitterModeSelect.value = effectiveTabSettings.jitterMode || 'default';
    }
    if (recoverModeSelect) {
        recoverModeSelect.value = effectiveTabSettings.recoverMode || 'default';
    }

    // Badge under the timer: "<Random> +/-N%" only on an active tab with jitter enabled
    // (>0%). t('jitter_badge') is the localized prefix word.
    if (jitterIndicator) {
        if (jitterActive && effectiveTabSettings.isActive && !effectiveTabSettings.isPaused) {
            if (jitterIndicatorText) {
                const shownPct = Math.min(Math.round(jitterPercent), 100);
                jitterIndicatorText.textContent = `${t('jitter_badge')} ±${shownPct}%`;
            }
            jitterIndicator.style.display = 'inline-flex';
        } else {
            jitterIndicator.style.display = 'none';
        }
    }

    presetButtons.forEach(btn => {
        btn.classList.remove('active');
        if (effectiveTabSettings.isActive && !effectiveTabSettings.isCustom && parseInt(btn.dataset.interval) === currentInterval) {
            btn.classList.add('active');
        }
    });

    if (customIntervalInput) {
        if (effectiveTabSettings.isActive && effectiveTabSettings.isCustom) {
            customIntervalInput.value = currentInterval;
        } else if (!effectiveTabSettings.isActive) {
            customIntervalInput.value = '';
        }
    }

    // Reflect an active range back into the min/max inputs, derived from the stored (interval,
    // jitterPercent) pair — the range is never persisted as separate fields (see shared/intervalRange).
    if (rangeMinInput && rangeMaxInput) {
        if (usesItemPercent && effectiveTabSettings.isActive) {
            const { min, max } = baseAndPercentToRange(currentInterval, itemPercent);
            rangeMinInput.value = min;
            rangeMaxInput.value = max;
        } else if (!effectiveTabSettings.isActive) {
            rangeMinInput.value = '';
            rangeMaxInput.value = '';
        }
    }

    if (startButton) startButton.disabled = effectiveTabSettings.isActive && !isPaused;
    if (pauseButton) pauseButton.disabled = !effectiveTabSettings.isActive;
    if (stopButton) stopButton.disabled = !effectiveTabSettings.isActive;

    if (isPaused) {
        if (pauseButton) pauseButton.textContent = t('start');
        if (countdownIntervalId) clearInterval(countdownIntervalId);
        countdownIntervalId = null; // Mirror stopCountdownDisplay so no stale interval id lingers.
        let displayTime = remainingTimeForPopup !== undefined ? remainingTimeForPopup : currentInterval;
        if (countdownTimerEl) countdownTimerEl.textContent = formatTime(displayTime);
        if (timerDisplaySection) timerDisplaySection.style.display = displayTime > 0 ? 'block' : 'none';
        if (countdownTimerEl) countdownTimerEl.style.display = displayTime > 0 ? 'block' : 'none';
    } else {
        if (pauseButton) pauseButton.textContent = t('pause');
        if (effectiveTabSettings.isActive) {
            startOrUpdateCountdownDisplay(remainingTimeForPopup !== undefined ? remainingTimeForPopup : currentInterval);
        } else {
            stopCountdownDisplay();
        }
    }
    if (!effectiveTabSettings.isActive) {
        stopCountdownDisplay();
    }
}

/**
 * Fetch the current global settings (from sync storage) and per-tab state (from the
 * background service worker, via sendMessageWithRetry), then call updateUIDisplay to render
 * the popup. Migrates existing users whose stored settings predate the 'auto' theme option
 * (no theme key) to 'dark', and falls back to rendering an idle UI if the background does
 * not respond or an error occurs. No-op when currentTabId is falsy.
 * @param {number} currentTabId - The active tab id to fetch and render state for.
 * @returns {Promise<void>}
 */
export async function fetchAndUpdateUIPopup(currentTabId) {
    if (!currentTabId) return;
    // Get global settings first. Small prefs (theme/defaultSoundEnabled/language) live in
    // chrome.storage.sync (synced across devices); the big rule lists live in local, but the
    // popup doesn't need them, so we read only sync.
    const globalData = await chrome.storage.sync.get('globalSettings');
    const currentGlobalSettings = globalData.globalSettings || { theme: 'auto', defaultSoundEnabled: false };
    // Same migration as in background/settings.js: existing users whose settings were saved
    // before the 'auto' option existed (no theme key) are rendered as 'dark', not as empty/light.
    // The popup reads sync directly, so the background's in-memory guard does not reach here.
    if (globalData.globalSettings && !('theme' in currentGlobalSettings)) {
        currentGlobalSettings.theme = 'dark';
    }

    // Then get tab-specific state from background. Retry guards against the cold-start /
    // service-worker replacement race after update/sleep; otherwise an active tab would render idle.
    try {
        const response = await sendMessageWithRetry({ action: 'getTabState', tabId: currentTabId });
        if (response && response.settings) {
            updateUIDisplay(response.settings, currentGlobalSettings, response.remainingTimeForPopup, currentTabId);
        } else {
            // Fallback if background doesn't respond as expected
            updateUIDisplay({}, currentGlobalSettings, 0, currentTabId);
        }
    } catch (error) {
        console.error("Error fetching tab state after retries:", error.message);
        // updateUIDisplay({}) below sets the t('idle') status itself, so no separate assignment is needed
        updateUIDisplay({}, currentGlobalSettings, 0, currentTabId);
    }
}

/**
 * Wires popup controls to background tab-action messages.
 *
 * Exports setup functions for preset and range intervals, start/pause/stop, bulk actions, sound,
 * refresh mode, jitter mode, recovery mode, and settings. Turning recovery mode 'on' requests the
 * optional webNavigation permission from the same user gesture before sending the tab update.
 */
import {
    statusMessageEl,
    presetButtons,
    customIntervalInput,
    soundNotificationCheckbox,
    refreshModeSelect,
    jitterModeSelect,
    recoverModeSelect,
    currentActiveTabSettings,
    bulkResultEl
} from './ui.js';
import { t } from './i18n.js';
import { sendMessageWithRetry } from './utils.js';
import { rangeToBaseAndPercent, validateRange } from '../shared/intervalRange.js';

// Minimum/maximum allowed interval (seconds). 30s is Chrome's effective floor for alarms
// in a packed extension (see background/constants.js MIN_INTERVAL_SECONDS); anything lower
// is silently clamped to 30s, so we reject it rather than mislead the user.
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;

/**
 * Strictly parse a user-entered interval.
 * Rejects fractional, non-numeric, negative, and out-of-range values.
 * @param {*} raw - Raw input value from the custom interval field.
 * @returns {number|null} Integer seconds in range, or null when invalid.
 */
function parseIntervalInput(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_SECONDS || n > MAX_INTERVAL_SECONDS) {
        return null;
    }
    return n;
}

/**
 * Read the selected per-tab refresh mode from the popup.
 * @returns {('default'|'hard'|'normal'|string)}
 */
function getRefreshMode() {
    return refreshModeSelect ? refreshModeSelect.value : 'default';
}

/**
 * Read the selected per-tab jitter mode from the popup.
 * @returns {('default'|'on'|'off'|string)}
 */
function getJitterMode() {
    return jitterModeSelect ? jitterModeSelect.value : 'default';
}

/**
 * Read the selected per-tab auto-recovery mode from the popup.
 * @returns {('default'|'on'|'off'|string)}
 */
function getRecoverMode() {
    return recoverModeSelect ? recoverModeSelect.value : 'default';
}

/**
 * Request the optional webNavigation permission needed for auto-recovery.
 * Calls chrome.permissions.request directly inside the user gesture so the runtime prompt can
 * appear; the request is idempotent when already granted.
 * @returns {Promise<boolean>} true if the permission is granted after the request.
 */
async function ensureWebNavigationPermission() {
    try {
        return await chrome.permissions.request({ permissions: ['webNavigation'] });
    } catch (e) {
        console.warn('webNavigation permission request failed:', e?.message);
        return false;
    }
}

/**
 * Send a message to the background service worker with retry handling.
 * Logs failures and shows a truncated error in the popup status line.
 * @param {object} message - Runtime message to send.
 * @returns {Promise<void>}
 */
async function sendMessageToBackground(message) {
    try {
        // Retry against a cold or replacing service worker; otherwise the first
        // Start/Stop click would be silently lost. Mutations are idempotent on the background side,
        // so a duplicate is harmless.
        await sendMessageWithRetry(message);
        // UI updates are now primarily driven by storage changes or direct 'updatePopupUI' messages.
    } catch (error) {
        console.error("Popup error in eventHandlers:", error.message);
        if (statusMessageEl) statusMessageEl.textContent = `Error: ${error.message.substring(0, 100)}`;
    }
}

/**
 * Attach click listeners to preset buttons that start refreshes for the current tab.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @returns {void}
 */
export function setupPresetButtonListeners(currentTabId) {
    presetButtons.forEach(button => {
        button.addEventListener('click', () => {
            if (!currentTabId) return;
            const interval = parseInt(button.dataset.interval);
            sendMessageToBackground({
                action: 'start', tabId: currentTabId, interval: interval,
                isCustom: false, soundEnabled: soundNotificationCheckbox.checked,
                refreshMode: getRefreshMode(), jitterMode: getJitterMode(), recoverMode: getRecoverMode()
            });
        });
    });
}

/**
 * Attach the custom interval button listener.
 * Validates input and starts a custom refresh, or shows the minimum-interval warning.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @param {HTMLInputElement} customIntervalInputElement - Custom interval input.
 * @param {HTMLElement} setCustomIntervalBtnElement - Button that applies the custom interval.
 * @returns {void}
 */
export function setupCustomIntervalButtonListener(currentTabId, customIntervalInputElement, setCustomIntervalBtnElement) {
    setCustomIntervalBtnElement.addEventListener('click', () => {
        if (!currentTabId) return;
        const interval = parseIntervalInput(customIntervalInputElement.value);
        if (interval !== null) {
            sendMessageToBackground({
                action: 'start', tabId: currentTabId, interval: interval,
                isCustom: true, soundEnabled: soundNotificationCheckbox.checked,
                refreshMode: getRefreshMode(), jitterMode: getJitterMode(), recoverMode: getRecoverMode()
            });
        } else {
            if (statusMessageEl) statusMessageEl.textContent = t('min_interval_warning');
            customIntervalInputElement.value = '';
        }
    });
}

/**
 * Attach the Start button listener.
 * Chooses the interval from custom input, active preset, first preset, or a 60-second fallback when
 * the tab is idle or paused; otherwise reuses the current interval.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @param {HTMLElement} startBtnElement - Start button.
 * @param {HTMLInputElement} customIntervalInputElement - Custom interval input.
 * @returns {void}
 */
export function setupStartButtonListener(currentTabId, startBtnElement, customIntervalInputElement) {
     startBtnElement.addEventListener('click', () => {
        if (!currentTabId) return;
        let intervalToStart = currentActiveTabSettings.interval;
        let isCustom = currentActiveTabSettings.isCustom || false;
        let isCurrentlyPaused = currentActiveTabSettings.isPaused || false;

        if (!currentActiveTabSettings.isActive || isCurrentlyPaused) {
            const customVal = parseIntervalInput(customIntervalInputElement.value);
            if (customVal !== null) {
                intervalToStart = customVal;
                isCustom = true;
            } else {
                const activePreset = document.querySelector('.presets-section button.active');
                if (activePreset?.dataset?.interval) {
                    const parsed = parseInt(activePreset.dataset.interval, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        intervalToStart = parsed;
                        isCustom = false;
                    }
                } else if (!intervalToStart && presetButtons?.length > 0 && presetButtons[0]?.dataset?.interval) {
                    const parsed = parseInt(presetButtons[0].dataset.interval, 10);
                    intervalToStart = !isNaN(parsed) && parsed > 0 ? parsed : 60;
                    isCustom = false;
                } else if (!intervalToStart) {
                    intervalToStart = 60; // Fallback default
                    isCustom = false;
                }
            }
        }
        sendMessageToBackground({
            action: 'start', tabId: currentTabId, interval: intervalToStart,
            isCustom: isCustom, soundEnabled: soundNotificationCheckbox.checked,
            refreshMode: getRefreshMode(), jitterMode: getJitterMode(), recoverMode: getRecoverMode()
        });
    });
}

/**
 * Attach the range button listener. Validates the raw [min, max] (before any clamp), converts it to a
 * midpoint interval plus jitter percent, and starts the tab with jitterMode 'on' for a non-zero range
 * or 'off' for a fixed interval. Shows the invalid-range hint on bad input.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @param {HTMLInputElement} minInput - Range minimum input.
 * @param {HTMLInputElement} maxInput - Range maximum input.
 * @param {HTMLElement} setRangeBtn - Button that applies the range.
 * @returns {void}
 */
export function setupRangeButtonListener(currentTabId, minInput, maxInput, setRangeBtn) {
    if (!setRangeBtn) return;
    setRangeBtn.addEventListener('click', () => {
        if (!currentTabId) return;
        const check = validateRange(minInput.value, maxInput.value, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
        if (!check.ok) {
            if (statusMessageEl) statusMessageEl.textContent = t('interval_range_invalid');
            return;
        }
        const { min, max, interval, jitterPercent } = rangeToBaseAndPercent(Number(minInput.value), Number(maxInput.value));
        // Snap the inputs to the effective (even-sum) bounds so the user sees exactly what will run.
        minInput.value = min;
        maxInput.value = max;
        // A zero-width range (min === max, or a range that collapses to one value after the even-sum
        // snap) yields jitterPercent 0. Emitting jitterMode 'on' with a 0 percent would break the
        // resolver's range<->mode invariant (a non-zero percent must accompany 'on'); resolveJitterPercent
        // would then fall back to the GLOBAL percent and randomize an interval the user pinned to a fixed
        // value. Send 'off' instead — a zero-width range IS a fixed interval with no jitter.
        const rangeJitterMode = jitterPercent > 0 ? 'on' : 'off';
        sendMessageToBackground({
            action: 'start', tabId: currentTabId, interval: interval,
            isCustom: true, soundEnabled: soundNotificationCheckbox.checked,
            refreshMode: getRefreshMode(), jitterMode: rangeJitterMode, jitterPercent: jitterPercent, recoverMode: getRecoverMode()
        });
    });
}

/**
 * Attach the Pause/Resume button listener.
 * Sends resume when the tab is paused, otherwise pause.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @param {HTMLElement} pauseBtnElement - Pause/resume button.
 * @returns {void}
 */
export function setupPauseButtonListener(currentTabId, pauseBtnElement) {
    pauseBtnElement.addEventListener('click', () => {
        if (!currentTabId) return;
        sendMessageToBackground({
            action: currentActiveTabSettings.isPaused ? 'resume' : 'pause',
            tabId: currentTabId
        });
    });
}

/**
 * Attach the Stop button listener.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @param {HTMLElement} stopBtnElement - Stop button.
 * @returns {void}
 */
export function setupStopButtonListener(currentTabId, stopBtnElement) {
    stopBtnElement.addEventListener('click', () => {
        if (!currentTabId) return;
        sendMessageToBackground({ action: 'stop', tabId: currentTabId });
    });
}

/**
 * Attach the sound-notification checkbox change listener.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @returns {void}
 */
export function setupSoundNotificationListener(currentTabId) {
    soundNotificationCheckbox.addEventListener('change', () => {
        if (!currentTabId) return;
        sendMessageToBackground({
            action: 'updateSoundSetting', tabId: currentTabId,
            soundEnabled: soundNotificationCheckbox.checked
        });
    });
}

/**
 * Attach the refresh-mode select change listener.
 * Persists the per-tab cache mode for both idle and active tabs.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @returns {void}
 */
export function setupRefreshModeListener(currentTabId) {
    if (!refreshModeSelect) return;
    refreshModeSelect.addEventListener('change', () => {
        if (!currentTabId) return;
        // Persist the choice immediately, even for an idle tab, so it is remembered
        // and applied on the next refresh (active tabs pick it up on the following alarm).
        sendMessageToBackground({
            action: 'updateRefreshMode', tabId: currentTabId,
            refreshMode: refreshModeSelect.value
        });
    });
}

/**
 * Attach the jitter-mode select change listener.
 * Persists per-tab jitter mode; the background reschedules active tabs because jitter changes alarm type.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @returns {void}
 */
export function setupJitterModeListener(currentTabId) {
    if (!jitterModeSelect) return;
    jitterModeSelect.addEventListener('change', () => {
        if (!currentTabId) return;
        // Persist immediately. For an ACTIVE tab the background reschedules the alarm to the
        // correct one-shot/periodic type right away (see messageHandler 'updateJitterMode').
        sendMessageToBackground({
            action: 'updateJitterMode', tabId: currentTabId,
            jitterMode: jitterModeSelect.value
        });
    });
}

/**
 * Attach the recover-mode select change listener.
 * Turning recovery 'on' requests the optional webNavigation permission within the gesture, reverts
 * the select if declined, and then persists the tri-state per-tab recovery mode.
 * @param {number|null|undefined} currentTabId - Active tab id to target.
 * @returns {void}
 */
export function setupRecoverModeListener(currentTabId) {
    if (!recoverModeSelect) return;
    recoverModeSelect.addEventListener('change', async () => {
        if (!currentTabId) return;
        const chosen = recoverModeSelect.value;
        if (chosen === 'on') {
            const granted = await ensureWebNavigationPermission();
            if (!granted) {
                // Revert to the last persisted value and tell the user why nothing changed.
                recoverModeSelect.value = currentActiveTabSettings.recoverMode || 'default';
                if (statusMessageEl) statusMessageEl.textContent = t('recover_permission_denied');
                return;
            }
        }
        sendMessageToBackground({
            action: 'updateRecoverMode', tabId: currentTabId,
            recoverMode: chosen
        });
    });
}

/**
 * Attach the settings button listener that opens the extension options page.
 * @param {HTMLElement|null} settingsBtnElement - Settings button.
 * @returns {void}
 */
export function setupSettingsButtonListener(settingsBtnElement) {
    if(settingsBtnElement) settingsBtnElement.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
}

/**
 * Render a bulk action's aggregate result and any non-zero skipped, capped, or failed counts in the
 * bulk-result line. Substitutes localized {token} placeholders.
 * @param {object|null|undefined} result - The bulk result object from the background.
 * @returns {void}
 */
function renderBulkResult(result) {
    if (!bulkResultEl) return;
    if (!result || result.ineligible || result.total === 0) {
        bulkResultEl.textContent = t('bulk_none_eligible');
        return;
    }
    const parts = [];
    if ('started' in result) {
        parts.push(t('bulk_result').replace('{started}', result.started).replace('{total}', result.total));
        if (result.capped > 0) parts.push(t('bulk_capped').replace('{capped}', result.capped));
    } else {
        parts.push(t('bulk_result_stop').replace('{stopped}', result.stopped).replace('{total}', result.total));
    }
    if (result.skipped > 0) parts.push(t('bulk_skipped').replace('{skipped}', result.skipped));
    if (result.failed > 0) parts.push(t('bulk_failed').replace('{failed}', result.failed));
    bulkResultEl.textContent = parts.join(' · ');
}

/** All bulk buttons, disabled together while any bulk request is in flight. */
const bulkButtonIds = ['bulk-start-window', 'bulk-stop-window', 'bulk-toggle-group'];

/**
 * Enable or disable every bulk button to prevent duplicate requests while one is in flight.
 * @param {boolean} disabled - Whether the buttons should be disabled.
 * @returns {void}
 */
function setBulkButtonsDisabled(disabled) {
    for (const id of bulkButtonIds) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = disabled;
    }
}

/**
 * Send a bulk message and render its aggregate result. Unlike sendMessageToBackground this KEEPS the
 * response (the counts) and shows the summary. Bulk buttons are disabled for the duration.
 * @param {object} message - The bulk runtime message.
 * @param {{idempotent?: boolean}} [opts] - idempotent=false (a toggle) sends a SINGLE attempt with no
 *   retry: retrying a non-idempotent toggle whose response was lost could undo the first action.
 * @returns {Promise<void>}
 */
async function sendBulkMessage(message, { idempotent = true } = {}) {
    setBulkButtonsDisabled(true);
    try {
        const response = await sendMessageWithRetry(message, idempotent ? {} : { attempts: 1 });
        renderBulkResult(response && response.result);
    } catch (error) {
        console.error('Popup bulk error:', error.message);
        if (bulkResultEl) bulkResultEl.textContent = `${t('bulk_error')}: ${error.message.substring(0, 80)}`;
    } finally {
        setBulkButtonsDisabled(false);
    }
}

/**
 * Attach the bulk start/stop/toggle listeners for the window and (when the active tab is grouped)
 * its group. The group row stays hidden for an ungrouped tab (groupId < 0), so the group action is
 * only offered when it is meaningful.
 * @param {chrome.tabs.Tab|null} currentTab - The active tab; its windowId/groupId scope the actions.
 * @returns {void}
 */
export function setupBulkListeners(currentTab) {
    const bulkStartBtn = document.getElementById('bulk-start-window');
    const bulkStopBtn = document.getElementById('bulk-stop-window');
    const groupRow = document.getElementById('bulk-group-row');
    const groupBtn = document.getElementById('bulk-toggle-group');
    const windowId = currentTab ? currentTab.windowId : undefined;
    const groupId = currentTab ? currentTab.groupId : undefined;

    // Window start/stop are idempotent, so they keep the retry that guards a cold/replacing worker.
    if (bulkStartBtn) {
        bulkStartBtn.addEventListener('click', () => sendBulkMessage({ action: 'bulkStartWindow', windowId }));
    }
    if (bulkStopBtn) {
        bulkStopBtn.addEventListener('click', () => sendBulkMessage({ action: 'bulkStopWindow', windowId }));
    }
    // Reveal the group control only for a grouped tab. Chrome uses -1 (TAB_GROUP_ID_NONE) for an
    // ungrouped tab, so a non-negative integer groupId means the tab is in a group.
    if (groupRow && Number.isInteger(groupId) && groupId >= 0) {
        groupRow.hidden = false;
        if (groupBtn) {
            // A toggle is NOT idempotent — send a single attempt so a lost response can't undo it.
            groupBtn.addEventListener('click', () => sendBulkMessage({ action: 'bulkToggleGroup', groupId }, { idempotent: false }));
        }
    }
}

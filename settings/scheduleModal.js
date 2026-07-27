/**
 * Builds the add/edit scheduled-refresh modal for URL, interval, refresh mode, jitter mode,
 * recovery mode, and enabled state.
 */

import { t } from './chromeI18n.js';
import { INTERVAL_PRESETS } from './timeFormat.js';
import { REFRESH_MODES } from './refreshModes.js';
import { JITTER_MODES } from './jitterModes.js';
import { RECOVER_MODES } from './recoverModes.js';
import { ensureWebNavigationPermission } from './permissions.js';

/**
 * Open the add/edit schedule modal.
 * @param {Object} opts
 * @param {Object} [opts.initial] - Prefilled values: { url, interval, enabled, refreshMode, jitterMode, recoverMode }.
 * @param {boolean} [opts.isEdit] - true when editing (changes the title and primary button).
 * @param {(data: Object) => (string|null)} [opts.validate] - Returns an error message to keep
 *        the modal open and show it inline, or a falsy value to accept and close.
 * @returns {Promise<Object|null>} Resolved schedule data { url, interval, enabled, refreshMode, jitterMode, recoverMode }
 *          on save, or null if cancelled/dismissed.
 */
export function openScheduleModal({ initial = {}, isEdit = false, validate } = {}) {
    return new Promise((resolve) => {
        // Remember the trigger element so focus returns to it after the dialog closes.
        const previouslyFocused = document.activeElement;
        const data = {
            url: initial.url || '',
            interval: initial.interval || 300,
            enabled: initial.enabled !== false,
            refreshMode: initial.refreshMode || 'default',
            jitterMode: initial.jitterMode || 'default',
            recoverMode: initial.recoverMode || 'default',
        };

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const modal = document.createElement('div');
        modal.className = 'modal modal-form';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const title = document.createElement('h3');
        title.className = 'modal-title';
        title.textContent = isEdit ? t('edit_scheduled') : t('add_new_scheduled');

        const errorEl = document.createElement('p');
        errorEl.className = 'modal-form-error';
        errorEl.style.display = 'none';

        // --- URL field ---
        const urlField = document.createElement('div');
        urlField.className = 'modal-field';
        const urlLabel = document.createElement('label');
        urlLabel.textContent = t('scheduled_url');
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.value = data.url;
        urlInput.placeholder = t('scheduled_url_placeholder');
        urlField.appendChild(urlLabel);
        urlField.appendChild(urlInput);

        // --- Interval field ---
        const intervalField = document.createElement('div');
        intervalField.className = 'modal-field';
        const intervalLabel = document.createElement('label');
        intervalLabel.textContent = t('refresh_interval');
        const intervalSelect = document.createElement('select');
        for (const p of INTERVAL_PRESETS) {
            const opt = document.createElement('option');
            opt.value = String(p.value);
            opt.textContent = t(p.key);
            intervalSelect.appendChild(opt);
        }
        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = t('custom');
        intervalSelect.appendChild(customOpt);
        intervalField.appendChild(intervalLabel);
        intervalField.appendChild(intervalSelect);

        // --- Custom time inputs (shown only when "custom" is selected) ---
        const customField = document.createElement('div');
        customField.className = 'modal-field custom-time-inputs';
        const customLabel = document.createElement('label');
        customLabel.textContent = t('custom_interval');
        const timeRow = document.createElement('div');
        timeRow.className = 'time-inputs-row';
        const hoursInput = makeNumberInput('H', 0, 99);
        const minutesInput = makeNumberInput('M', 0, 59);
        const secondsInput = makeNumberInput('S', 0, 59);
        timeRow.appendChild(hoursInput);
        timeRow.appendChild(makeColon());
        timeRow.appendChild(minutesInput);
        timeRow.appendChild(makeColon());
        timeRow.appendChild(secondsInput);
        // Persistent hint about the 30s minimum interval, shown instead of silently clamping on save.
        const customHint = document.createElement('small');
        customHint.className = 'input-hint';
        customHint.textContent = t('min_interval_warning');
        customField.appendChild(customLabel);
        customField.appendChild(timeRow);
        customField.appendChild(customHint);

        // --- Refresh mode field ---
        const modeField = document.createElement('div');
        modeField.className = 'modal-field';
        const modeLabel = document.createElement('label');
        modeLabel.textContent = t('refresh_mode');
        const modeSelect = document.createElement('select');
        for (const m of REFRESH_MODES) {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = t(m.key);
            modeSelect.appendChild(opt);
        }
        modeSelect.value = data.refreshMode;
        modeField.appendChild(modeLabel);
        modeField.appendChild(modeSelect);

        // --- Jitter mode field ---
        const jitterField = document.createElement('div');
        jitterField.className = 'modal-field';
        const jitterLabel = document.createElement('label');
        jitterLabel.textContent = t('jitter_mode');
        const jitterSelect = document.createElement('select');
        for (const m of JITTER_MODES) {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = t(m.key);
            jitterSelect.appendChild(opt);
        }
        jitterSelect.value = data.jitterMode;
        jitterField.appendChild(jitterLabel);
        jitterField.appendChild(jitterSelect);

        // --- Recover mode field ---
        const recoverField = document.createElement('div');
        recoverField.className = 'modal-field';
        const recoverLabel = document.createElement('label');
        recoverLabel.textContent = t('recover_mode');
        const recoverSelect = document.createElement('select');
        for (const m of RECOVER_MODES) {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = t(m.key);
            recoverSelect.appendChild(opt);
        }
        recoverSelect.value = data.recoverMode;
        recoverField.appendChild(recoverLabel);
        recoverField.appendChild(recoverSelect);
        // Turning recovery 'on' needs the optional webNavigation permission. Request it inside this
        // change gesture; requesting after the modal Promise resolves would already be past the
        // transient user activation and silently fail. Revert to 'default' and notify if declined.
        recoverSelect.addEventListener('change', async () => {
            if (recoverSelect.value !== 'on') return;
            const granted = await ensureWebNavigationPermission();
            if (!granted) {
                // Revert to the value the rule had before this change (not a hard-coded 'default') — e.g.
                // an existing 'off' rule must stay 'off', not silently become 'default' (which inherits global).
                recoverSelect.value = data.recoverMode;
                showError(t('recover_permission_denied'));
            }
        });

        // --- Enabled checkbox ---
        const enabledField = document.createElement('div');
        enabledField.className = 'modal-field modal-field-checkbox';
        const enabledInput = document.createElement('input');
        enabledInput.type = 'checkbox';
        enabledInput.id = 'modal-schedule-enabled';
        enabledInput.checked = data.enabled;
        const enabledLabel = document.createElement('label');
        enabledLabel.setAttribute('for', 'modal-schedule-enabled');
        enabledLabel.textContent = t('enabled');
        enabledField.appendChild(enabledInput);
        enabledField.appendChild(enabledLabel);

        // --- Actions ---
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn-cancel';
        cancelBtn.textContent = t('cancel');
        const saveBtn = document.createElement('button');
        saveBtn.className = 'modal-btn modal-btn-confirm';
        saveBtn.textContent = isEdit ? t('update_schedule') : t('add_schedule');
        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);

        modal.appendChild(title);
        modal.appendChild(errorEl);
        modal.appendChild(urlField);
        modal.appendChild(intervalField);
        modal.appendChild(customField);
        modal.appendChild(modeField);
        modal.appendChild(jitterField);
        modal.appendChild(recoverField);
        modal.appendChild(enabledField);
        modal.appendChild(actions);

        document.body.appendChild(backdrop);
        document.body.appendChild(modal);

        // Seed the interval inputs from the initial value and toggle custom visibility.
        setIntervalInputs(data.interval, intervalSelect, hoursInput, minutesInput, secondsInput);
        updateCustomVisibility();

        requestAnimationFrame(() => {
            backdrop.classList.add('modal-backdrop-visible');
            modal.classList.add('modal-visible');
        });
        urlInput.focus();

        /**
         * Show or hide the custom H:M:S inputs based on the interval dropdown.
         * @returns {void}
         */
        function updateCustomVisibility() {
            customField.style.display = intervalSelect.value === 'custom' ? '' : 'none';
        }
        intervalSelect.addEventListener('change', updateCustomVisibility);

        /**
         * Read the interval in seconds from custom H:M:S inputs or from the selected preset.
         * @returns {number|null} Positive interval in seconds, or null when invalid.
         */
        function getInterval() {
            if (intervalSelect.value === 'custom') {
                const h = parseInt(hoursInput.value) || 0;
                const m = parseInt(minutesInput.value) || 0;
                const s = parseInt(secondsInput.value) || 0;
                const total = (h * 3600) + (m * 60) + s;
                return total > 0 ? total : null;
            }
            return parseInt(intervalSelect.value) || null;
        }

        /**
         * Render an inline modal validation error.
         * @param {string} msg - Error message to display.
         * @returns {void}
         */
        function showError(msg) {
            errorEl.textContent = msg;
            errorEl.style.display = '';
        }

        /**
         * Close the modal, remove listeners/elements, restore focus, and resolve the Promise.
         * @param {Object|null} result - Schedule data to return, or null when cancelled.
         * @returns {void}
         */
        function cleanup(result) {
            backdrop.classList.remove('modal-backdrop-visible');
            modal.classList.remove('modal-visible');
            document.removeEventListener('keydown', handleKeydown);
            setTimeout(() => {
                backdrop.remove();
                modal.remove();
            }, 200);
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                previouslyFocused.focus();
            }
            resolve(result);
        }

        /**
         * Collect modal values, validate them, and close with the result when valid.
         * @returns {void}
         */
        function attemptSave() {
            const result = {
                url: urlInput.value.trim(),
                interval: getInterval(),
                enabled: enabledInput.checked,
                refreshMode: modeSelect.value,
                jitterMode: jitterSelect.value,
                recoverMode: recoverSelect.value,
            };
            if (validate) {
                const err = validate(result);
                if (err) { showError(err); return; }
            }
            cleanup(result);
        }

        saveBtn.addEventListener('click', attemptSave);
        cancelBtn.addEventListener('click', () => cleanup(null));
        backdrop.addEventListener('click', () => cleanup(null));

        /**
         * Close the modal on Escape.
         * @param {KeyboardEvent} e - Keydown event.
         * @returns {void}
         */
        function handleKeydown(e) {
            if (e.key === 'Escape') cleanup(null);
        }
        document.addEventListener('keydown', handleKeydown);
    });
}

/**
 * Create a numeric <input> for an H/M/S time segment.
 * @param {string} placeholder - Placeholder text (e.g. 'H', 'M', 'S').
 * @param {number} min - Minimum allowed value (sets the input's min attribute).
 * @param {number} max - Maximum allowed value (sets the input's max attribute).
 * @returns {HTMLInputElement} The configured number input.
 */
function makeNumberInput(placeholder, min, max) {
    const input = document.createElement('input');
    input.type = 'number';
    input.placeholder = placeholder;
    input.min = String(min);
    input.max = String(max);
    return input;
}

/**
 * Create a ':' separator <span> placed between the H:M:S time inputs.
 * @returns {HTMLSpanElement} The colon separator element.
 */
function makeColon() {
    const span = document.createElement('span');
    span.textContent = ':';
    return span;
}

/**
 * Set the preset dropdown / custom H:M:S inputs from a total seconds value.
 * If totalSeconds matches a preset, selects that preset and clears the H:M:S fields;
 * otherwise selects 'custom' and fills H:M:S broken out from the total.
 * @param {number} totalSeconds - The interval in seconds to display.
 * @param {HTMLSelectElement} intervalSelect - The preset dropdown to set.
 * @param {HTMLInputElement} hoursInput - The hours input.
 * @param {HTMLInputElement} minutesInput - The minutes input.
 * @param {HTMLInputElement} secondsInput - The seconds input.
 */
function setIntervalInputs(totalSeconds, intervalSelect, hoursInput, minutesInput, secondsInput) {
    const preset = INTERVAL_PRESETS.find(p => p.value === totalSeconds);
    if (preset) {
        intervalSelect.value = String(preset.value);
        hoursInput.value = '';
        minutesInput.value = '';
        secondsInput.value = '';
    } else {
        intervalSelect.value = 'custom';
        hoursInput.value = Math.floor(totalSeconds / 3600);
        minutesInput.value = Math.floor((totalSeconds % 3600) / 60);
        secondsInput.value = totalSeconds % 60;
    }
}

/**
 * Wires settings-profile export and import controls.
 *
 * Export downloads the in-memory global settings as JSON. Import parses a selected JSON file,
 * validates it contains at least one recognized settings key (including pauseWhileActiveEnabled),
 * merges it over current settings, downgrades recovery settings when webNavigation is absent,
 * persists the result, and reloads the settings UI.
 */
import { getGlobalSettings, setGlobalSettings, saveAndApplyGlobalSettings, loadGlobalSettings } from './settings.global.js';
import { showToast } from './modal.js';
import { t } from './chromeI18n.js';
import { hasWebNavigationPermission } from './permissions.js';

/**
 * Wire click/change listeners for the settings-profile export and import controls.
 * Export serializes the current global settings object to a downloaded JSON file.
 * Import reads the selected file, JSON-parses it, accepts it only if it contains at
 * least one recognized settings key, including pauseWhileActiveEnabled, merges it over the current settings (imported
 * values win), saves and applies via saveAndApplyGlobalSettings, then re-runs
 * loadGlobalSettings so all passed-in UI controls reflect the new values; the file
 * input is reset afterward. Invalid or unparseable input shows an error toast.
 * @param {HTMLElement|null} exportProfilesButton - Button that triggers export.
 * @param {HTMLElement|null} importProfilesButton - Button that opens the file picker.
 * @param {HTMLInputElement|null} importProfilesInput - Hidden file input the import reads from.
 * @param {HTMLSelectElement} themeSelect - Theme control, refreshed after import.
 * @param {HTMLInputElement} globalSoundNotificationCheckbox - Sound toggle, refreshed after import.
 * @param {HTMLInputElement} autoRestoreTimersCheckbox - Auto-restore-timers toggle, refreshed after import.
 * @param {HTMLInputElement} bypassCacheOnRefreshCheckbox - Bypass-cache toggle, refreshed after import.
 * @param {HTMLTextAreaElement} whitelistUrlsTextarea - Whitelist patterns, refreshed after import.
 * @param {HTMLTextAreaElement} blacklistUrlsTextarea - Blacklist patterns, refreshed after import.
 * @param {Function} renderScheduledRefreshesFunc - Re-renders the scheduled-refresh list after import.
 * @param {Function} loadActivityLogFunc - Reloads the activity log after import.
 * @param {HTMLSelectElement|null} [languageSelect=null] - Language control, refreshed after import.
 * @param {HTMLInputElement|null} [intervalJitterEnabledCheckbox=null] - Global jitter toggle, refreshed after import.
 * @param {HTMLElement|null} [intervalJitterPercentButtons=null] - Jitter-percent buttons, refreshed after import.
 * @param {HTMLInputElement|null} [autoRecoverEnabledCheckbox=null] - Global auto-recovery toggle, refreshed after import.
 * @param {HTMLInputElement|null} [pauseWhileActiveEnabledCheckbox=null] - Global smart-pause toggle, refreshed after import.
 * @returns {void}
 */
export function setupProfileHandlers(
    exportProfilesButton,
    importProfilesButton,
    importProfilesInput,
    // For re-loading settings after import
    themeSelect,
    globalSoundNotificationCheckbox,
    autoRestoreTimersCheckbox,
    bypassCacheOnRefreshCheckbox,
    whitelistUrlsTextarea,
    blacklistUrlsTextarea,
    renderScheduledRefreshesFunc,
    loadActivityLogFunc,
    languageSelect = null,
    intervalJitterEnabledCheckbox = null,
    intervalJitterPercentButtons = null,
    autoRecoverEnabledCheckbox = null,
    pauseWhileActiveEnabledCheckbox = null
) {
    if (exportProfilesButton) {
        exportProfilesButton.addEventListener('click', () => {
            const content = JSON.stringify(getGlobalSettings(), null, 2);
            const blob = new Blob([content], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'pages-auto-updater-settings.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast(t('profile_exported'), 'success');
        });
    }

    if (importProfilesButton && importProfilesInput) {
        importProfilesButton.addEventListener('click', () => importProfilesInput.click());
        importProfilesInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const imported = JSON.parse(e.target.result);
                        // Basic validation for the imported structure: accept files that contain at least
                        // one known global-settings key, including the smart-pause toggle.
                        if (imported && (imported.theme !== undefined || imported.language !== undefined || imported.whitelist !== undefined || imported.scheduledRefreshes !== undefined || imported.blacklist !== undefined || imported.defaultSoundEnabled !== undefined || imported.intervalJitterEnabled !== undefined || imported.autoRecoverEnabled !== undefined || imported.pauseWhileActiveEnabled !== undefined)) {
                            // Merge with existing settings to preserve any settings not in the imported file,
                            // or overwrite if the imported file is considered a complete replacement.
                            // Here, we'll merge, giving precedence to imported values.
                            const merged = { ...getGlobalSettings(), ...imported };
                            // Auto-recovery needs the optional webNavigation permission, which cannot be
                            // requested from this async file-load callback because there is no live user
                            // gesture. If it is not granted, downgrade imported recovery-on settings so the
                            // UI never shows an enabled recovery state that would silently do nothing.
                            let recoveryDowngraded = false;
                            if (!(await hasWebNavigationPermission())) {
                                if (merged.autoRecoverEnabled) { merged.autoRecoverEnabled = false; recoveryDowngraded = true; }
                                if (Array.isArray(merged.scheduledRefreshes)) {
                                    for (const rule of merged.scheduledRefreshes) {
                                        if (rule && rule.recoverMode === 'on') { rule.recoverMode = 'off'; recoveryDowngraded = true; }
                                    }
                                }
                            }
                            setGlobalSettings(merged);
                            await saveAndApplyGlobalSettings();
                            // Reload all settings to reflect changes in UI from all modules
                            await loadGlobalSettings(
                                themeSelect,
                                globalSoundNotificationCheckbox,
                                autoRestoreTimersCheckbox,
                                bypassCacheOnRefreshCheckbox,
                                whitelistUrlsTextarea,
                                blacklistUrlsTextarea,
                                renderScheduledRefreshesFunc,
                                loadActivityLogFunc,
                                languageSelect,
                                intervalJitterEnabledCheckbox,
                                intervalJitterPercentButtons,
                                autoRecoverEnabledCheckbox,
                                pauseWhileActiveEnabledCheckbox
                            );
                            showToast(t('profile_imported'), 'success');
                            if (recoveryDowngraded) showToast(t('recover_permission_denied'), 'info');
                        } else {
                            showToast(t('profile_invalid'), 'error');
                        }
                    } catch (error) {
                        console.error('Error importing settings:', error);
                        showToast(t('profile_import_error'), 'error');
                    }
                };
                reader.readAsText(file);
                importProfilesInput.value = ''; // Reset file input
            }
        });
    }
}

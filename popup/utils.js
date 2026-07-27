// Popup utility helpers: MM:SS time formatting for the countdown display and a
// retry/backoff wrapper around chrome.runtime.sendMessage that tolerates a cold or
// mid-replacement service worker after an extension update or wake-from-sleep.

/**
 * Format a duration in seconds as a zero-padded MM:SS string.
 * Returns "00:00" for NaN or negative input. Minutes are not capped, so durations
 * over an hour render as e.g. "75:00" rather than rolling into an hours field.
 * @param {number} totalSeconds duration in whole seconds
 * @returns {string} the duration formatted as "MM:SS"
 */
export function formatTime(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) return "00:00";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Send a message to the background service worker with retry + backoff. Right after an extension
 * update or a wake from sleep the SW may be cold-starting or mid-replacement, so
 * chrome.runtime.sendMessage can reject ('Could not establish connection' / 'Extension context
 * invalidated') or resolve with undefined. Without retry the popup renders an actively-refreshing
 * tab as idle and silently drops the first Start/Stop click. Retries with increasing backoff
 * (300/900/2700ms) and only throws after all attempts are exhausted. Mutations (start/stop/pause)
 * are idempotent on the background side, so a retried duplicate is harmless.
 * (Mirror of settings/settings.statistics.js sendStatsMessage — popup and settings are separate
 * module trees and deliberately share no code; keep both copies in sync.)
 * @param {object} message
 * @param {{attempts?: number}} [opts]
 * @returns {Promise<any>} the background response (status !== 'error')
 * @throws {Error} the last messaging or background-response error after all attempts fail
 */
export async function sendMessageWithRetry(message, { attempts = 4 } = {}) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await chrome.runtime.sendMessage(message);
            if (response === undefined) {
                throw new Error('No response from background (service worker likely starting)');
            }
            if (response.status === 'error') {
                throw new Error(response.message || 'Background returned an error');
            }
            return response;
        } catch (error) {
            lastError = error;
            if (i < attempts - 1) {
                const delayMs = Math.min(300 * Math.pow(3, i), 3000); // 300, 900, 2700ms
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
}

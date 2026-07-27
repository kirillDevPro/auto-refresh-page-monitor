// Notification module for the service worker: plays refresh notification sounds
// through an offscreen document (MV3 service workers cannot play audio directly)
// and maintains a size- and age-capped activity log in chrome.storage.local,
// with all log writes serialized to avoid concurrent read-modify-write races.
import { SOUND_FILE, MAX_LOG_ENTRIES } from './constants.js';

/**
 * Fire-and-forget send of the playSound message to the offscreen document.
 * The .catch() is mandatory: an unhandled rejection from chrome.runtime.sendMessage
 * trips the global error handler's resetInitialization(), forcing a full re-bootstrap.
 */
function sendPlaySoundMessage() {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'playSound', sound: SOUND_FILE })
        .catch(e => console.warn('Failed to send playSound to offscreen document:', e.message));
}

/**
 * Play the refresh notification sound via an offscreen document.
 * Reuses an existing OFFSCREEN_DOCUMENT context if one is active; otherwise creates
 * one (waiting ~50ms for offscreen.js to register its onMessage listener) before sending.
 * Tolerates the "Only a single offscreen document may be created" race by retrying the send.
 * @returns {Promise<void>}
 */
export async function playNotificationSound() {
    try {
        // Check if an offscreen document is already active.
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });

        if (existingContexts.length > 0) {
            sendPlaySoundMessage();
        } else {
            // Create an offscreen document to play the sound.
            await chrome.offscreen.createDocument({
                url: '../offscreen.html', // Path relative to the extension's root
                reasons: ['AUDIO_PLAYBACK'],
                justification: 'Notification sounds for page refresh.',
            });
            // Small delay to let offscreen.js register its onMessage listener
            await new Promise(resolve => setTimeout(resolve, 50));
            sendPlaySoundMessage();
        }
    } catch (e) {
        if (e?.message?.startsWith("Only a single offscreen document may be created")) {
            // This can happen if createDocument is called multiple times quickly.
            // Try sending message again, assuming the document was created by another call.
            sendPlaySoundMessage();
        } else {
            console.error("Error playing sound via offscreen document:", e);
        }
    }
}

// Serialization queue: each logActivity call chains onto the previous one
// to prevent concurrent read-modify-write races on activityLogs storage
let _logQueue = Promise.resolve();

/**
 * Append an activity-log entry, serialized onto the shared write queue so concurrent
 * callers can't race on the read-modify-write of activityLogs storage.
 * @param {number} tabId - Tab the event relates to.
 * @param {string} message - Human-readable log message.
 * @returns {Promise<void>} Resolves when this entry's write completes (errors are logged, not thrown).
 */
export function logActivity(tabId, message) {
    const thisWrite = _logQueue.then(() => _logActivityInternal(tabId, message)).catch((e) => {
        console.error("Error logging activity:", e);
    });
    _logQueue = thisWrite;
    return thisWrite;
}

/**
 * Read activityLogs from chrome.storage.local, prepend the new entry, drop entries older
 * than 7 days, cap the list at MAX_LOG_ENTRIES, and write it back. Not concurrency-safe on
 * its own — always invoked through the _logQueue chain in logActivity.
 * @param {number} tabId - Tab the event relates to.
 * @param {string} message - Human-readable log message.
 * @returns {Promise<void>}
 */
async function _logActivityInternal(tabId, message) {
    const logKey = 'activityLogs';
    let { activityLogs = [] } = await chrome.storage.local.get(logKey);

    // Prepend the new entry with a millisecond timestamp
    activityLogs.unshift({
        timestamp: Date.now(),
        tabId,
        message
    });

    // Purge log entries older than 7 days
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    activityLogs = activityLogs.filter(log => log.timestamp >= weekAgo);

    // Cap the number of entries
    if (activityLogs.length > MAX_LOG_ENTRIES) {
        activityLogs = activityLogs.slice(0, MAX_LOG_ENTRIES);
    }

    await chrome.storage.local.set({ activityLogs });
}

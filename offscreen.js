// offscreen.js — MV3 offscreen document for notification audio. Service workers cannot
// play audio directly, so background dispatches {target:'offscreen', action:'playSound', sound}
// messages here; this script loads the sound into the <audio id="audioPlayer"> element, plays it,
// and replies with {status:'success'|'error'} (keeping the message channel open for the async play()).
const audioPlayer = document.getElementById('audioPlayer');

/**
 * Handles runtime messages targeted at the offscreen document.
 * Ignores any message whose `target` is not 'offscreen'. For a 'playSound' action with a
 * `sound` URL and an available audio element, sets the source and plays it, replying
 * { status: 'success' } on play or { status: 'error', message } on failure / missing input.
 * Returns true to keep the message channel open for the asynchronous play() response.
 * @param {{target:string, action:string, sound?:string}} request - the incoming message
 * @param {chrome.runtime.MessageSender} sender - the message sender
 * @param {(response: {status:string, message?:string}) => void} sendResponse - async reply callback
 * @returns {boolean|undefined} true to keep the channel open for the playSound async reply
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target !== 'offscreen') {
        return;
    }

    if (request.action === 'playSound') {
        if (request.sound && audioPlayer) {
            audioPlayer.src = request.sound;
            audioPlayer.play().then(() => {
                sendResponse({ status: 'success', message: `Playing ${request.sound}` });
            }).catch(error => {
                console.error('Error playing sound:', error);
                sendResponse({ status: 'error', message: error.toString() });
            });
        } else {
            sendResponse({ status: 'error', message: 'Sound file or audio player not specified/found.' });
        }
        return true; // Keep message channel open for async response
    }
});

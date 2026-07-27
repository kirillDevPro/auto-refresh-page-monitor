/**
 * Keyboard shortcuts (chrome.commands) for controlling auto-refresh on the current tab.
 *
 * Declared by the top-level "commands" key in manifest.json — chrome.commands needs no permission
 * entry and adds no install-time warning. Chrome accepts at most FOUR suggested_key bindings per
 * extension; the rest of a command list ships unbound until the user assigns keys at
 * chrome://extensions/shortcuts. A suggested_key that collides with an existing user binding is
 * dropped SILENTLY — the command still exists, just unbound.
 *
 * Actions reuse the shared start/pause/resume/stop helpers from messageHandler.js, exactly as
 * contextMenu.js does: a service worker cannot message its own onMessage listener, so these are
 * in-process calls, not chrome.runtime.sendMessage.
 *
 * Localization gap, deliberate and unfixable: the command descriptions below resolve through
 * manifest __MSG_*__ against default_locale, so chrome://extensions/shortcuts renders them in the
 * BROWSER UI locale and can never honor the in-extension language override. background/i18n.js's
 * tMenu exists precisely because of that gap and cannot help here — Chrome, not this extension,
 * consumes these strings. Do not "fix" this.
 */
import { startRefreshForTab, pauseRefreshForTab, resumeRefreshForTab, stopRefreshForTab } from './messageHandler.js';
import { getTabState } from './state.js';
import { isRefreshableUrl } from './scheduler.js';
import { ensureGlobalSettingsLoaded } from './settings.js';
import { resolveStartInterval } from './startInterval.js';
import { bulkToggleWindow, bulkToggleGroup } from './bulkActions.js';

/** Start the tab's timer, or stop it if one is already running. */
const TOGGLE_REFRESH = 'toggle-refresh';
/** Pause a running timer, or resume a paused one. */
const TOGGLE_PAUSE = 'toggle-pause';
/** Start eligible tabs or stop active tabs across the active tab's window. */
const BULK_TOGGLE_WINDOW = 'bulk-toggle-window';
/** Start eligible tabs or stop active tabs across the active tab's group. */
const BULK_TOGGLE_GROUP = 'bulk-toggle-group';

/**
 * Toggle a tab's refresh timer on or off.
 *
 * A paused tab still counts as active, so this stops it — "toggle refresh" means the timer exists or
 * it does not. Starting reads the interval from resolveStartInterval's ladder, because a shortcut has
 * no UI to read one from and a stopped tab was reset to `interval: null`. Modes are deliberately
 * omitted so startRefreshForTab carries forward the tab's preserved refresh/jitter/recover modes.
 * @param {chrome.tabs.Tab} tab - The resolved target tab; only the start branch requires a refreshable URL.
 * @returns {Promise<void>}
 */
async function toggleRefresh(tab) {
    const settings = await getTabState(tab.id);
    if (settings && settings.isActive) {
        // Stopping needs neither a refreshable URL nor loaded settings — a running timer must always be
        // stoppable by shortcut, including on a tab that has since navigated to chrome://.
        await stopRefreshForTab(tab.id);
        return;
    }
    // Starting requires a refreshable page AND loaded settings (defaultSoundEnabled + the global jitter
    // pair are read while arming). Bail quietly rather than arm a tab from seed defaults.
    if (!isRefreshableUrl(tab.url)) return;
    if (!(await ensureGlobalSettingsLoaded('commands'))) return;
    const interval = await resolveStartInterval(tab.id);
    await startRefreshForTab(tab.id, { interval, isCustom: false });
}

/**
 * Pause a running timer or resume a paused one. No-op on an idle tab — there is nothing to pause,
 * and starting one here would surprise a user who pressed "pause".
 * @param {chrome.tabs.Tab} tab - The resolved target tab; only the resume branch requires a refreshable URL.
 * @returns {Promise<void>}
 */
async function togglePause(tab) {
    const settings = await getTabState(tab.id);
    if (settings && settings.isActive && settings.isPaused) {
        // Resuming re-arms the alarm, which will RELOAD the page — so it needs BOTH a refreshable URL
        // and loaded settings. A tab paused on https then navigated to chrome:// must not resume into
        // auto-reloading a chrome:// page (start is guarded the same way; only stop/pause are not).
        if (!isRefreshableUrl(tab.url)) return;
        if (!(await ensureGlobalSettingsLoaded('commands'))) return;
        await resumeRefreshForTab(tab.id);
    } else if (settings && settings.isActive) {
        // Pausing only clears the alarm, so it needs neither loaded settings nor a refreshable URL.
        await pauseRefreshForTab(tab.id);
    }
}

/**
 * Tab-scoped commands: they act on the active tab; only the start/resume branch requires a refreshable
 * http(s) page and loaded settings, so stopping and pausing work regardless of URL or a degraded read.
 * @type {Record<string, (tab: chrome.tabs.Tab) => Promise<void>>}
 */
const TAB_COMMAND_HANDLERS = {
    [TOGGLE_REFRESH]: toggleRefresh,
    [TOGGLE_PAUSE]: togglePause
};

/**
 * Window/group-scoped commands: they act on a COLLECTION of tabs derived from the active tab
 * (its window or group), so the active tab itself need not be refreshable — a user on a chrome://
 * tab can still start-all in the window.
 * @type {Record<string, (tab: chrome.tabs.Tab) => Promise<void>>}
 */
const SCOPE_COMMAND_HANDLERS = {
    [BULK_TOGGLE_WINDOW]: (tab) => bulkToggleWindow(tab.windowId),
    // Degrades to a no-op for an ungrouped tab: bulkToggleGroup guards a negative groupId itself.
    [BULK_TOGGLE_GROUP]: (tab) => bulkToggleGroup(tab.groupId)
};

/**
 * Every command name this module handles, derived from the dispatch tables.
 *
 * Exported so a test can assert manifest<->handler parity: a command declared in manifest.json with
 * no handler does nothing when pressed, and a handler with no manifest entry can never fire. Both
 * fail SILENTLY, which is exactly why they need pinning.
 * @type {readonly string[]}
 */
export const HANDLED_COMMANDS = Object.freeze([
    ...Object.keys(TAB_COMMAND_HANDLERS),
    ...Object.keys(SCOPE_COMMAND_HANDLERS)
]);

/**
 * Resolve which tab a command applies to.
 *
 * chrome.commands.onCommand passes the active tab in MV3, but fall back to an explicit query rather
 * than dropping the keystroke if it ever arrives undefined.
 * @param {chrome.tabs.Tab} [tab] - The tab Chrome handed the listener.
 * @returns {Promise<chrome.tabs.Tab|null>} A tab with a usable id, or null.
 */
async function resolveTargetTab(tab) {
    if (tab && Number.isInteger(tab.id) && tab.id > 0) return tab;
    try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        return active && Number.isInteger(active.id) && active.id > 0 ? active : null;
    } catch (error) {
        console.warn('commands: could not resolve the active tab', error);
        return null;
    }
}

/**
 * chrome.commands.onCommand handler. Resolves the active tab, then routes to a tab-scoped or
 * window/group-scoped handler. Each handler applies any start/resume prerequisites itself.
 * @param {string} command - The activated command name.
 * @param {chrome.tabs.Tab} [tab] - The tab Chrome reports the command fired on.
 * @returns {Promise<void>}
 */
async function handleCommand(command, tab) {
    const tabHandler = TAB_COMMAND_HANDLERS[command];
    const scopeHandler = SCOPE_COMMAND_HANDLERS[command];
    if (!tabHandler && !scopeHandler) return;

    const target = await resolveTargetTab(tab);
    if (!target) return;

    if (tabHandler) {
        // The prerequisites (a refreshable URL, loaded settings) gate only the START/RESUME side, which
        // each handler applies itself. Do NOT pre-gate here: stopping and pausing must work even on a
        // tab that navigated to chrome:// or during a degraded settings read — otherwise a running
        // timer could not be stopped by shortcut.
        await tabHandler(target);
        return;
    }

    // Scope command: the bulk handlers gate their own START side (ensureGlobalSettingsLoaded) and the STOP
    // side needs no settings; the scope acts on a COLLECTION, so the active tab itself need not be
    // refreshable. No gate here.
    await scopeHandler(target);
}

/**
 * Register the onCommand listener synchronously, as MV3 requires: the service worker restarts to
 * DELIVER the event and only re-runs top-level code, so a listener registered after an await misses
 * its own wake-up event and the keystroke is dropped. No-op when chrome.commands is unavailable.
 * Called once from background.js at startup.
 * @returns {void}
 */
export function initializeCommands() {
    if (!chrome.commands || !chrome.commands.onCommand) return;

    // Return the promise: chrome.commands.onCommand ignores a listener's return value (unlike
    // onMessage), so this is a no-op in production, but it lets a test await the dispatched handler
    // instead of racing its async work.
    chrome.commands.onCommand.addListener((command, tab) =>
        handleCommand(command, tab).catch((error) => console.error('command handler error:', error))
    );
}

/**
 * Right-click context menu for starting/controlling auto-refresh on the current tab.
 *
 * Adds a submenu titled with the (localized) extension name (on the page and the extension action icon,
 * http(s) pages only) with a curated set of interval radio items plus Pause/Resume + Stop actions. The
 * menu is DYNAMIC: it reflects the active tab's state (the matching interval is
 * radio-checked; Pause/Stop are enabled only while a timer runs; Pause flips to Resume when paused),
 * re-synced on tab activation, navigation, window focus, and per-tab state changes.
 *
 * Click actions reuse the shared start/pause/resume/stop helpers from messageHandler.js (the service
 * worker cannot message its own onMessage listener). Labels are localized via background/i18n.js so they
 * honor the in-extension language override; the menu is rebuilt when that language changes. The whole
 * module no-ops if chrome.contextMenus is unavailable.
 */
import { startRefreshForTab, pauseRefreshForTab, resumeRefreshForTab, stopRefreshForTab } from './messageHandler.js';
import { getTabState } from './state.js';
import { isRefreshableUrl } from './scheduler.js';
import { getGlobalAppSettings, isGlobalSettingsLoaded, loadGlobalSettings } from './settings.js';
import { INTERVAL_PRESETS } from '../shared/intervalPresets.js';
import { loadMenuLocale, tMenu } from './i18n.js';

// Menu item ids (namespaced to avoid clashes with any future menus).
const PARENT_ID = 'pau_ctx_parent';
const PRESET_PREFIX = 'pau_ctx_preset_';
const SEPARATOR_ID = 'pau_ctx_sep';
const PAUSE_ID = 'pau_ctx_pause';
const STOP_ID = 'pau_ctx_stop';

// Curated subset of intervals shown in the menu (a context menu should stay short). Pulled from the
// shared INTERVAL_PRESETS so the labels reuse the same already-translated i18n keys as the popup.
const CTX_PRESET_VALUES = [30, 60, 300, 600, 1800, 3600];
const CTX_PRESETS = CTX_PRESET_VALUES
    .map((v) => INTERVAL_PRESETS.find((p) => p.value === v))
    .filter(Boolean);

const DOC_PATTERNS = ['http://*/*', 'https://*/*']; // Refresh only works on http(s); gate the menu to it.
const CONTEXTS = ['page', 'action'];

// Locale currently applied to the built menu; a Symbol sentinel means "not yet built".
let appliedLang = Symbol('unset');
// Coalescing guard for the menu sync: refreshInProgress serializes runs; a refresh requested while one
// is in flight sets refreshPending so the in-flight run repeats once more for the LATEST active tab
// (last-request-wins) instead of being dropped - otherwise a tab switch during an await could leave the
// menu showing the previous tab's checked/enabled state.
let refreshInProgress = false;
let refreshPending = false;

/**
 * Build the preset menu-item id for an interval value.
 * @param {number} value - Preset interval in seconds.
 * @returns {string} Menu item id for that preset.
 */
function presetId(value) { return `${PRESET_PREFIX}${value}`; }

/**
 * Ensure the override locale matching the user's language setting is loaded.
 * @returns {Promise<boolean>} true if the language changed since the last build (menu needs a rebuild).
 */
async function ensureLocale() {
    if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
    const lang = getGlobalAppSettings().language || null;
    if (lang === appliedLang) return false;
    await loadMenuLocale(lang);
    appliedLang = lang;
    return true;
}

/**
 * Update a single menu item, swallowing the "item not found" error that can occur if the menu was
 * concurrently rebuilt.
 * @param {string} id - Menu item id.
 * @param {object} props - Properties to update (see chrome.contextMenus.update).
 * @returns {Promise<void>}
 */
function updateItem(id, props) {
    return new Promise((resolve) => {
        try {
            chrome.contextMenus.update(id, props, () => { void chrome.runtime.lastError; resolve(); });
        } catch (e) {
            resolve();
        }
    });
}

/**
 * (Re)create the whole menu tree from scratch (removeAll + create) so it is idempotent across service
 * worker restarts and language changes. Then syncs item state to the active tab.
 * @returns {Promise<void>}
 */
async function buildContextMenus() {
    if (!chrome.contextMenus) return;
    await ensureLocale();
    await new Promise((resolve) => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; resolve(); }));

    const base = { contexts: CONTEXTS, documentUrlPatterns: DOC_PATTERNS };
    // Parent titled with the localized extension name (extName), not a generic label.
    chrome.contextMenus.create({ id: PARENT_ID, title: tMenu('extName'), ...base });
    for (const p of CTX_PRESETS) {
        chrome.contextMenus.create({ id: presetId(p.value), parentId: PARENT_ID, type: 'radio', checked: false, title: tMenu(p.key), ...base });
    }
    // A separator takes no documentUrlPatterns (meaningless on it); just the contexts.
    chrome.contextMenus.create({ id: SEPARATOR_ID, parentId: PARENT_ID, type: 'separator', contexts: CONTEXTS });
    chrome.contextMenus.create({ id: PAUSE_ID, parentId: PARENT_ID, title: tMenu('pause'), ...base });
    chrome.contextMenus.create({ id: STOP_ID, parentId: PARENT_ID, title: tMenu('stop'), ...base });

    await refreshContextMenuForActiveTab();
}

/**
 * Sync the menu to the active tab, coalescing concurrent requests: if a sync is already running, mark a
 * pending rerun (so a tab switch mid-await is not lost) and return; the running sync then repeats once
 * more for the latest active tab before releasing (last-request-wins).
 * @returns {Promise<void>}
 */
async function refreshContextMenuForActiveTab() {
    if (!chrome.contextMenus) return;
    if (refreshInProgress) { refreshPending = true; return; }
    refreshInProgress = true;
    try {
        do {
            refreshPending = false;
            await syncMenuToActiveTab();
        } while (refreshPending);
    } finally {
        refreshInProgress = false;
    }
}

/**
 * Apply the menu's checked/enabled/title state for the CURRENT active tab: radio-check the running
 * interval, enable Pause/Stop only while a timer runs, and flip Pause<->Resume by paused state. Disables
 * the action items on a non-refreshable tab. Swallows its own errors so the coalescing loop continues.
 * @returns {Promise<void>}
 */
async function syncMenuToActiveTab() {
    try {
        let tab;
        try {
            [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        } catch (e) {
            tab = null;
        }
        const refreshable = !!(tab && isRefreshableUrl(tab.url));
        if (!refreshable) {
            for (const p of CTX_PRESETS) await updateItem(presetId(p.value), { enabled: false, checked: false });
            await updateItem(PAUSE_ID, { enabled: false, title: tMenu('pause') });
            await updateItem(STOP_ID, { enabled: false });
            return;
        }
        if (!isGlobalSettingsLoaded()) await loadGlobalSettings();
        const settings = await getTabState(tab.id);
        const active = !!(settings && settings.isActive);
        const paused = !!(settings && settings.isPaused);
        const interval = active ? settings.interval : null;
        for (const p of CTX_PRESETS) {
            await updateItem(presetId(p.value), { enabled: true, checked: active && interval === p.value });
        }
        await updateItem(PAUSE_ID, { enabled: active, title: paused ? tMenu('resume') : tMenu('pause') });
        await updateItem(STOP_ID, { enabled: active });
    } catch (e) {
        console.warn('refreshContextMenuForActiveTab failed:', e?.message);
    }
}

/**
 * chrome.contextMenus.onClicked handler. Routes a preset to a start and Pause/Resume/Stop to the shared
 * helpers, then re-syncs the menu. Ignores non-refreshable tabs.
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab} [tab]
 * @returns {Promise<void>}
 */
async function handleClick(info, tab) {
    try {
        if (!tab || !Number.isInteger(tab.id) || tab.id <= 0) return;
        if (!isRefreshableUrl(tab.url)) return;
        const id = info.menuItemId;

        if (id === STOP_ID) {
            await stopRefreshForTab(tab.id);
        } else if (id === PAUSE_ID) {
            const settings = await getTabState(tab.id);
            if (settings && settings.isActive && settings.isPaused) await resumeRefreshForTab(tab.id);
            else if (settings && settings.isActive) await pauseRefreshForTab(tab.id);
        } else if (typeof id === 'string' && id.startsWith(PRESET_PREFIX)) {
            const value = parseInt(id.slice(PRESET_PREFIX.length), 10);
            if (Number.isFinite(value) && value > 0) {
                await startRefreshForTab(tab.id, { interval: value, isCustom: false });
            }
        }
        await refreshContextMenuForActiveTab();
    } catch (e) {
        console.error('context menu click error:', e);
    }
}

/**
 * React to a storage change: re-sync the menu on a per-tab state change, and rebuild it (new labels)
 * when the in-extension language changed.
 * @param {object} changes
 * @param {string} area
 * @returns {Promise<void>}
 */
async function handleStorageChange(changes, area) {
    try {
        if (area === 'local') {
            // Only the canonical per-tab state key (tab_<id>) affects the menu; ignore the noisy
            // auxiliary writes (tab_<id>_lastArmed / _remainingTime / _recovery / _loadStartedAt) that
            // fire on every refresh cycle and would otherwise churn a full menu re-sync each time.
            if (Object.keys(changes).some((k) => /^tab_\d+$/.test(k))) {
                await refreshContextMenuForActiveTab();
            }
        } else if (area === 'sync' && changes.globalSettings) {
            // The language lives in sync.globalSettings; rebuild if it changed, else just re-sync state.
            const changed = await ensureLocale();
            if (changed) await buildContextMenus();
            else await refreshContextMenuForActiveTab();
        }
    } catch (e) {
        console.warn('context menu storage-change handler failed:', e?.message);
    }
}

/**
 * Register all context-menu listeners synchronously (required in an MV3 service worker) and build the
 * menu. No-op when chrome.contextMenus is unavailable. Called once from background.js at startup.
 * @returns {void}
 */
export function initializeContextMenu() {
    if (!chrome.contextMenus) return;

    chrome.contextMenus.onClicked.addListener(handleClick);

    // Keep the menu in sync with whichever tab the user will right-click.
    if (chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(() => { refreshContextMenuForActiveTab().catch(() => {}); });
    }
    if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.status || changeInfo.url) refreshContextMenuForActiveTab().catch(() => {});
        });
    }
    if (chrome.windows && chrome.windows.onFocusChanged) {
        chrome.windows.onFocusChanged.addListener(() => { refreshContextMenuForActiveTab().catch(() => {}); });
    }
    if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(handleStorageChange);
    }

    buildContextMenus().catch((e) => console.error('buildContextMenus failed:', e));
}

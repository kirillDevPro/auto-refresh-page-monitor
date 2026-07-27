/**
 * Integration test for focus-aware smart pause (pauseWhileActiveEnabled).
 *
 * Bug being pinned: the smart-pause gate used chrome.idle (a SYSTEM-WIDE signal), so a background
 * tab never refreshed while the user worked on another tab, and with the feature ON effectively no
 * tab refreshed at all. Fix: skip the refresh ONLY for the tab the user is actually viewing (the
 * active tab of the focused window); background tabs always refresh.
 *
 * Strategy: mock global.chrome, import the real alarmHandler module graph, capture the registered
 * chrome.alarms.onAlarm listener, and dispatch a synthetic per-tab refresh alarm under four
 * focus/idle combinations. A 30s interval is a one-shot alarm, so each synthetic fire DELETES the
 * alarm first (modelling Chrome consuming a one-shot before delivery) and we assert both whether a
 * reload happened AND whether the alarm was re-armed.
 *
 * Run: node tests/test_smart_pause_focus.mjs
 */

// ---- minimal chrome mock -------------------------------------------------------------------------
function mkEvent() {
    return { addListener() {}, removeListener() {}, hasListener() { return false; } };
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function storageArea(store) {
    return {
        get: async (keys) => {
            if (keys == null) return clone(store);
            if (typeof keys === 'string') return (keys in store) ? { [keys]: clone(store[keys]) } : {};
            if (Array.isArray(keys)) {
                const o = {};
                for (const k of keys) if (k in store) o[k] = clone(store[k]);
                return o;
            }
            const o = {};
            for (const k of Object.keys(keys)) o[k] = (k in store) ? clone(store[k]) : keys[k];
            return o;
        },
        set: async (obj) => { Object.assign(store, clone(obj)); },
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },
        clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
    };
}

// Mutable mock world the scenarios drive.
const tabsById = {};      // id -> { id, url, active, windowId }
const windowsById = {};   // id -> { id, focused }
let idleState = 'active'; // 'active' | 'idle' | 'locked'

const syncStore = { globalSettings: { pauseWhileActiveEnabled: true } };
const localStore = { globalLists: { whitelist: [], blacklist: [], scheduledRefreshes: [] } };

const alarmStore = new Map();   // name -> { name, scheduledTime, periodInMinutes }
const createdAlarms = [];       // names passed to chrome.alarms.create (in order)
const reloadCalls = [];         // tabIds passed to chrome.tabs.reload

const chrome = {
    idle: {
        queryState: async () => idleState,
        onStateChanged: mkEvent()
    },
    windows: {
        WINDOW_ID_NONE: -1,
        get: async (id) => {
            if (id in windowsById) return { ...windowsById[id] };
            throw new Error('No window with id: ' + id);
        },
        onFocusChanged: mkEvent()
    },
    tabs: {
        get: async (id) => {
            if (id in tabsById) return { ...tabsById[id] };
            throw new Error('No tab with id: ' + id);
        },
        reload: async (tabId) => { reloadCalls.push(tabId); },
        query: async () => Object.values(tabsById).map(t => ({ ...t })),
        onRemoved: mkEvent(),
        onUpdated: mkEvent(),
        onActivated: mkEvent()
    },
    alarms: {
        get: async (name) => (alarmStore.has(name) ? { ...alarmStore.get(name) } : undefined),
        getAll: async () => [...alarmStore.values()].map(a => ({ ...a })),
        create: async (name, info = {}) => {
            const when = info.when ?? (Date.now() + (info.delayInMinutes ?? 0) * 60000);
            alarmStore.set(name, { name, scheduledTime: when, periodInMinutes: info.periodInMinutes });
            createdAlarms.push(name);
        },
        clear: async (name) => { const had = alarmStore.has(name); alarmStore.delete(name); return had; },
        onAlarm: { _fn: null, addListener(fn) { this._fn = fn; }, removeListener() {}, hasListener() { return false; } }
    },
    action: {
        setIcon: async () => {}, setTitle: async () => {},
        setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}
    },
    storage: {
        sync: storageArea(syncStore),
        local: storageArea(localStore),
        onChanged: mkEvent()
    },
    runtime: {
        lastError: undefined,
        id: 'test',
        getManifest: () => ({ version: '2.3.1' }),
        onMessage: mkEvent(), onStartup: mkEvent(), onInstalled: mkEvent(), onConnect: mkEvent()
    },
    permissions: {
        onAdded: mkEvent(), onRemoved: mkEvent(),
        contains: async () => false, getAll: async () => ({ permissions: [], origins: [] })
    }
};
global.chrome = chrome;

// ---- load the real module graph ------------------------------------------------------------------
const { initializeStateManagement } = await import('../background/state.js');
const { initializeAlarmHandler } = await import('../background/alarmHandler.js');
const { tabAlarmName } = await import('../background/constants.js');

// No-op badge callback: prevents state.js from logging an "uninitialized" warning and from starting
// the real 1s setInterval badge timer (which would keep the process alive).
initializeStateManagement({ updateIconBadge: async () => {} });

initializeAlarmHandler({
    playNotificationSound: async () => {},
    logActivity: () => {},
    cleanupRefresher: async () => {},
    statisticsCollector: { recordRefresh: () => {} },
    urlMatchesAnyEnabledSchedule: () => true,
    deactivateScheduledTab: async () => {},
    handleRecoveryAlarm: async () => {},
    checkStuckLoads: async () => {},
    checkReconnect: async () => {}
});

const onAlarm = chrome.alarms.onAlarm._fn;
if (typeof onAlarm !== 'function') {
    console.error('[FAIL] alarmHandler did not register an onAlarm listener');
    process.exit(1);
}

// ---- scenario runner -----------------------------------------------------------------------------
/**
 * Seed one tab + window, set the global idle state, dispatch a synthetic refresh alarm, and report
 * whether a reload happened and whether the alarm was re-armed.
 */
async function runScenario({ tabId, windowId, tabActive, windowFocused, idle }) {
    tabsById[tabId] = { id: tabId, url: 'https://www.youtube.com/feed/subscriptions', active: tabActive, windowId };
    windowsById[windowId] = { id: windowId, focused: windowFocused };
    idleState = idle;

    const alarmName = tabAlarmName(tabId);
    localStore[`tab_${tabId}`] = {
        isActive: true, isPaused: false, interval: 30, isScheduled: false,
        soundEnabled: false, refreshMode: 'default', jitterMode: 'default', recoverMode: 'default',
        refreshCount: 0, isAutoRefresh: false, alarmName
    };

    // Model Chrome consuming a one-shot (<60s) alarm before delivering it: delete it, then dispatch.
    alarmStore.delete(alarmName);
    const reloadsBefore = reloadCalls.length;
    const createsBefore = createdAlarms.length;

    await onAlarm({ name: alarmName, scheduledTime: Date.now() - 1000, periodInMinutes: undefined });

    const reloaded = reloadCalls.slice(reloadsBefore).includes(tabId);
    const reArmed = createdAlarms.slice(createsBefore).includes(alarmName);
    return { reloaded, reArmed };
}

// ---- assertions ----------------------------------------------------------------------------------
let failures = 0;
function check(label, cond) {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}`);
    if (!cond) failures++;
}

// (a) Background tab (not the active tab) while the user is active elsewhere -> MUST refresh.
//     This is the exact reported bug: youtube/feed/subscriptions in the background never refreshed.
const a = await runScenario({ tabId: 1001, windowId: 10, tabActive: false, windowFocused: true, idle: 'active' });
check('background tab + user active -> reloads', a.reloaded === true);

// (b) The focused, active tab the user is viewing while active -> MUST be paused (skipped), but the
//     timer MUST still be re-armed so the feature does not silently stop the tab forever.
const b = await runScenario({ tabId: 1002, windowId: 10, tabActive: true, windowFocused: true, idle: 'active' });
check('focused active tab + user active -> skips reload', b.reloaded === false);
check('focused active tab + user active -> alarm still re-armed (no silent stop)', b.reArmed === true);

// (c) Active tab but its window is NOT focused (user switched to another application) -> MUST refresh.
const c = await runScenario({ tabId: 1003, windowId: 11, tabActive: true, windowFocused: false, idle: 'active' });
check('active tab in unfocused window (other app) + user active -> reloads', c.reloaded === true);

// (d) Focused active tab but the user is idle (away) -> MUST refresh (the whole point of idle detection).
const d = await runScenario({ tabId: 1004, windowId: 10, tabActive: true, windowFocused: true, idle: 'idle' });
check('focused active tab + user idle -> reloads', d.reloaded === true);

console.log(failures === 0 ? '\n[OK] all smart-pause focus scenarios passed' : `\n[FAIL] ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);

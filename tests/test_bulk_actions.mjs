/**
 * Regression for bulk window/group actions (background/bulkActions.js), driven through the REAL
 * messageHandler dispatch so the injected bulk wiring is exercised end to end.
 *
 * Pins:
 *  - START filters to http(s) tabs (an https-served PDF IS refreshable); other windows/groups untouched.
 *  - the GLOBAL active-tab ceiling caps a start and reports `capped`; already-running tabs do NOT consume
 *    remaining capacity (bulk-capacity fix).
 *  - STOP is uncapped AND ignores URL — a tab that navigated to chrome:// while running is still stopped
 *    (stop-scope fix); only START filters by URL.
 *  - a group request for the ungrouped sentinel (groupId -1) issues NO tabs.query at all.
 *
 * Run: node tests/test_bulk_actions.mjs
 */
let tabs = {}, store = {}, alarms = {};
let failGetTabIds = new Set();
let onMessage = null;

global.chrome = {
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
        query: async (q) => {
            let list = Object.values(tabs);
            if (q.active) list = list.filter(t => t.active);
            if (q.currentWindow || q.lastFocusedWindow) list = list.filter(t => t.windowId === 1);
            if (typeof q.windowId === 'number') list = list.filter(t => t.windowId === q.windowId);
            if (typeof q.groupId === 'number') list = list.filter(t => t.groupId === q.groupId);
            return list.map(t => ({ ...t }));
        },
        get: async (id) => {
            if (failGetTabIds.has(id)) throw new Error('No tab: ' + id);
            if (!tabs[id]) throw new Error('No tab: ' + id);
            return { ...tabs[id] };
        },
        reload: async () => {}
    },
    storage: {
        local: {
            get: async (k) => {
                if (k == null) return { ...store };
                if (Array.isArray(k)) { const o = {}; for (const key of k) if (key in store) o[key] = store[key]; return o; }
                if (typeof k === 'object') { const o = {}; for (const key of Object.keys(k)) o[key] = key in store ? store[key] : k[key]; return o; }
                return k in store ? { [k]: store[k] } : {};
            },
            set: async (o) => { Object.assign(store, o); },
            remove: async (keys) => { for (const key of [].concat(keys)) delete store[key]; },
            getBytesInUse: async () => 0
        },
        sync: { get: async () => ({ globalSettings: { defaultSoundEnabled: false, intervalJitterEnabled: false, intervalJitterPercent: 20 } }), set: async () => {} }
    },
    alarms: {
        create: async (n, i) => { alarms[n] = { name: n, scheduledTime: 0, ...i }; },
        get: async (n) => alarms[n] || null,
        clear: async (n) => { const h = !!alarms[n]; delete alarms[n]; return h; },
        getAll: async () => Object.values(alarms)
    },
    action: { setIcon: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    windows: { get: async (id) => ({ id, focused: true }) },
    runtime: { lastError: null, onMessage: { addListener: (fn) => { onMessage = fn; } } }
};

const state = await import('../background/state.js');
const settings = await import('../background/settings.js');
const msg = await import('../background/messageHandler.js');
const bulk = await import('../background/bulkActions.js');
settings.updateGlobalAppSettings({ defaultSoundEnabled: false, intervalJitterEnabled: false, intervalJitterPercent: 20 });
state.initializeStateManagement({ updateIconBadge: async () => {} });
msg.setupMessageHandler({ reapplyScheduledRefreshesToAllTabs: async () => {}, statisticsCollector: null, logActivity: () => {}, bulkActions: { actions: bulk.BULK_ACTIONS, handle: bulk.handleBulkMessage } });

const reset = () => { tabs = {}; store = {}; alarms = {}; failGetTabIds = new Set(); for (let i = 1; i <= 200; i++) state.clearTabState(i); };
const send = (m) => new Promise((r) => onMessage(m, {}, r));

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} -> ${JSON.stringify(a)}`) : fail(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));

// START filters non-http, starts the rest, leaves other windows alone
{
    reset();
    tabs = {
        1: { id: 1, url: 'https://a.com', windowId: 1 },
        2: { id: 2, url: 'http://b.com', windowId: 1 },
        3: { id: 3, url: 'chrome://settings', windowId: 1 },
        4: { id: 4, url: 'https://c.com', windowId: 2 }
    };
    const r = await send({ action: 'bulkStartWindow', windowId: 1 });
    eq(r.result.started, 2, 'window start: 2 http(s) tabs started');
    eq(r.result.skipped, 1, 'window start: the chrome:// tab is skipped');
    eq((await state.getTabState(4)).isActive, undefined, 'a tab in another window is untouched');
}

// https-served PDF is refreshable
{
    reset();
    tabs = { 1: { id: 1, url: 'https://x.com/file.pdf', windowId: 1 } };
    const r = await send({ action: 'bulkStartWindow', windowId: 1 });
    eq(r.result.started, 1, 'an https-served PDF is refreshable and IS started');
}

// GLOBAL ceiling caps the start
{
    reset();
    for (let i = 100; i < 129; i++) alarms[`refresh_tab_${i}`] = { name: `refresh_tab_${i}` }; // 29 existing -> capacity 1
    tabs = { 1: { id: 1, url: 'https://a.com', windowId: 1 }, 2: { id: 2, url: 'https://b.com', windowId: 1 }, 3: { id: 3, url: 'https://c.com', windowId: 1 } };
    const r = await send({ action: 'bulkStartWindow', windowId: 1 });
    eq(r.result.started, 1, 'ceiling: only the 1 remaining slot is filled');
    eq(r.result.capped, 2, 'ceiling: the other 2 are reported as capped');
}

// already-running tabs do NOT consume remaining capacity
{
    reset();
    tabs = { 1: { id: 1, url: 'https://a.com', windowId: 1 }, 2: { id: 2, url: 'https://b.com', windowId: 1 } };
    await send({ action: 'bulkStartWindow', windowId: 1 }); // both running now
    tabs[3] = { id: 3, url: 'https://c.com', windowId: 1 }; // add a fresh tab
    const r = await send({ action: 'bulkStartWindow', windowId: 1 });
    eq(r.result.started, 1, 're-running a window only starts the newly-added tab');
    eq(r.result.capped, 0, 'already-running tabs are not counted against the ceiling');
}

// STOP is uncapped AND ignores URL — a tab now on chrome:// is still stopped
{
    reset();
    tabs = { 1: { id: 1, url: 'https://a.com', windowId: 1 }, 2: { id: 2, url: 'https://b.com', windowId: 1 } };
    await send({ action: 'bulkStartWindow', windowId: 1 });
    tabs[1].url = 'chrome://settings'; // tab navigated to a non-refreshable URL while its timer runs
    const r = await send({ action: 'bulkStopWindow', windowId: 1 });
    eq(r.result.stopped, 2, 'stop stops BOTH tabs, including the one now on chrome:// (stop ignores URL)');
    eq((await state.getTabState(1)).isActive, false, 'the chrome:// tab timer is actually cleared');
}

// group -1 issues NO query (never fans out to all ungrouped tabs)
{
    reset();
    let queriedMinus1 = false;
    const realQuery = chrome.tabs.query;
    chrome.tabs.query = async (q) => { if (q.groupId === -1) queriedMinus1 = true; return realQuery(q); };
    const r = await send({ action: 'bulkStartGroup', groupId: -1 });
    eq(r.result.ineligible, true, 'groupId -1 returns ineligible');
    eq(queriedMinus1, false, 'groupId -1 issues NO tabs.query');
    chrome.tabs.query = realQuery;
}

// group start touches only that group
{
    reset();
    tabs = {
        1: { id: 1, url: 'https://a.com', windowId: 1, groupId: 7 },
        2: { id: 2, url: 'https://b.com', windowId: 1, groupId: 7 },
        3: { id: 3, url: 'https://c.com', windowId: 1, groupId: 9 }
    };
    const r = await send({ action: 'bulkStartGroup', groupId: 7 });
    eq(r.result.started, 2, 'group start: only the 2 tabs in group 7 started');
    eq((await state.getTabState(3)).isActive, undefined, 'a tab in another group is untouched');
}

// Two overlapping bulk starts on DISJOINT windows cannot jointly bust the global ceiling
{
    reset();
    for (let i = 100; i < 128; i++) alarms[`refresh_tab_${i}`] = { name: `refresh_tab_${i}` }; // 28 existing -> capacity 2
    tabs = {
        1: { id: 1, url: 'https://a.com', windowId: 1 }, 2: { id: 2, url: 'https://b.com', windowId: 1 },
        3: { id: 3, url: 'https://c.com', windowId: 2 }, 4: { id: 4, url: 'https://d.com', windowId: 2 }
    };
    // Fire both concurrently: without serialization each reads the same free capacity (2) and arms 2 -> 32 alarms.
    const [r1, r2] = await Promise.all([
        send({ action: 'bulkStartWindow', windowId: 1 }),
        send({ action: 'bulkStartWindow', windowId: 2 })
    ]);
    eq(r1.result.started + r2.result.started, 2, 'concurrent disjoint starts fill only the 2 remaining slots TOTAL (serialized)');
    const live = Object.keys(alarms).filter((n) => n.startsWith('refresh_tab_')).length;
    eq(live, 30, 'the global ceiling (30) holds under concurrency, not 32');
}

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all bulk-action checks passed`);
process.exit(failures ? 1 : 0);

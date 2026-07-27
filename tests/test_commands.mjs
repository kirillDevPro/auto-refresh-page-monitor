/**
 * Regression for chrome.commands (keyboard shortcuts): manifest<->handler parity + dispatch by effect.
 *
 * node --check cannot catch a command-name typo between manifest.json and commands.js, and that failure
 * is SILENT (the shortcut does nothing). This asserts HANDLED_COMMANDS == manifest.commands exactly,
 * then drives the real onCommand listener through a chrome mock and observes tab state / bulk effects.
 *
 * The module graph is loaded ONCE (no ?v suffix) so commands.js and the modules it imports share one
 * instance. Scenarios use non-overlapping tab ids and reset the store, so no per-scenario reset needed.
 * Run: node tests/test_commands.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let tabs = {}, store = {}, alarms = {};
let capturedCommandListener = null;

global.chrome = {
    commands: { onCommand: { addListener: (fn) => { capturedCommandListener = fn; } } },
    tabs: {
        query: async (q) => {
            let list = Object.values(tabs);
            if (q.active) list = list.filter(t => t.active);
            if (q.currentWindow || q.lastFocusedWindow) list = list.filter(t => t.windowId === 1);
            if (typeof q.windowId === 'number') list = list.filter(t => t.windowId === q.windowId);
            if (typeof q.groupId === 'number') list = list.filter(t => t.groupId === q.groupId);
            return list.map(t => ({ ...t }));
        },
        get: async (id) => { if (!tabs[id]) throw new Error('No tab: ' + id); return { ...tabs[id] }; },
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
    runtime: { lastError: null, onMessage: { addListener: () => {} } }
};

const state = await import('../background/state.js');
const settings = await import('../background/settings.js');
const msg = await import('../background/messageHandler.js');
const bulk = await import('../background/bulkActions.js');
const commands = await import('../background/commands.js');
settings.updateGlobalAppSettings({ defaultSoundEnabled: false, intervalJitterEnabled: false, intervalJitterPercent: 20 });
state.initializeStateManagement({ updateIconBadge: async () => {} });
msg.setupMessageHandler({ reapplyScheduledRefreshesToAllTabs: async () => {}, statisticsCollector: null, logActivity: () => {}, bulkActions: { actions: bulk.BULK_ACTIONS, handle: bulk.handleBulkMessage } });
commands.initializeCommands();

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} -> ${JSON.stringify(a)}`) : fail(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));
const dispatch = (cmd, tab) => capturedCommandListener(cmd, tab);

// parity — the silent-typo guard
{
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    const manifestCmds = Object.keys(manifest.commands || {}).sort();
    eq([...commands.HANDLED_COMMANDS].sort().join(','), manifestCmds.join(','), 'HANDLED_COMMANDS == manifest.commands exactly (all 4)');
}

// toggle-refresh: start at the ladder default, then stop
{
    tabs = { 10: { id: 10, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    await dispatch('toggle-refresh', tabs[10]);
    const s = await state.getTabState(10);
    eq(s.isActive, true, 'toggle-refresh starts a fresh tab');
    eq(s.interval, 60, 'a shortcut start with no history uses the default (60)');
    await dispatch('toggle-refresh', tabs[10]);
    eq((await state.getTabState(10)).isActive, false, 'toggle-refresh again stops it');
}

// toggle-refresh honors rung 2 (lastUsedInterval)
{
    tabs = { 12: { id: 12, url: 'https://example.com', active: true, windowId: 1 } }; store = { lastUsedInterval: 300 };
    await dispatch('toggle-refresh', tabs[12]);
    eq((await state.getTabState(12)).interval, 300, 'a shortcut start reuses the last chosen interval');
}

// toggle-pause: idle no-op; active -> pause -> resume
{
    tabs = { 13: { id: 13, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    await dispatch('toggle-pause', tabs[13]);
    eq((await state.getTabState(13)).isActive, undefined, 'toggle-pause on an idle tab is a no-op');
    await dispatch('toggle-refresh', tabs[13]);
    await dispatch('toggle-pause', tabs[13]);
    eq((await state.getTabState(13)).isPaused, true, 'toggle-pause pauses a running tab');
    await dispatch('toggle-pause', tabs[13]);
    eq((await state.getTabState(13)).isPaused, false, 'toggle-pause again resumes it');
}

// non-refreshable active tab: TAB command ignored, no throw
{
    tabs = { 14: { id: 14, url: 'chrome://settings', active: true, windowId: 1 } }; store = {};
    try { await dispatch('toggle-refresh', tabs[14]); eq((await state.getTabState(14)).isActive, undefined, 'a shortcut on a chrome:// tab does nothing'); }
    catch (e) { fail(`shortcut on chrome:// threw: ${e.message}`); }
}

// undefined tab -> active-tab fallback
{
    tabs = { 15: { id: 15, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    await dispatch('toggle-refresh', undefined);
    eq((await state.getTabState(15)).isActive, true, 'an undefined tab falls back to querying the active tab');
}

// SCOPE command: bulk-toggle-window works even from a chrome:// ACTIVE tab (unlike TAB commands)
{
    tabs = {
        1: { id: 1, url: 'chrome://settings', windowId: 1, active: true, groupId: -1 },
        2: { id: 2, url: 'https://b.com', windowId: 1, groupId: -1 },
        3: { id: 3, url: 'https://c.com', windowId: 1, groupId: -1 }
    }; store = {};
    for (let i = 1; i <= 3; i++) state.clearTabState(i);
    await dispatch('bulk-toggle-window', tabs[1]);
    eq((await state.getTabState(2)).isActive, true, 'bulk-toggle-window from a chrome:// active tab still starts the window http tabs');
    eq((await state.getTabState(3)).isActive, true, 'and the other http tab');
}

// SCOPE command: bulk-toggle-group on an ungrouped tab is a no-op
{
    tabs = { 20: { id: 20, url: 'https://a.com', windowId: 1, active: true, groupId: -1 } }; store = {};
    try { await dispatch('bulk-toggle-group', tabs[20]); eq((await state.getTabState(20)).isActive, undefined, 'bulk-toggle-group on an ungrouped tab does nothing'); }
    catch (e) { fail(`bulk-toggle-group on ungrouped threw: ${e.message}`); }
}

// unknown command is ignored
{
    tabs = { 21: { id: 21, url: 'https://a.com', windowId: 1, active: true } }; store = {};
    try { await dispatch('does-not-exist', tabs[21]); ok('an unknown command name is ignored without throwing'); }
    catch (e) { fail(`unknown command threw: ${e.message}`); }
}

// A shortcut restart CARRIES the tab's saved range percent (not 'on' + 0 -> global jitter)
{
    tabs = { 30: { id: 30, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    state.clearTabState(30);
    // Set a range the way the popup range button does: jitterMode 'on' + a per-item percent.
    await msg.startRefreshForTab(30, { interval: 60, isCustom: true, jitterMode: 'on', jitterPercent: 50 });
    eq((await state.getTabState(30)).jitterPercent, 50, 'range set on the tab');
    await dispatch('toggle-refresh', tabs[30]); // stop (stopRefreshForTab preserves the percent)
    eq((await state.getTabState(30)).isActive, false, 'toggle stopped the range tab');
    await dispatch('toggle-refresh', tabs[30]); // restart via carry-forward (no mode/percent passed)
    const s = await state.getTabState(30);
    eq(s.jitterMode, 'on', 'restart keeps jitterMode on');
    eq(s.jitterPercent, 50, 'restart CARRIES the saved range percent, not 0 -> global');
}

// A running tab that navigated to chrome:// is still STOPPABLE by shortcut (URL gates start only)
{
    tabs = { 31: { id: 31, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    state.clearTabState(31);
    await dispatch('toggle-refresh', tabs[31]);
    eq((await state.getTabState(31)).isActive, true, 'started on http');
    tabs[31].url = 'chrome://settings'; // tab navigated to a non-refreshable page while running
    await dispatch('toggle-refresh', tabs[31]);
    eq((await state.getTabState(31)).isActive, false, 'toggle-refresh STOPS a running tab now on chrome://');
}

// Pause also works on an active tab regardless of URL
{
    tabs = { 32: { id: 32, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    state.clearTabState(32);
    await dispatch('toggle-refresh', tabs[32]);
    tabs[32].url = 'chrome://settings';
    await dispatch('toggle-pause', tabs[32]);
    eq((await state.getTabState(32)).isPaused, true, 'toggle-pause pauses a running tab now on chrome://');
}

// Resume re-arms a timer, so it is URL-guarded like start — a tab paused on http then
// moved to chrome:// must NOT resume into auto-reloading a chrome:// page.
{
    tabs = { 33: { id: 33, url: 'https://example.com', active: true, windowId: 1 } }; store = {};
    state.clearTabState(33);
    await dispatch('toggle-refresh', tabs[33]); // start
    await dispatch('toggle-pause', tabs[33]);   // pause
    eq((await state.getTabState(33)).isPaused, true, 'paused on http');
    tabs[33].url = 'chrome://settings';         // navigate away while paused
    await dispatch('toggle-pause', tabs[33]);   // resume attempt — blocked by the URL guard
    eq((await state.getTabState(33)).isPaused, true, 'resume is BLOCKED on chrome:// (stays paused), re-arm gated like start');
}

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all command dispatch checks passed`);
process.exit(failures ? 1 : 0);

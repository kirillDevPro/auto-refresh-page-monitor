/**
 * Regression for the inherited-jitter re-arm fix: an ACTIVE scheduled tab whose rule inherits jitter
 * (jitterMode:'default') must re-arm to the correct alarm TYPE when the GLOBAL jitter toggle flips,
 * even though the stored rule fields never change.
 *
 * A scheduleAlarm is periodic only for intervals >= 60s WITHOUT jitter; otherwise one-shot. Before the
 * fix, applyScheduledRefreshIfNeeded's early-return compared only the raw rule mode/percent (both
 * 'default'/0, unchanged by a global toggle), so it kept a PERIODIC alarm after the user enabled global
 * jitter — the scheduled tab then refreshed at a fixed interval forever instead of a jittered one-shot.
 * The fix compares the live alarm's actual type against the desired EFFECTIVE type.
 *
 * Strategy: mock chrome, import the real scheduler + state + settings graph, seed an active scheduled
 * tab with a PERIODIC alarm, flip the global jitter flag, and assert the alarm type after each
 * applyScheduledRefreshIfNeeded call. Also pins that an unrelated re-apply does NOT needlessly re-arm.
 *
 * Run: node tests/test_scheduler_jitter_rearm.mjs
 */
function mkEvent() { return { addListener() {}, removeListener() {}, hasListener() { return false; } }; }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function storageArea(store) {
    return {
        get: async (keys) => {
            if (keys == null) return clone(store);
            if (typeof keys === 'string') return (keys in store) ? { [keys]: clone(store[keys]) } : {};
            if (Array.isArray(keys)) { const o = {}; for (const k of keys) if (k in store) o[k] = clone(store[k]); return o; }
            const o = {}; for (const k of Object.keys(keys)) o[k] = (k in store) ? clone(store[k]) : keys[k]; return o;
        },
        set: async (obj) => { Object.assign(store, clone(obj)); },
        remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; },
        clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
    };
}

const alarmStore = new Map();      // name -> { name, scheduledTime, periodInMinutes }
const createdAlarms = [];          // names passed to create, in order
const tabsById = { 1: { id: 1, url: 'https://sched.com', active: true, windowId: 1 } };

const chrome = {
    tabs: {
        get: async (id) => { if (id in tabsById) return { ...tabsById[id] }; throw new Error('No tab: ' + id); },
        reload: async () => {}, query: async () => Object.values(tabsById).map(t => ({ ...t })),
        onRemoved: mkEvent(), onUpdated: mkEvent(), onActivated: mkEvent()
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
        onAlarm: mkEvent()
    },
    action: { setIcon: async () => {}, setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    storage: { sync: storageArea({}), local: storageArea({}), onChanged: mkEvent() },
    runtime: { lastError: undefined, id: 'test', onMessage: mkEvent(), onStartup: mkEvent(), onInstalled: mkEvent() },
    windows: { get: async (id) => ({ id, focused: true }) }
};
global.chrome = chrome;

const state = await import('../background/state.js');
const settings = await import('../background/settings.js');
const scheduler = await import('../background/scheduler.js');
const { tabAlarmName } = await import('../background/constants.js');

state.initializeStateManagement({ updateIconBadge: async () => {} });
scheduler.initializeScheduler({ logActivity: () => {}, statisticsCollector: null });

const RULE = { url: 'https://sched.com', enabled: true, interval: 300, refreshMode: 'default', jitterMode: 'default', recoverMode: 'default' };
// Set the full settings object each time so the rule survives a jitter-flag toggle regardless of merge semantics.
const setGlobal = (jitterEnabled) => settings.updateGlobalAppSettings({
    defaultSoundEnabled: false, intervalJitterEnabled: jitterEnabled, intervalJitterPercent: 20,
    scheduledRefreshes: [RULE], whitelist: [], blacklist: []
});

const ALARM = tabAlarmName(1);
async function seedActiveScheduledTab() {
    await state.updateTabStorageAndState(1, {
        isActive: true, isPaused: false, isScheduled: true, isCustom: false, interval: 300,
        soundEnabled: false, refreshMode: 'default', jitterMode: 'default', jitterPercent: 0,
        recoverMode: 'default', refreshCount: 0, alarmName: ALARM
    });
    // Seed a PERIODIC alarm (what a non-jittered >=60s scheduled tab arms).
    alarmStore.set(ALARM, { name: ALARM, scheduledTime: Date.now() + 300000, periodInMinutes: 5 });
}
const isPeriodic = () => { const a = alarmStore.get(ALARM); return !!(a && a.periodInMinutes !== undefined); };

let failures = 0;
const check = (cond, m) => { console.log(`${cond ? '[PASS]' : '[FAIL]'} ${m}`); if (!cond) failures++; };

// (a) Global jitter OFF, effective type already matches (periodic) -> no needless re-arm.
setGlobal(false);
await seedActiveScheduledTab();
let createsBefore = createdAlarms.length;
await scheduler.applyScheduledRefreshIfNeeded(1, 'https://sched.com');
check(isPeriodic(), 'jitter off: a matching periodic alarm stays periodic');
check(createdAlarms.length === createsBefore, 'jitter off: no needless re-arm (early-return holds)');

// (b) THE FIX — enable global jitter: an inherited 'default' rule must re-arm to a one-shot.
setGlobal(true);
createsBefore = createdAlarms.length;
await scheduler.applyScheduledRefreshIfNeeded(1, 'https://sched.com');
check(!isPeriodic(), 'jitter ON: inherited rule re-arms to a ONE-SHOT (was periodic)');
check(createdAlarms.length > createsBefore, 'jitter ON: the alarm was actually re-created');

// (c) Reverse — disable global jitter again: must re-arm back to periodic.
setGlobal(false);
await scheduler.applyScheduledRefreshIfNeeded(1, 'https://sched.com');
check(isPeriodic(), 'jitter OFF again: inherited rule re-arms back to periodic');

// (d) No false positive: a healthy periodic tab re-applied with jitter still off does not re-arm.
createsBefore = createdAlarms.length;
await scheduler.applyScheduledRefreshIfNeeded(1, 'https://sched.com');
check(createdAlarms.length === createsBefore, 'steady state: an unchanged effective type does not re-arm');

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : '\n[OK] scheduler jitter re-arm regression passed');
process.exit(failures ? 1 : 0);

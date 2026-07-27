// Integration test for the "countdown stuck at 00:00" fix.
//
// Verifies forceCheckAlarmForTab (the badge zero-tick fast path) actually rescues a late refresh
// alarm now that:
//   1. the act threshold is overdueMs > 0 (was > 1000ms, which the first zero tick missed), and
//   2. the overdue alarm is cleared UNDER the per-tab lock inside handleAlarm (clearBeforeReschedule),
//      so a busy lock can never clear-then-fail-to-re-arm and lose the timer.
//
// Run: node tests/refresh-zero-tick-rescue.test.mjs   (from the project root)
// ASCII-only output by project convention.

// ---------------------------------------------------------------------------
// Minimal chrome.* mock (set BEFORE importing the modules under test).
// ---------------------------------------------------------------------------
const alarms = new Map();        // name -> { name, scheduledTime, periodInMinutes? }
const local = {};                // chrome.storage.local backing store
const sync = {};                 // chrome.storage.sync backing store
const calls = { reload: [], created: [], cleared: [] };

function storeGet(store, keys) {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return (keys in store) ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
    }
    const out = {};
    for (const k of Object.keys(keys)) out[k] = (k in store) ? store[k] : keys[k];
    return out;
}

global.chrome = {
    alarms: {
        async get(name) { return alarms.get(name) || null; },
        async getAll() { return [...alarms.values()]; },
        async create(name, opts) {
            const delayMin = opts.delayInMinutes || 0;
            const a = { name, scheduledTime: Date.now() + Math.round(delayMin * 60000) };
            if (opts.periodInMinutes) a.periodInMinutes = opts.periodInMinutes;
            alarms.set(name, a);
            calls.created.push({ name, opts });
        },
        async clear(name) { const had = alarms.delete(name); calls.cleared.push(name); return had; },
        onAlarm: { addListener() {} },
    },
    tabs: {
        async get(id) { return { id, url: 'https://example.com/' }; },
        async reload(id, opts) { calls.reload.push({ id, opts }); },
        async query() { return []; },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
    },
    storage: {
        local: {
            async get(keys) { return storeGet(local, keys); },
            async set(obj) { Object.assign(local, obj); },
            async remove(keys) { for (const k of [].concat(keys)) delete local[k]; },
            async getBytesInUse() { return 0; },
        },
        sync: {
            async get(keys) { return storeGet(sync, keys); },
            async set(obj) { Object.assign(sync, obj); },
        },
        onChanged: { addListener() {} },
    },
    action: {
        async setIcon() {}, async setTitle() {},
        async setBadgeText() {}, async setBadgeBackgroundColor() {},
    },
    idle: { async queryState() { return 'idle'; } },        // -> isUserActive() === false
    windows: { async get() { return { focused: false }; } }, // -> isTabFocused() === false
    runtime: { lastError: null, onMessage: { addListener() {} }, getURL: (p) => p, id: 'test' },
    i18n: { getMessage: (k) => k },
};

// Seed global settings so loadGlobalSettings() reads a deterministic, neutral config:
// jitter OFF (so >=60s alarms stay periodic and re-arm is exact) and smart-pause OFF.
sync.globalSettings = {
    theme: 'dark',
    intervalJitterEnabled: false,
    intervalJitterPercent: 20,
    bypassCacheOnRefresh: false,
    autoRecoverEnabled: false,
    pauseWhileActiveEnabled: false,
};
local.globalLists = { whitelist: [], blacklist: [], scheduledRefreshes: [] };

// ---------------------------------------------------------------------------
// Import the modules under test (transitively imports the rest of background/).
// ---------------------------------------------------------------------------
const { forceCheckAlarmForTab, initializeAlarmHandler } = await import('../background/alarmHandler.js');
const { initializeStateManagement } = await import('../background/state.js');
const { tryAcquireTab, releaseTab } = await import('../background/inFlightTabs.js');
const { TAB_ALARM_PREFIX } = await import('../background/constants.js');

initializeStateManagement({ updateIconBadge: async () => {} }); // silence the badge callback
initializeAlarmHandler({});                                      // optional deps all guarded

const alarmName = (id) => `${TAB_ALARM_PREFIX}${id}`;

function seedTab(id, interval, scheduledTime, periodInMinutes) {
    local[`tab_${id}`] = {
        isActive: true, isPaused: false, interval,
        jitterMode: 'off', refreshMode: 'default', recoverMode: 'default',
        soundEnabled: false, isScheduled: false, refreshCount: 0,
        alarmName: alarmName(id),
    };
    const a = { name: alarmName(id), scheduledTime };
    if (periodInMinutes) a.periodInMinutes = periodInMinutes;
    alarms.set(alarmName(id), a);
}

// ---------------------------------------------------------------------------
// Tiny test harness.
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`[OK]   ${name}`); }
    else { failed++; console.log(`[FAIL] ${name}${detail ? ' -> ' + detail : ''}`); }
}
const reloadsFor = (id) => calls.reload.filter((r) => r.id === id).length;

// ---------------------------------------------------------------------------
// Case 1: one-shot (30s) alarm, overdue -> reload + re-arm one-shot in the future.
// ---------------------------------------------------------------------------
{
    const id = 101;
    seedTab(id, 30, Date.now() - 800);        // 0.8s overdue (the old >1000ms guard would have missed this)
    const ret = await forceCheckAlarmForTab(id);
    const a = alarms.get(alarmName(id));
    check('oneshot: dispatched', ret === true);
    check('oneshot: reloaded once', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('oneshot: alarm re-armed (not lost)', !!a);
    check('oneshot: re-armed in the future', a && a.scheduledTime > Date.now() + 20000,
        a && `delta=${a.scheduledTime - Date.now()}`);
    check('oneshot: stays one-shot (no periodInMinutes)', a && a.periodInMinutes === undefined);
}

// ---------------------------------------------------------------------------
// Case 2: periodic (60s) alarm, overdue -> reload + re-arm PERIODIC future (badge recovers, no blank).
// ---------------------------------------------------------------------------
{
    const id = 102;
    seedTab(id, 60, Date.now() - 1500, 1);    // 1.5s overdue, periodic
    const ret = await forceCheckAlarmForTab(id);
    const a = alarms.get(alarmName(id));
    check('periodic: dispatched', ret === true);
    check('periodic: reloaded once', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('periodic: alarm re-armed (not lost / not blank)', !!a);
    check('periodic: re-armed in the future', a && a.scheduledTime > Date.now() + 50000,
        a && `delta=${a.scheduledTime - Date.now()}`);
    check('periodic: stays periodic (periodInMinutes=1)', a && a.periodInMinutes === 1);
}

// ---------------------------------------------------------------------------
// Case 3: on-time alarm (not yet due) -> NOT force-dispatched, no early reload.
// ---------------------------------------------------------------------------
{
    const id = 103;
    seedTab(id, 30, Date.now() + 400);        // 0.4s in the FUTURE (badge can show 00:00 here)
    const before = alarms.get(alarmName(id)).scheduledTime;
    const ret = await forceCheckAlarmForTab(id);
    const a = alarms.get(alarmName(id));
    check('ontime: not dispatched', ret === false);
    check('ontime: no reload', reloadsFor(id) === 0, `reloads=${reloadsFor(id)}`);
    check('ontime: alarm untouched', a && a.scheduledTime === before);
}

// ---------------------------------------------------------------------------
// Case 4: per-tab lock held (simulates a concurrent recovery reload) -> the forced dispatch must
// NOT clear the alarm and must NOT reload; after release a retry re-arms:
// clear-before-dispatch would have lost the timer here.
// ---------------------------------------------------------------------------
{
    const id = 104;
    seedTab(id, 30, Date.now() - 2000);       // 2s overdue
    check('lock: pre-acquire lock', tryAcquireTab(id) === true);
    const clearedBefore = calls.cleared.length;
    await forceCheckAlarmForTab(id);
    const a = alarms.get(alarmName(id));
    check('lock-held: alarm NOT cleared (timer not lost)', !!a && calls.cleared.length === clearedBefore,
        `present=${!!a} cleared=${calls.cleared.length - clearedBefore}`);
    check('lock-held: no reload while busy', reloadsFor(id) === 0, `reloads=${reloadsFor(id)}`);

    releaseTab(id);
    await forceCheckAlarmForTab(id);          // retry now that the lock is free
    const a2 = alarms.get(alarmName(id));
    check('lock-released: reloaded once on retry', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('lock-released: alarm re-armed in the future', a2 && a2.scheduledTime > Date.now() + 20000);
}

// ---------------------------------------------------------------------------
// Case 5: consecutive zero-tick calls are self-limiting -> exactly one reload per episode
// (the first dispatch re-arms into the future, so the second call sees overdueMs <= 0).
// ---------------------------------------------------------------------------
{
    const id = 105;
    seedTab(id, 30, Date.now() - 700);
    await forceCheckAlarmForTab(id);
    await forceCheckAlarmForTab(id);          // immediate second "tick"
    check('self-limiting: exactly one reload across two ticks', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '[PASS]' : '[FAILED]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// Regression test for the recovery<->refresh lost-timer race.
//
// When auto-recover is ON and a tab uses a one-shot refresh alarm (interval < 60s, or jittered), a
// recovery reload borrows the shared per-tab in-flight lock. If the normal refresh one-shot fires during
// that window Chrome consumes it and handleAlarm returns at its lock guard without re-arming, so the
// refresh timer is lost until the slow orphan watchdog. doRecoveryReloadImpl now calls
// restoreRefreshAlarmIfConsumed after a successful reload to re-arm a MISSING refresh alarm immediately,
// while leaving a still-scheduled alarm untouched.
//
// Run: node tests/recovery-refresh-rearm.test.mjs   (from the project root)
// ASCII-only output by project convention.

// ---------------------------------------------------------------------------
// chrome.* mock (webNavigation present so auto-recover is active).
// ---------------------------------------------------------------------------
const alarms = new Map();
const local = {};
const sync = {};
const calls = { reload: [] };

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
    webNavigation: {                   // truthy -> auto-recover feature considered enabled
        onCommitted: { addListener() {}, removeListener() {} },
        onCompleted: { addListener() {}, removeListener() {} },
        onErrorOccurred: { addListener() {}, removeListener() {} },
    },
    alarms: {
        async get(name) { return alarms.get(name) || null; },
        async getAll() { return [...alarms.values()]; },
        async create(name, opts) {
            const a = { name, scheduledTime: Date.now() + Math.round((opts.delayInMinutes || 0) * 60000) };
            if (opts.periodInMinutes) a.periodInMinutes = opts.periodInMinutes;
            alarms.set(name, a);
        },
        async clear(name) { return alarms.delete(name); },
        onAlarm: { addListener() {} },
    },
    tabs: {
        async get(id) { return { id, url: 'https://example.com/' }; },
        async reload(id, opts) { calls.reload.push({ id, opts }); },
        async query() { return []; },
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, onActivated: { addListener() {} },
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
    action: { async setIcon() {}, async setTitle() {}, async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
    runtime: { lastError: null, onMessage: { addListener() {} }, getURL: (p) => p, id: 'test' },
    i18n: { getMessage: (k) => k },
};
global.self = { addEventListener() {} };  // navigationRecovery registers online/offline listeners at init

sync.globalSettings = {
    theme: 'dark', intervalJitterEnabled: false, intervalJitterPercent: 20,
    bypassCacheOnRefresh: false, autoRecoverEnabled: true, pauseWhileActiveEnabled: false,
};
local.globalLists = { whitelist: [], blacklist: [], scheduledRefreshes: [] };

// ---------------------------------------------------------------------------
const { handleRecoveryAlarm, initializeNavigationRecovery } = await import('../background/navigationRecovery.js');
const { initializeStateManagement, updateTabStorageAndState } = await import('../background/state.js');
const { TAB_ALARM_PREFIX, RECOVER_ALARM_PREFIX } = await import('../background/constants.js');

initializeStateManagement({ updateIconBadge: async () => {} });
initializeNavigationRecovery({ logActivity: () => {} });

const refreshName = (id) => `${TAB_ALARM_PREFIX}${id}`;
const recoverName = (id) => `${RECOVER_ALARM_PREFIX}${id}`;

function seedRecoveryTab(id, { refreshAlarm = null, lastArmed = true } = {}) {
    local[`tab_${id}`] = {
        isActive: true, isPaused: false, interval: 30,
        jitterMode: 'off', refreshMode: 'default', recoverMode: 'on',
        soundEnabled: false, isScheduled: false, refreshCount: 0,
    };
    local[`tab_${id}_recovery`] = { count: 1, nextAt: Date.now() };
    if (lastArmed) local[`tab_${id}_lastArmed`] = Date.now() - 30000;
    if (refreshAlarm) alarms.set(refreshName(id), refreshAlarm);
    else alarms.delete(refreshName(id));
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`[OK]   ${name}`); }
    else { failed++; console.log(`[FAIL] ${name}${detail ? ' -> ' + detail : ''}`); }
}
const reloadsFor = (id) => calls.reload.filter((r) => r.id === id).length;

// ---------------------------------------------------------------------------
// Case 1: refresh one-shot was CONSUMED during recovery (alarm absent) -> restored after reload.
// ---------------------------------------------------------------------------
{
    const id = 201;
    seedRecoveryTab(id, { refreshAlarm: null, lastArmed: true });
    await handleRecoveryAlarm({ name: recoverName(id), scheduledTime: Date.now() - 1000 });
    const ra = alarms.get(refreshName(id));
    check('consumed: recovery reloaded the tab', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('consumed: normal refresh alarm restored', !!ra);
    check('consumed: restored in the future', ra && ra.scheduledTime > Date.now() + 20000,
        ra && `delta=${ra.scheduledTime - Date.now()}`);
}

// ---------------------------------------------------------------------------
// Case 2: refresh alarm STILL PRESENT (periodic) -> recovery does NOT reset it (normal case untouched).
// ---------------------------------------------------------------------------
{
    const id = 202;
    const future = Date.now() + 60000;
    seedRecoveryTab(id, { refreshAlarm: { name: refreshName(id), scheduledTime: future, periodInMinutes: 1 }, lastArmed: true });
    await handleRecoveryAlarm({ name: recoverName(id), scheduledTime: Date.now() - 1000 });
    const ra = alarms.get(refreshName(id));
    check('present: recovery reloaded the tab', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('present: refresh alarm untouched (schedule not reset)', ra && ra.scheduledTime === future && ra.periodInMinutes === 1,
        ra && `scheduledTime=${ra.scheduledTime} period=${ra.periodInMinutes}`);
}

// ---------------------------------------------------------------------------
// Case 3: refresh alarm absent AND no lastArmed stamp -> do NOT resurrect (stopped/legacy tab guard).
// ---------------------------------------------------------------------------
{
    const id = 203;
    seedRecoveryTab(id, { refreshAlarm: null, lastArmed: false });
    await handleRecoveryAlarm({ name: recoverName(id), scheduledTime: Date.now() - 1000 });
    const ra = alarms.get(refreshName(id));
    check('no-stamp: recovery reloaded the tab', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('no-stamp: refresh alarm NOT resurrected', !ra);
}

// ---------------------------------------------------------------------------
// Case 4: a stop lands DURING the restore (between the pre-arm read and the post-arm recheck). The
// function must NOT write its stale active snapshot back over the stop -> no zombie refresher.
// We inject the stop inside chrome.alarms.create (called by scheduleTabRefresh, i.e. mid-restore).
// ---------------------------------------------------------------------------
{
    const id = 204;
    seedRecoveryTab(id, { refreshAlarm: null, lastArmed: true });
    let flipped = false;
    const realCreate = chrome.alarms.create;
    chrome.alarms.create = async (name, opts) => {
        await realCreate(name, opts);
        if (name === refreshName(id) && !flipped) {
            flipped = true; // simulate stopRefreshForTab completing mid-restore (it does not take the lock)
            await updateTabStorageAndState(id, { isActive: false, isPaused: false, interval: null });
        }
    };
    await handleRecoveryAlarm({ name: recoverName(id), scheduledTime: Date.now() - 1000 });
    chrome.alarms.create = realCreate;
    const finalState = local[`tab_${id}`];
    check('stop-race: recovery reloaded the tab', reloadsFor(id) === 1, `reloads=${reloadsFor(id)}`);
    check('stop-race: stopped state NOT overwritten (no zombie refresher)',
        finalState && finalState.isActive === false, `isActive=${finalState && finalState.isActive}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '[PASS]' : '[FAILED]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

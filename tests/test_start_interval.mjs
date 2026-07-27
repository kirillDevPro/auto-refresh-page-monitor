/**
 * Regression for the non-interactive start-interval ladder (background/startInterval.js).
 *
 * A shortcut/bulk start has no typed interval, so resolveStartInterval picks one via a 3-rung ladder:
 *   1. the tab's own live interval (an active tab),
 *   2. else the persisted lastUsedInterval (what the user last chose),
 *   3. else DEFAULT_START_INTERVAL_SECONDS (60) on a fresh profile.
 * A stopped tab (interval:null) must fall to rung 2, never return null. recordLastUsedInterval persists
 * write-if-changed, rejects garbage, and drops its cache on a failed write so the next start retries.
 *
 * The module's dedup cache is module state, so each scenario loads a FRESH singleton (?v=N).
 * Run: node tests/test_start_interval.mjs
 */
let store = {};
let setCalls = 0;
let failNextSet = false;
let failNextGet = false;

global.chrome = {
    storage: {
        local: {
            get: async (key) => {
                if (failNextGet) { failNextGet = false; throw new Error('simulated read failure'); }
                return key in store ? { [key]: store[key] } : {};
            },
            set: async (obj) => {
                setCalls++;
                if (failNextSet) { failNextSet = false; throw new Error('simulated write failure'); }
                Object.assign(store, obj);
            }
        }
    }
};

let n = 0;
const fresh = () => import(`../background/startInterval.js?v=${++n}`);
const tick = () => new Promise(r => setImmediate(r)); // let a fire-and-forget write settle

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} -> ${a}`) : fail(`${m}: got ${a}, want ${b}`));

// rung 3 — fresh profile
{
    store = {};
    const { resolveStartInterval } = await fresh();
    eq(await resolveStartInterval(null), 60, 'rung 3: fresh profile falls back to the default (60)');
    eq(await resolveStartInterval(999), 60, 'rung 3: an unknown tab falls back too');
}

// rung 2 — a stopped tab (interval:null) must NOT return null
{
    store = { tab_7: { isActive: false, interval: null, jitterMode: 'on' }, lastUsedInterval: 300 };
    const { resolveStartInterval } = await fresh();
    eq(await resolveStartInterval(7), 300, 'rung 2: a stopped tab uses lastUsedInterval, not null/60');
    eq(await resolveStartInterval(null), 300, 'rung 2: a bulk start (tabId null) skips rung 1');
}

// rung 1 — an active tab's own interval wins
{
    store = { tab_9: { isActive: true, interval: 45 }, lastUsedInterval: 300 };
    const { resolveStartInterval } = await fresh();
    eq(await resolveStartInterval(9), 45, "rung 1: the active tab's own interval outranks lastUsedInterval");
}

// corrupt rungs are skipped, never returned
{
    store = { tab_5: { interval: 0 }, lastUsedInterval: 120 };
    const a = await fresh();
    eq(await a.resolveStartInterval(5), 120, 'corrupt rung 1 (interval 0) is skipped');
    store = { lastUsedInterval: 'banana' };
    const b = await fresh();
    eq(await b.resolveStartInterval(null), 60, 'corrupt rung 2 (non-numeric) falls to the default');
}

// a storage read failure fails open to the default, never throws
{
    store = { lastUsedInterval: 300 };
    const { resolveStartInterval } = await fresh();
    failNextGet = true;
    try { eq(await resolveStartInterval(null), 60, 'a read failure falls through to the default'); }
    catch (e) { fail(`read failure threw: ${e.message}`); }
}

// recordLastUsedInterval: persists, dedups, rejects garbage, retries after a failed write
{
    store = {}; setCalls = 0;
    const { recordLastUsedInterval, resolveStartInterval } = await fresh();
    recordLastUsedInterval(90); await tick();
    eq(store.lastUsedInterval, 90, 'record persists the interval');
    eq(await resolveStartInterval(null), 90, 'a recorded interval becomes rung 2');

    const before = setCalls;
    recordLastUsedInterval(90); recordLastUsedInterval(90); await tick();
    eq(setCalls - before, 0, 'record dedups a repeat of the same value');

    const g = setCalls;
    recordLastUsedInterval(0); recordLastUsedInterval(-5); recordLastUsedInterval(NaN); recordLastUsedInterval(undefined); await tick();
    eq(setCalls - g, 0, 'record rejects 0 / negative / NaN / undefined without writing');
}
{
    store = {}; setCalls = 0;
    const { recordLastUsedInterval } = await fresh();
    failNextSet = true;
    recordLastUsedInterval(150); await tick();
    eq(store.lastUsedInterval, undefined, 'a failed write leaves nothing persisted');
    const after = setCalls;
    recordLastUsedInterval(150); await tick(); // same value: deduped only if the cache survived
    eq(setCalls - after, 1, 'a failed write drops the cache so the same value is retried');
    eq(store.lastUsedInterval, 150, 'the retry lands');
}

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all start-interval ladder checks passed`);
process.exit(failures ? 1 : 0);

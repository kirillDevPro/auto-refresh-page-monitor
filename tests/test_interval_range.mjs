/**
 * Regression test for the interval-RANGE math (shared/intervalRange.js) and the range<->jitter-mode
 * invariant it must satisfy (background/settings.js resolveJitterPercent).
 *
 * Pins:
 *  1. rangeToBaseAndPercent maps [min,max] to the (interval, percent) pair applyJitter needs, and snaps
 *     an ODD sum down (max-1) so applyJitter can never round above the effective max.
 *  2. applyJitter over the derived pair stays strictly within the effective [min,max] across many draws.
 *  3. baseAndPercentToRange is the exact inverse and is stable across repeated round-trips.
 *  4. validateRange runs on the RAW input (before any clamp) so an out-of-range/non-integer/min>max
 *     entry is actually rejected.
 *  5. THE COLLAPSED-RANGE GUARD: a zero-width range yields percent 0, and the resolver honors an item
 *     percent only under an explicit 'on' — so emitting 'on' with a 0 percent would fall back to the
 *     GLOBAL percent (randomizing a fixed interval). A collapsed range must therefore start as 'off'.
 *
 * Pure/leaf imports only (no chrome mock): settings.js touches chrome only inside functions.
 * Run: node tests/test_interval_range.mjs
 */
import { rangeToBaseAndPercent, baseAndPercentToRange, validateRange } from '../shared/intervalRange.js';
import { applyJitter } from '../background/jitter.js';
import { resolveJitterPercent, updateGlobalAppSettings } from '../background/settings.js';
import { MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS } from '../background/constants.js';

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} -> ${JSON.stringify(a)}`) : fail(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));

// --- 1: base/percent derivation + even-sum snap ---------------------------
{
    const r = rangeToBaseAndPercent(30, 90);
    eq(r.interval, 60, 'range 30..90 -> midpoint interval 60');
    eq(r.jitterPercent, 50, 'range 30..90 -> +/-50%');
    eq(r.min, 30, 'effective min unchanged');
    eq(r.max, 90, 'effective max unchanged (even sum)');

    const odd = rangeToBaseAndPercent(30, 91);
    eq(odd.max, 90, 'odd sum 30..91 snaps max DOWN to 90 (never up)');
    eq(odd.interval, 60, 'snapped range has an integer midpoint');
    eq(odd.jitterPercent, 50, 'snapped range has an integer-derived percent');

    // Reversed input is normalized.
    const rev = rangeToBaseAndPercent(90, 30);
    eq(rev.interval, 60, 'reversed [90,30] normalizes to the same range');
}

// --- 2: applyJitter never exceeds the effective bounds --------------------
{
    const { interval, jitterPercent, min, max } = rangeToBaseAndPercent(30, 91); // effective 30..90
    let lo = Infinity, hi = -Infinity, outOfBand = 0;
    for (let i = 0; i < 20000; i++) {
        const v = applyJitter(interval, jitterPercent);
        if (v < min || v > max) outOfBand++;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    eq(outOfBand, 0, '20k jittered draws all land within the effective [30,90]');
    if (lo <= 33 && hi >= 87) ok(`draws cover the band (observed [${lo}, ${hi}])`);
    else fail(`draws do not cover the band: observed [${lo}, ${hi}]`);
}

// --- 3: round-trip inverse, stable across repeats -------------------------
{
    let interval = 60, percent = 50;
    for (let i = 0; i < 5; i++) {
        const { min, max } = baseAndPercentToRange(interval, percent);
        const back = rangeToBaseAndPercent(min, max);
        eq(back.interval, interval, `round-trip #${i + 1} keeps interval`);
        eq(back.jitterPercent, percent, `round-trip #${i + 1} keeps percent`);
        interval = back.interval; percent = back.jitterPercent;
    }
    const fixed = baseAndPercentToRange(120, 0);
    eq(fixed.min, 120, 'a 0-percent pair reconstructs a zero-width range (min)');
    eq(fixed.max, 120, 'a 0-percent pair reconstructs a zero-width range (max)');
}

// --- 4: validateRange runs on the RAW input, pre-clamp --------------------
{
    eq(validateRange(30, 90, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS).ok, true, 'a valid range passes');
    eq(validateRange(20, 90, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS).reason, 'out_of_range', 'min below the floor is rejected RAW (a post-clamp check could not)');
    eq(validateRange(30, 99999, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS).reason, 'out_of_range', 'max above the ceiling is rejected');
    eq(validateRange(90, 30, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS).reason, 'min_gt_max', 'min > max is rejected');
    eq(validateRange(30.5, 90, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS).reason, 'not_integer', 'a fractional bound is rejected');
}

// --- 5: a collapsed range must NOT ride jitterMode 'on' -------------------
{
    // A zero-width range (min===max) and a range that collapses after the even-sum snap both yield 0%.
    eq(rangeToBaseAndPercent(60, 60).jitterPercent, 0, 'a zero-width range [60,60] yields 0%');
    eq(rangeToBaseAndPercent(30, 31).jitterPercent, 0, 'an adjacent range [30,31] collapses (snap) to 0%');

    // Global jitter ON at 20%. This is the exact trap the fix guards.
    updateGlobalAppSettings({ intervalJitterEnabled: true, intervalJitterPercent: 20 });
    eq(resolveJitterPercent('on', 0), 20, "'on' with a 0 percent falls back to the GLOBAL percent (why the popup must not emit it for a collapsed range)");
    eq(resolveJitterPercent('off', 0), 0, "the fix: a collapsed range starts as 'off' -> a fixed interval, no jitter");
    eq(resolveJitterPercent('on', 50), 50, "a real range ('on' + non-zero percent) is honored over the global");

    // The write-site decision the popup applies: jitterPercent>0 ? 'on' : 'off'.
    const mode = (pct) => (pct > 0 ? 'on' : 'off');
    eq(resolveJitterPercent(mode(rangeToBaseAndPercent(60, 60).jitterPercent), 0), 0, 'a collapsed range resolves to no jitter (fixed interval)');
    eq(resolveJitterPercent(mode(rangeToBaseAndPercent(30, 90).jitterPercent), 50), 50, 'a real range resolves to its own percent');
}

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all interval-range checks passed`);
process.exit(failures ? 1 : 0);

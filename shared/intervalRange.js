// shared/intervalRange.js — pure min-max interval-range math for the popup range picker.
//
// A dependency-free cross-tree leaf (no chrome.* / DOM), like intervalPresets.js — any module tree may
// import it; currently only the popup does (the settings per-rule range UI is deferred).
//
// An interval RANGE [min, max] is not a new scheduling mechanism — it is the existing uniform jitter
// re-parameterized. applyJitter(base, pct) draws uniformly on [base - base*pct/100, base + base*pct/100].
// Setting base = (min+max)/2 and pct = (max-min)/(max+min)*100 makes that interval exactly [min, max].
// So a range is stored as an ordinary (interval, jitterPercent) pair and rides the whole existing
// one-shot / re-arm / badge machinery unchanged.
//
// The one subtlety: applyJitter rounds to whole seconds, so base and span must both be integers or the
// drawn value can round to base+span+1 — OVER the requested max. That happens exactly when (min+max) is
// odd. rangeToBaseAndPercent snaps to an even sum by lowering max by 1 (never raising it, so the
// effective range stays within what the user asked for) and returns the EFFECTIVE bounds, which the UI
// writes back so the user sees precisely what will run.

/**
 * Convert a requested [min, max] range into the (interval, jitterPercent) pair the scheduler uses.
 *
 * Snaps min+max to an even sum (lowering max by 1 when needed) so base and span are integers and
 * applyJitter can never exceed the effective max. Returns the effective bounds alongside the pair.
 * @param {number} minSeconds - Requested lower bound (whole seconds).
 * @param {number} maxSeconds - Requested upper bound (whole seconds); must be >= minSeconds.
 * @returns {{min: number, max: number, interval: number, jitterPercent: number}} Effective values.
 */
export function rangeToBaseAndPercent(minSeconds, maxSeconds) {
    let min = Math.round(minSeconds);
    let max = Math.round(maxSeconds);
    if (max < min) [min, max] = [max, min];
    // Snap to an even sum so (min+max)/2 and (max-min)/2 are both integers. Lower max, never raise it,
    // so the effective range is a subset of the requested one and never fires above the asked max.
    if ((min + max) % 2 !== 0) max = Math.max(min, max - 1);
    const interval = (min + max) / 2;
    const span = (max - min) / 2;
    const jitterPercent = interval > 0 ? (span / interval) * 100 : 0;
    return { min, max, interval, jitterPercent };
}

/**
 * Inverse of rangeToBaseAndPercent: reconstruct [min, max] from a stored (interval, jitterPercent).
 *
 * Used to repopulate the range inputs when re-opening the popup/modal, so the range is DERIVED from the
 * stored pair rather than persisted as extra fields. Stable across repeated round-trips because
 * rangeToBaseAndPercent only ever emits integer interval/span pairs.
 * @param {number} interval - Stored nominal interval (seconds).
 * @param {number} jitterPercent - Stored jitter strength (percent); 0 means no range.
 * @returns {{min: number, max: number}} The reconstructed bounds.
 */
export function baseAndPercentToRange(interval, jitterPercent) {
    const pct = Number(jitterPercent);
    if (!Number.isFinite(pct) || pct <= 0) return { min: interval, max: interval };
    const span = Math.round(interval * pct / 100);
    return { min: interval - span, max: interval + span };
}

/**
 * Validate a RAW requested range before any clamping.
 *
 * clampInterval maps every finite value into [minBound, maxBound], which would make a post-clamp bound
 * check tautological — so validation must run on the raw input. Returns a reason code the UI maps to a
 * localized message, not a thrown error.
 * @param {*} minSeconds - Raw lower-bound input.
 * @param {*} maxSeconds - Raw upper-bound input.
 * @param {number} minBound - Lowest allowed interval (MIN_INTERVAL_SECONDS).
 * @param {number} maxBound - Highest allowed interval (MAX_INTERVAL_SECONDS).
 * @returns {{ok: boolean, reason?: string}} ok=true when valid; reason is 'not_integer' | 'out_of_range' | 'min_gt_max'.
 */
export function validateRange(minSeconds, maxSeconds, minBound, maxBound) {
    const min = Number(minSeconds);
    const max = Number(maxSeconds);
    if (!Number.isInteger(min) || !Number.isInteger(max)) return { ok: false, reason: 'not_integer' };
    if (min < minBound || max > maxBound) return { ok: false, reason: 'out_of_range' };
    if (min > max) return { ok: false, reason: 'min_gt_max' };
    return { ok: true };
}

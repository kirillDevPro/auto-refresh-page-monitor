// jitter.js — pure interval-randomization math, shared across all alarm-arming paths.
// Depends only on the lower interval-bound constant, so it is unit-testable in Node
// without a chrome mock (like resolveBypassCache in settings.js).

import { MIN_INTERVAL_SECONDS } from './constants.js';

/**
 * Apply uniform +/-percent jitter around a base interval.
 * Returns the base unchanged when percent is falsy/<=0. The result is floored at
 * MIN_INTERVAL_SECONDS (Chrome clamps shorter alarm delays anyway), so for a base
 * already at the floor jitter only ever lengthens the delay. Rounded to whole seconds.
 *
 * @param {number} baseSeconds - nominal interval in seconds
 * @param {number} percent - jitter magnitude in percent (e.g. 20 => +/-20%)
 * @returns {number} jittered delay in seconds
 */
export function applyJitter(baseSeconds, percent) {
    if (!percent || percent <= 0) return baseSeconds;
    const span = baseSeconds * (percent / 100);
    const offset = (Math.random() * 2 - 1) * span; // uniformly within [-span, +span]
    return Math.max(Math.round(baseSeconds + offset), MIN_INTERVAL_SECONDS);
}

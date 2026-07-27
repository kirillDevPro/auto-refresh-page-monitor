/**
 * Pure, dependency-free helpers for scheduled-refresh URL patterns.
 *
 * No chrome.* and no DOM access, so this settings-tree leaf can be imported directly in a
 * Node unit test. Used by settings.scheduledRefreshes.js for exact-duplicate detection
 * (normalizeUrl) and for pattern-overlap detection (schedulePatternsOverlap).
 */

/**
 * Normalize a URL for exact-duplicate comparison: lowercase it and strip the protocol
 * and a leading "www.". A trailing "*" wildcard is preserved.
 * @param {string} url - The raw URL/pattern to normalize.
 * @returns {string} The normalized string used for exact-duplicate detection.
 */
export function normalizeUrl(url) {
    return url
        .toLowerCase()
        .replace(/^https?:\/\//, '')  // remove protocol
        .replace(/^www\./, '');        // remove leading www.
}

/**
 * True if two scheduled-rule patterns would both fire on at least one common URL, evaluated
 * with the SAME raw, case-sensitive grammar as the runtime matcher (background/scheduler.js
 * urlMatchesPattern): a trailing "*" is a prefix wildcard, otherwise the pattern is an exact URL.
 *
 * Comparison is intentionally raw (no normalizeUrl) so it never blocks two rules that can never
 * match the same URL at runtime, such as rules differing only by protocol (http vs https) or path case.
 * Overlap for this exact-or-prefix grammar reduces to "there exists a URL both patterns match".
 * @param {string} a - First pattern (raw, trimmed).
 * @param {string} b - Second pattern (raw, trimmed).
 * @returns {boolean} True when some URL matches both patterns.
 */
export function schedulePatternsOverlap(a, b) {
    const aStar = a.endsWith('*');
    const bStar = b.endsWith('*');
    const aBase = aStar ? a.slice(0, -1) : a;
    const bBase = bStar ? b.slice(0, -1) : b;
    // both exact: overlap only when they are the same URL
    if (!aStar && !bStar) return a === b;
    // both prefix wildcards: a common URL exists iff one prefix contains the other
    if (aStar && bStar) return aBase.startsWith(bBase) || bBase.startsWith(aBase);
    // one prefix, one exact: the exact URL must start with the prefix base
    if (aStar) return b.startsWith(aBase);
    return a.startsWith(bBase);
}

/**
 * True if `pattern` is a plausible scheduled-refresh target. The scheme is OPTIONAL: a bare host/URL
 * ("example.com", "example.com/path*") is accepted and stored as typed. Rejected: whitespace; an
 * explicit non-http(s) scheme (ftp:, chrome:, ...); text with no parseable host; and - for scheme-less
 * input only - a host with no dot (a bare word like "randomtext"), so gibberish is still blocked while
 * real domains pass. This is only a format/anti-gibberish gate; it does not rewrite the entered value.
 *
 * Whitespace is rejected outright: a raw space can never match the %20-encoded URL a real tab reports,
 * and the URL constructor would silently encode it instead of failing.
 * @param {string} pattern - The raw, trimmed URL/pattern from the schedule modal.
 * @returns {boolean} True when the pattern names a real http(s) site.
 */
export function isValidSchedulePattern(pattern) {
    if (typeof pattern !== 'string') return false;
    if (/\s/.test(pattern)) return false;
    // An explicit non-http(s) scheme (ftp://, chrome://, ...) can never be a refreshable tab.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) && !/^https?:\/\//i.test(pattern)) return false;
    const hadScheme = /^https?:\/\//i.test(pattern);
    const withScheme = hadScheme ? pattern : 'https://' + pattern;
    const base = withScheme.endsWith('*') ? withScheme.slice(0, -1) : withScheme;
    try {
        const url = new URL(base);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        if (!url.hostname) return false;
        // Scheme-less input must be a DOTTED host (real domain / IP), so a bare word isn't accepted.
        // Explicit-scheme input is trusted (permits localhost and other single-label hosts).
        if (!hadScheme && !url.hostname.includes('.')) return false;
        return true;
    } catch {
        return false;
    }
}

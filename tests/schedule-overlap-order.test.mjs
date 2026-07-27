/**
 * Regression test for scheduled-refresh overlap detection and newest-first display order.
 *
 * Pins:
 *  1. schedulePatternsOverlap() matches the RUNTIME exact-or-prefix grammar
 *     (background/scheduler.js urlMatchesPattern) on RAW, case-sensitive strings, so it
 *     never flags rules that can never fire on the same URL (protocol / path-case differ).
 *  2. normalizeUrl() strips protocol + leading www. and lowercases, preserving a trailing '*'.
 *  3. Source-of-truth wiring in settings.scheduledRefreshes.js: getDisplaySchedules reverses a
 *     COPY (newest-first, no mutation), the local normalizeUrl was decommissioned, and
 *     validateScheduleData routes duplicate + overlap through the shared helpers.
 *
 * Run: node tests/schedule-overlap-order.test.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { normalizeUrl, schedulePatternsOverlap, isValidSchedulePattern } from '../settings/scheduleUtils.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };
const eq = (got, want, label) => { if (got === want) ok(label); else fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

// Reference oracle: the exact runtime matcher copied from background/scheduler.js.
const urlMatchesPattern = (url, pattern) => pattern.endsWith('*') ? url.startsWith(pattern.slice(0, -1)) : url === pattern;
// Brute-force overlap over a URL corpus, to cross-check schedulePatternsOverlap for chosen cases.
const CORPUS = [
    'https://example.com/', 'https://example.com/a', 'https://example.com/ab', 'https://example.com/b',
    'https://example.com/Foo', 'https://example.com/foo', 'https://example.com/foo/page',
    'http://example.com/a', 'http://example.com/', 'https://other.com/a', 'http://x', 'https://x',
];
const bruteOverlap = (a, b) => CORPUS.some(u => urlMatchesPattern(u, a) && urlMatchesPattern(u, b));

// --- 1: schedulePatternsOverlap direct cases ------------------------------
eq(schedulePatternsOverlap('https://a.com/x', 'https://a.com/x'), true, 'exact == exact overlaps');
eq(schedulePatternsOverlap('https://a.com/x', 'https://a.com/y'), false, 'distinct exacts do not overlap');
eq(schedulePatternsOverlap('https://a.com/*', 'https://a.com/page'), true, 'prefix covers exact (A prefix, B exact)');
eq(schedulePatternsOverlap('https://a.com/page', 'https://a.com/*'), true, 'prefix covers exact (A exact, B prefix)');
eq(schedulePatternsOverlap('https://a.com/x*', 'https://a.com/y'), false, 'prefix not covering exact => no overlap');
eq(schedulePatternsOverlap('https://a.com/a*', 'https://a.com/*'), true, 'both prefix, one contains other');
eq(schedulePatternsOverlap('https://a.com/a*', 'https://a.com/b*'), false, 'both prefix, disjoint');
eq(schedulePatternsOverlap('*', 'https://anything/here'), true, 'bare * overlaps anything (A)');
eq(schedulePatternsOverlap('https://anything/here', '*'), true, 'bare * overlaps anything (B)');
eq(schedulePatternsOverlap('https://a.com/foo', 'https://a.com/foo*'), true, 'exact vs its own prefix overlaps');
eq(schedulePatternsOverlap('https://a.com/bar', 'https://a.com/foo*'), false, 'exact outside prefix does not overlap');
// runtime is RAW: protocol- and case-sensitive, so these disjoint-at-runtime pairs must NOT block
eq(schedulePatternsOverlap('http://a.com/x', 'https://a.com/x'), false, 'different protocol => no overlap (raw)');
eq(schedulePatternsOverlap('https://a.com/Foo*', 'https://a.com/foo/page'), false, 'different path case => no overlap (raw)');
eq(schedulePatternsOverlap('https://example.com/a', 'http*'), true, 'exact starting with a short prefix overlaps');

// --- 1b: cross-check a sample against the brute-force runtime oracle -------
const pairs = [
    ['https://example.com/a', 'https://example.com/a'], ['https://example.com/*', 'https://example.com/a'],
    ['https://example.com/a*', 'https://example.com/b'], ['http://example.com/a', 'https://example.com/a'],
    ['https://example.com/Foo', 'https://example.com/foo'], ['https://example.com/a', 'https://other.com/a'],
    ['http*', 'https://x'], ['https://example.com/ab', 'https://example.com/a*'],
];
let oracleOk = true;
for (const [a, b] of pairs) {
    if (schedulePatternsOverlap(a, b) !== bruteOverlap(a, b)) { fail(`oracle mismatch for [${a} , ${b}]`); oracleOk = false; }
}
if (oracleOk) ok('schedulePatternsOverlap agrees with the brute-force runtime oracle on all sample pairs');

// --- 2: normalizeUrl ------------------------------------------------------
eq(normalizeUrl('https://a.com/x'), 'a.com/x', 'normalizeUrl strips https://');
eq(normalizeUrl('http://a.com/x'), 'a.com/x', 'normalizeUrl strips http://');
eq(normalizeUrl('https://www.A.com/X'), 'a.com/x', 'normalizeUrl strips www. and lowercases');
eq(normalizeUrl('https://a.com/*'), 'a.com/*', 'normalizeUrl preserves a trailing *');
eq(normalizeUrl('http://a.com/p') === normalizeUrl('https://a.com/p'), true, 'http and https normalize equal (exact-dup policy)');

// --- 2b: isValidSchedulePattern (URL-format guard, scheme OPTIONAL) -------
// Cyrillic IDN host built from char codes so this test file stays ascii-only (o,k,.,r,f Cyrillic).
const IDN_HOST = String.fromCharCode(0x43e, 0x43a, 0x2e, 0x440, 0x444);
// ACCEPT: http(s) URLs AND scheme-less domains/URLs with a dotted host (incl. IDN, IP, port, IPv6, userinfo).
const goodPatterns = [
    'https://docs.example.com/spreadsheets/d/abc',
    'http://intranet.local:8123/main-board/home',
    'https://192.168.1.50:5001/?launchApp=x',
    'https://metrics.example.net/d/fleet-overview/*',
    'https://dashboard.example.org/settings/credits',
    'https://example.com/*',
    'http://localhost:3000/',   // explicit scheme -> a single-label host is allowed
    'http://[::1]:8080/',
    'http://user:pass@host.com/path?q=1#frag',
    'google.com',               // scheme-less domain -> accepted
    'example.com',
    'example.com/path*',
    'example.com:8080',
    'docs.google.com/spreadsheets/d/abc',
    `https://${IDN_HOST}/page`, // scheme-full Cyrillic IDN
    IDN_HOST,                   // scheme-less Cyrillic IDN (dotted host) -> accepted
];
for (const u of goodPatterns) eq(isValidSchedulePattern(u), true, `accepts: ${u}`);
// REJECT: gibberish / non-refreshable. 'abc def' / 'abcword' are ascii proxies for pasted gibberish;
// scheme-less dot-less hosts (localhost, abcword) are rejected, but an explicit http:// scheme allows them.
const badPatterns = [
    'abc def ghi', 'abcword', 'localhost', 'https://', 'https://*',
    'ftp://x.com', 'chrome://settings', 'javascript:alert(1)',
    'https://?garbage', 'https://:80', 'https://#frag', 'https://a.com/x y', '   ', '',
];
for (const u of badPatterns) eq(isValidSchedulePattern(u), false, `rejects: ${JSON.stringify(u)}`);
eq(isValidSchedulePattern(null), false, 'rejects non-string (null)');

// --- 3: source-of-truth wiring in settings.scheduledRefreshes.js ----------
const src = readFileSync(join(ROOT, 'settings', 'settings.scheduledRefreshes.js'), 'utf8');
if (/return \(currentSearchQuery \? filteredSchedules : allSchedules\)\.slice\(\)\.reverse\(\)/.test(src)) ok('getDisplaySchedules reverses a COPY (newest-first, no mutation)');
else fail('getDisplaySchedules does not reverse a slice() copy');
if (/import \{[^}]*schedulePatternsOverlap[^}]*\} from '\.\/scheduleUtils\.js'/.test(src)) ok('imports schedulePatternsOverlap from scheduleUtils.js');
else fail('does not import schedulePatternsOverlap from scheduleUtils.js');
if (!/function normalizeUrl\s*\(/.test(src)) ok('local normalizeUrl decommissioned (moved to scheduleUtils.js)');
else fail('a local normalizeUrl still exists in settings.scheduledRefreshes.js');
if (/schedulePatternsOverlap\(data\.url, item\.url\)/.test(src) && /overlapping_schedule_url/.test(src)) ok('validateScheduleData wires overlap check + overlapping_schedule_url message');
else fail('validateScheduleData does not wire the overlap check/message');
if (/isValidSchedulePattern\(data\.url\)/.test(src) && /invalid_schedule_url/.test(src)) ok('validateScheduleData wires the URL-format check + invalid_schedule_url message');
else fail('validateScheduleData does not wire the URL-format check/message');
if (/urlUnchanged/.test(src) && /editingItem/.test(src)) ok('validateScheduleData skips conflict checks when editing with an unchanged URL');
else fail('validateScheduleData lacks the unchanged-URL edit guard');
if (/function refreshAfterMutation\s*\(/.test(src)) ok('centralized refreshAfterMutation reconciliation helper exists');
else fail('refreshAfterMutation helper missing');

// --- 3a2: {url} substitution is lossless for URLs containing $ patterns ----
if (/\.replace\('\{url\}',\s*\(\)\s*=>/.test(src)) ok('overlap message uses a callback replacement for {url} ($-safe)');
else fail('overlap message does not use a callback replacement for {url}');
{
    const tricky = "https://x.com/a?b=$&$`$'$1"; // $-laden URL a string replacement would corrupt
    const rendered = 'see {url} now'.replace('{url}', () => tricky);
    eq(rendered, `see ${tricky} now`, 'callback replacement inserts a $-laden URL verbatim');
}

// --- 3b: reversing for display must not mutate the source array ------------
const source = [{ id: '1' }, { id: '2' }, { id: '3' }];
const view = source.slice().reverse();
if (view.map(x => x.id).join(',') === '3,2,1' && source.map(x => x.id).join(',') === '1,2,3') ok('slice().reverse() yields newest-first without mutating the source');
else fail('slice().reverse() mutated the source or produced wrong order');

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all checks passed`);
process.exit(failures ? 1 : 0);

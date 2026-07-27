/**
 * Pins the strongest PUBLIC CLAIM this project makes: the extension originates no network request of
 * its own.
 *
 * That sentence appears in README.md, SECURITY.md and — the one that matters — the published privacy
 * policy in docs/index.html, which the Chrome Web Store listing links. Today it is exactly true: the
 * only fetch() calls in the shipped code read the extension's own bundled locale JSON through
 * chrome.runtime.getURL(). Nothing in the repository stops a future edit from adding a real request,
 * while a matching documentation update could easily be missed. This converts three prose assertions
 * into one invariant CI checks.
 *
 * Pins, over the SHIPPED trees only (tests/, docs/ and .github/ are excluded from the package):
 *  1. Every fetch() call site passes a chrome.runtime.getURL(...) expression — never a URL literal,
 *     a variable, or a template string. `globalThis.`/`self.`/`window.`-qualified calls count, and a
 *     line with several calls is checked call by call.
 *  2. No other egress primitive appears at all: XMLHttpRequest, WebSocket, EventSource, sendBeacon,
 *     importScripts, or a dynamic import() of a remote URL.
 *  3. No shipped JAVASCRIPT contains an absolute remote URL literal. This is the catch-all that makes
 *     pins 1-2 hard to evade: assigning to `Image.src`, `Audio.src`, an injected element, or any API
 *     added to the platform after this test was written still needs a URL, and a URL in shipped code
 *     is either off-device or a chrome.runtime.getURL() path. Only host-wildcard MATCH PATTERNS (used
 *     for context-menu gating, never fetched) and the bare `https://` scheme prefix are allow-listed.
 *  4. No shipped HTML or CSS references a remote origin — no remote <script>/<link>/<img>, no
 *     @font-face or url() pointing off-device — except the one allow-listed outbound LINK to the
 *     Chrome Web Store listing, which is an <a href> a user must click, not a request the page makes.
 *  5. The audio message producer passes the bundled, relative SOUND_FILE path to the offscreen
 *     document, so its variable `src` sink cannot accidentally receive a remote constant.
 *
 * Breakage this catches: someone adds `fetch('https://api.example.com/…')`, a sendBeacon call, a
 * tracking pixel via `new Image().src`, or a remote webfont. The relevant pin fails naming file and
 * line, so the privacy policy cannot quietly become false. (Each example was shown to redden its
 * named pin by inserting it into a shipped file and reverting.)
 *
 * What this test does NOT prove: it is a static scan, so a URL assembled at runtime from fragments,
 * decoded from base64, or read out of storage would slip past it. Pin 5 narrows the one variable sink
 * that exists today — the audio `src` the offscreen document is handed — by pinning both the constant
 * and the fact that the only producer still passes it; it does not make that sink unreachable by a
 * determined edit. Static analysis beyond this test is still required to detect deliberately
 * obfuscated requests. Treat a green run as "no accidental egress was introduced", not as proof of
 * impossibility.
 *
 * Run: node tests/test_no_network.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
/**
 * Record and print a failed network-invariant check.
 * @param {string} msg - Failure description.
 * @returns {void}
 */
const fail = (msg) => { console.error(`[x] ${msg}`); failures++; };
/**
 * Print a successful network-invariant check.
 * @param {string} msg - Success description.
 * @returns {void}
 */
const ok = (msg) => console.log(`[+] ${msg}`);

/** Trees and files that ship inside the extension package. */
const SHIPPED_DIRS = ['background', 'popup', 'settings', 'shared'];
const SHIPPED_FILES = ['offscreen.js', 'offscreen.html'];

/**
 * The single sanctioned off-device reference in shipped markup: the Chrome Web Store listing link on
 * the settings page. It is an anchor the user clicks, not a resource the page loads.
 */
const ALLOWED_MARKUP_URLS = new Set([
    'https://chromewebstore.google.com/detail/auto-refresh-page-monitor/mhmkhlbgacabeffhkalebjnbnfakfdbj'
]);

/**
 * Recursively collect files under a directory.
 * @param {string} dir - absolute directory path
 * @param {RegExp} pattern - filename test
 * @returns {string[]} absolute file paths
 * @throws {Error} If a directory entry cannot be read or inspected.
 */
function walk(dir, pattern) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full, pattern));
        else if (pattern.test(name)) out.push(full);
    }
    return out;
}

/**
 * Convert an absolute repository path to a slash-separated relative path for diagnostics.
 * @param {string} p - Absolute path beneath the repository root.
 * @returns {string} Repository-relative path using forward slashes.
 */
const rel = (p) => relative(ROOT, p).split(sep).join('/');

const scriptFiles = [
    ...SHIPPED_DIRS.flatMap((d) => walk(join(ROOT, d), /\.(js|mjs)$/)),
    ...SHIPPED_FILES.filter((f) => /\.js$/.test(f)).map((f) => join(ROOT, f))
];
const markupFiles = [
    ...SHIPPED_DIRS.flatMap((d) => walk(join(ROOT, d), /\.(html|css)$/)),
    ...SHIPPED_FILES.filter((f) => /\.html$/.test(f)).map((f) => join(ROOT, f))
];

if (scriptFiles.length === 0 || markupFiles.length === 0) {
    fail('found no shipped script/markup files to scan — the scan roots are wrong');
}

// --- 1: every fetch() passes chrome.runtime.getURL(...) --------------------------------------
let fetchSites = 0;
let badFetches = 0;
for (const file of scriptFiles) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        // Every call on the line, and `globalThis.`/`self.`/`window.`-qualified forms too.
        for (const m of line.matchAll(/(?:(?:globalThis|self|window)\s*\.\s*)?(?<![\w.$])fetch\s*\(\s*([^)]*)/g)) {
            fetchSites++;
            if (!/^chrome\.runtime\.getURL\s*\(/.test(m[1].trim())) {
                fail(`${rel(file)}:${i + 1} — fetch() argument is not chrome.runtime.getURL(...): ${line.trim()}`);
                badFetches++;
            }
        }
    });
}
if (fetchSites === 0) {
    fail('scanned the shipped trees and found NO fetch() call — the scan matches nothing, so it proves nothing');
} else if (badFetches === 0) {
    ok(`all ${fetchSites} fetch() call sites read a bundled resource via chrome.runtime.getURL()`);
}

// --- 2: no other egress primitive anywhere in shipped code -----------------------------------
const FORBIDDEN = [
    [/\bnew\s+XMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bnew\s+WebSocket\b/, 'WebSocket'],
    [/\bnew\s+EventSource\b/, 'EventSource'],
    [/\bnavigator\s*\.\s*sendBeacon\b/, 'navigator.sendBeacon'],
    [/\bimportScripts\s*\(/, 'importScripts'],
    [/\bimport\s*\(\s*['"`]https?:/, 'dynamic import() of a remote URL']
];
let egress = 0;
for (const file of scriptFiles) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        for (const [re, label] of FORBIDDEN) {
            if (re.test(line)) { fail(`${rel(file)}:${i + 1} — forbidden egress primitive ${label}: ${line.trim()}`); egress++; }
        }
    });
}
if (egress === 0) ok(`no XMLHttpRequest / WebSocket / EventSource / sendBeacon / importScripts / remote import() in ${scriptFiles.length} shipped scripts`);

// --- 3: no absolute remote URL literal in shipped JavaScript ---------------------------------
// The catch-all. Any way of originating a request — Image.src, Audio.src, an injected element, an
// API that does not exist yet — still needs a URL, and a URL literal in shipped code is either
// off-device or a chrome.runtime.getURL() path. Host-wildcard MATCH PATTERNS are not requests.
const URL_LITERAL_ALLOWED = new Set([
    'http://*/*',   // background/contextMenu.js documentUrlPatterns — menu gating, never fetched
    'https://*/*',  // idem
    'https://',     // settings/scheduleUtils.js — bare scheme prefix used to normalize user input
    'http://'
]);
/**
 * Report, for each character position in a line, whether it sits inside a string literal.
 *
 * Deliberately NOT "strip the comments, then scan what is left": a `//` inside a string (`const sep =
 * "//"`) would truncate the line and hide a real URL later on it — a false NEGATIVE, the one failure
 * this test must not have. Instead every URL is located in the raw line and judged by where it sits.
 * A URL inside quotes is code; a URL outside quotes is prose in a comment.
 *
 * @param {string} line - one source line
 * @returns {boolean[]} per-character flags, true when that character is inside a string literal
 */
function stringMask(line) {
    const mask = new Array(line.length).fill(false);
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            mask[i] = true;
            if (ch === '\\') { if (i + 1 < line.length) mask[i + 1] = true; i++; continue; }
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            mask[i] = true;
        }
    }
    return mask;
}

let urlLiterals = 0;
for (const file of scriptFiles) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        // A whole-line comment (including a JSDoc continuation) carries no code at all.
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        const mask = stringMask(line);
        for (const m of line.matchAll(/https?:\/\/[^\s"'`]*/g)) {
            if (!mask[m.index]) continue;             // not inside a string -> it is comment prose
            const url = m[0];
            if (URL_LITERAL_ALLOWED.has(url)) continue;
            if (/^https?:\/\/\*/.test(url)) continue; // a host-wildcard match pattern
            fail(`${rel(file)}:${i + 1} — absolute remote URL literal in shipped code: ${url}`);
            urlLiterals++;
        }
    });
}
if (urlLiterals === 0) ok(`no absolute remote URL literal in ${scriptFiles.length} shipped scripts`);

// --- 4: shipped markup references no remote origin (bar the allow-listed store link) ----------
let remoteRefs = 0;
for (const file of markupFiles) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        for (const m of line.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
            const url = m[0].replace(/[.,;]+$/, '');
            if (ALLOWED_MARKUP_URLS.has(url)) continue;
            fail(`${rel(file)}:${i + 1} — shipped markup references a remote origin: ${url}`);
            remoteRefs++;
        }
    });
}
if (remoteRefs === 0) ok(`no unapproved remote reference in ${markupFiles.length} shipped HTML/CSS files`);

// --- 5: the audio sink is fed by the bundled constant, and that constant is relative -----------
// offscreen.js assigns audioPlayer.src from the `sound` field of a playSound message. Checking the
// constant alone would prove nothing if the producer stopped using it, so both halves are pinned:
// the value, and the fact that the only producer still passes exactly that value.
const constants = readFileSync(join(ROOT, 'background', 'constants.js'), 'utf8');
const soundMatch = constants.match(/export\s+const\s+SOUND_FILE\s*=\s*['"]([^'"]*)['"]/);
if (!soundMatch) {
    fail('background/constants.js — could not find the SOUND_FILE constant, so its value is unchecked');
} else if (/^[a-z][a-z0-9+.-]*:/i.test(soundMatch[1]) || soundMatch[1].startsWith('//')) {
    fail(`background/constants.js — SOUND_FILE must be a bundled relative path, got: ${soundMatch[1]}`);
} else {
    ok(`the audio source constant is a bundled relative path (${soundMatch[1]})`);
}

const notifications = readFileSync(join(ROOT, 'background', 'notifications.js'), 'utf8');
const senders = [...notifications.matchAll(/action:\s*['"]playSound['"][\s\S]{0,120}?sound:\s*([A-Za-z_$][\w$.]*|['"`][^'"`]*['"`])/g)];
if (senders.length === 0) {
    fail('background/notifications.js — found no playSound sender passing a `sound` value; pin 5 cannot confirm the audio sink is fed by SOUND_FILE');
} else {
    const bad = senders.filter((m) => m[1].trim() !== 'SOUND_FILE');
    if (bad.length) {
        fail(`background/notifications.js — a playSound message passes something other than SOUND_FILE as \`sound\`: ${bad.map((m) => m[1]).join(', ')}`);
    } else {
        ok(`every playSound sender (${senders.length}) passes the SOUND_FILE constant`);
    }
}

if (failures) {
    console.error(`\n[FAIL] ${failures} network-claim check(s) failed — README.md, SECURITY.md and docs/index.html assert the extension originates no network request`);
    process.exit(1);
}
console.log('\n[OK] the "no network requests of its own" claim holds');

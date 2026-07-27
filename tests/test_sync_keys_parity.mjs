/**
 * Guard test: the storage-partition key lists must stay identical across their two copies.
 *
 * background/settings.js and settings/settings.global.js each hold a private copy of SYNC_KEYS and
 * LOCAL_KEYS (the trees are deliberately separate, so the duplication is by design). Divergence is
 * not a cosmetic drift — settings/settings.global.js saves with
 *   chrome.storage.sync.set({ globalSettings: pickKeys(globalSettings, SYNC_KEYS) })
 * which is a WHOLE-OBJECT overwrite. A key present in the background's SYNC_KEYS but missing from
 * the settings page's copy is therefore silently DROPPED from sync storage the moment the user
 * touches any control on the options page. That is real data loss on a path a checkbox triggers.
 *
 * Both arrays are module-private `const`s and are not exported, so they are extracted from source
 * text rather than imported. Importing settings.global.js is impossible here anyway: it touches
 * document/chrome at module scope.
 *
 * Pins:
 *  1. Both files declare SYNC_KEYS and LOCAL_KEYS as string-literal arrays.
 *  2. SYNC_KEYS is identical between the two copies, IN ORDER.
 *  3. LOCAL_KEYS is identical between the two copies, IN ORDER.
 *  4. Neither list contains duplicates, and the two lists are disjoint (no key routed to both stores).
 *  5. Every key seeded by makeDefaultGlobalSettings() belongs to SYNC_KEYS or LOCAL_KEYS — a default
 *     in neither is written to memory but never persisted anywhere.
 *
 * Run: node tests/test_sync_keys_parity.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND = join(ROOT, 'background', 'settings.js');
const SETTINGS = join(ROOT, 'settings', 'settings.global.js');

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };

/**
 * Extract a module-private `const <name> = ['a', 'b'];` string-array literal from source text.
 * @param {string} source - Full file contents.
 * @param {string} label - Human-readable file label used in failure messages.
 * @param {string} name - The const identifier to find.
 * @returns {string[]|null} The array entries, or null when the declaration is absent/malformed.
 */
function extractStringArray(source, label, name) {
    const match = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
    if (!match) {
        fail(`${label}: could not find a "const ${name} = [...]" declaration`);
        return null;
    }
    const body = match[1].trim();
    if (!body) return [];
    const entries = [];
    for (const raw of body.split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const quoted = /^'([^']*)'$|^"([^"]*)"$/.exec(item);
        if (!quoted) {
            fail(`${label}: ${name} contains a non-string-literal entry (${item})`);
            return null;
        }
        entries.push(quoted[1] !== undefined ? quoted[1] : quoted[2]);
    }
    return entries;
}

/**
 * Extract the property names seeded by makeDefaultGlobalSettings() in background/settings.js.
 * @param {string} source - Full file contents.
 * @returns {string[]|null} The default keys, or null when the function shape is unrecognized.
 */
function extractDefaultKeys(source) {
    const match = /function\s+makeDefaultGlobalSettings\s*\(\)\s*\{\s*return\s*\{([\s\S]*?)\n\s*\};/.exec(source);
    if (!match) {
        fail('background/settings.js: could not find makeDefaultGlobalSettings() { return { ... }; }');
        return null;
    }
    const keys = [];
    for (const line of match[1].split('\n')) {
        const prop = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
        if (prop) keys.push(prop[1]);
    }
    return keys;
}

const backgroundSource = readFileSync(BACKGROUND, 'utf8');
const settingsSource = readFileSync(SETTINGS, 'utf8');

// --- 1: both files declare both lists -------------------------------------
const backgroundSync = extractStringArray(backgroundSource, 'background/settings.js', 'SYNC_KEYS');
const settingsSync = extractStringArray(settingsSource, 'settings/settings.global.js', 'SYNC_KEYS');
const backgroundLocal = extractStringArray(backgroundSource, 'background/settings.js', 'LOCAL_KEYS');
const settingsLocal = extractStringArray(settingsSource, 'settings/settings.global.js', 'LOCAL_KEYS');

if (backgroundSync && settingsSync && backgroundLocal && settingsLocal) {
    ok('both files declare SYNC_KEYS and LOCAL_KEYS as string-literal arrays');

    // --- 2 + 3: identical, in order ---------------------------------------
    const sameOrder = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

    if (sameOrder(backgroundSync, settingsSync)) {
        ok(`SYNC_KEYS identical in both copies (${backgroundSync.length} keys)`);
    } else {
        const onlyBackground = backgroundSync.filter(k => !settingsSync.includes(k));
        const onlySettings = settingsSync.filter(k => !backgroundSync.includes(k));
        fail('SYNC_KEYS diverged between background/settings.js and settings/settings.global.js');
        if (onlyBackground.length) fail(`  keys the options page would DROP from sync storage on save: [${onlyBackground.join(', ')}]`);
        if (onlySettings.length) fail(`  keys the background would ignore: [${onlySettings.join(', ')}]`);
        if (!onlyBackground.length && !onlySettings.length) fail(`  same members, different ORDER: [${backgroundSync.join(', ')}] vs [${settingsSync.join(', ')}]`);
    }

    if (sameOrder(backgroundLocal, settingsLocal)) {
        ok(`LOCAL_KEYS identical in both copies (${backgroundLocal.length} keys)`);
    } else {
        fail(`LOCAL_KEYS diverged: [${backgroundLocal.join(', ')}] vs [${settingsLocal.join(', ')}]`);
    }

    // --- 4: no duplicates, and the two stores are disjoint -----------------
    for (const [label, list] of [['SYNC_KEYS', backgroundSync], ['LOCAL_KEYS', backgroundLocal]]) {
        const dupes = list.filter((k, i) => list.indexOf(k) !== i);
        if (dupes.length) fail(`${label} contains duplicate entries: [${[...new Set(dupes)].join(', ')}]`);
    }
    const overlap = backgroundSync.filter(k => backgroundLocal.includes(k));
    if (overlap.length) {
        fail(`keys routed to BOTH sync and local storage: [${overlap.join(', ')}]`);
    } else {
        ok('SYNC_KEYS and LOCAL_KEYS are disjoint');
    }

    // --- 5: every seeded default is persisted somewhere --------------------
    const defaultKeys = extractDefaultKeys(backgroundSource);
    if (defaultKeys) {
        const partitioned = new Set([...backgroundSync, ...backgroundLocal]);
        const homeless = defaultKeys.filter(k => !partitioned.has(k));
        if (homeless.length) {
            fail(`makeDefaultGlobalSettings() seeds keys that belong to neither store (never persisted): [${homeless.join(', ')}]`);
        } else {
            ok(`all ${defaultKeys.length} seeded defaults belong to SYNC_KEYS or LOCAL_KEYS`);
        }
    }
}

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all checks passed`);
process.exit(failures ? 1 : 0);

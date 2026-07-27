/**
 * Regression for the v2.6.0 QoL-pack i18n keys across all 27 locales.
 *
 * Pins, for every NEW key the pack added:
 *  1. All 27 expected locales present, each with the exact same KEY SET as en (parity).
 *  2. Every new key exists in en (guards a mistyped key name in the app that would render raw).
 *  3. Each locale carries the key with a `message` + English `description`.
 *  4. {token} parity per key: each locale's placeholder multiset equals en's, and substitutes cleanly.
 *  5. Integrity heuristics: no arrow-join (malformed translation), no gross length outlier, description
 *     stays English. A non-en message byte-identical to en fails ONLY for longer strings — short
 *     abbreviations ("Min, s", "Max, s", "Error") are legitimately identical across many languages.
 *
 * Run: node tests/test_i18n_qol_pack.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, '_locales');
const EXPECTED_LOCALES = ['en','ar','bg','cs','da','de','el','es','et','fa','fi','fr','hi','it','ja','ko','lt','no','pl','pt_PT','ro','ru','sk','sv','tr','uk','zh_CN'];

// The keys the pack introduced: keyboard shortcuts, bulk window actions, tab groups, interval range.
const NEW_KEYS = [
    'command_toggle_refresh', 'command_toggle_pause',
    'bulk_heading', 'bulk_start_window', 'bulk_stop_window', 'bulk_result', 'bulk_result_stop',
    'bulk_skipped', 'bulk_failed', 'bulk_capped', 'bulk_none_eligible', 'bulk_error', 'command_bulk_window',
    'bulk_group_button', 'bulk_group_none', 'command_bulk_group',
    'interval_range', 'interval_range_min', 'interval_range_max', 'interval_range_invalid', 'set_range',
    'shortcuts_heading', 'shortcuts_customize', 'shortcuts_not_set', 'shortcuts_hint'
];

// locale:key pairs whose translation is LEGITIMATELY byte-identical to en (a real word spelled the same).
const LEGIT_EN_IDENTICAL = new Set(['bulk_error:es']);
const PLACEHOLDER = /\{[a-z_]+\}/g;
const ARROW = new RegExp('->|\\u2192');

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };
const load = (d) => JSON.parse(readFileSync(join(LOCALES, d, 'messages.json'), 'utf8'));

// 1: locale set + parity
const dirs = readdirSync(LOCALES, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
if (dirs.length === EXPECTED_LOCALES.length && EXPECTED_LOCALES.slice().sort().every((l, i) => l === dirs[i])) ok('27 locales present and match the expected set');
else fail(`locale set mismatch: got [${dirs.join(',')}]`);

const en = load('en');
const enKeys = Object.keys(en).sort().join('\n');

// 2: every new key exists in en
for (const k of NEW_KEYS) {
    if (!en[k] || typeof en[k].message !== 'string') fail(`en is missing new key "${k}"`);
}
const tokensOf = (s) => (s.match(PLACEHOLDER) || []).slice().sort().join(',');

for (const d of dirs) {
    const obj = load(d);
    if (Object.keys(obj).sort().join('\n') !== enKeys) fail(`${d}: key set differs from en (parity broken)`);
    for (const key of NEW_KEYS) {
        const entry = obj[key];
        const enEntry = en[key];
        if (!enEntry) continue; // already reported above
        if (!entry || typeof entry.message !== 'string' || typeof entry.description !== 'string') { fail(`${d}: ${key} missing message/description`); continue; }
        const msg = entry.message, enMsg = enEntry.message;

        // 4: token parity + clean substitution
        if (tokensOf(msg) !== tokensOf(enMsg)) { fail(`${d}: ${key} token set [${tokensOf(msg)}] != en [${tokensOf(enMsg)}]`); }
        let rendered = msg;
        for (const tok of (enMsg.match(PLACEHOLDER) || [])) rendered = rendered.replace(tok, '42');
        if (PLACEHOLDER.test(rendered)) fail(`${d}: ${key} has a placeholder left after substitution: "${rendered}"`);

        // 5: integrity
        if (entry.description !== enEntry.description) fail(`${d}: ${key} description is not the English source`);
        if (ARROW.test(msg)) fail(`${d}: ${key} contains an arrow-join (malformed translation?)`);
        if (d !== 'en' && msg === enMsg && !LEGIT_EN_IDENTICAL.has(`${key}:${d}`)) {
            if (enMsg.length <= 8) console.log(`[WARN] ${d}: ${key} equals en ("${msg}") — short string, assumed legit`);
            else fail(`${d}: ${key} is byte-identical to en (untranslated)`);
        }
        const ratio = msg.length / enMsg.length;
        if (ratio < 0.2 || ratio > 4.0) fail(`${d}: ${key} length ratio ${ratio.toFixed(2)} is a gross outlier vs en`);
    }
}
if (!failures) ok(`all ${dirs.length} locales carry the ${NEW_KEYS.length} new keys with parity, token integrity, and clean substitution`);

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all i18n QoL-pack checks passed`);
process.exit(failures ? 1 : 0);

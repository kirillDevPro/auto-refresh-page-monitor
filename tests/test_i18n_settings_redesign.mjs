/**
 * Regression for the v2.7.0 settings-redesign i18n change.
 *
 * The redesign merged the "URL Rules" tab into the "Scheduled Refreshes" tab, renaming the merged
 * nav tab to a NEW key `refreshes_and_rules` and DECOMMISSIONING the two now-orphaned nav-label keys
 * `url_rules` and `scheduled_refreshes` (the h2 key `scheduled_refreshes_title` is unrelated and stays).
 *
 * This test pins BOTH directions so neither drifts back:
 *  1. `refreshes_and_rules` exists in all 27 locales with key-set parity, a `message` + English
 *     `description`, and passes the integrity heuristics (no arrow-join leakage, no gross length
 *     outlier, non-en not byte-identical to en unless it is a legitimately short string).
 *  2. `url_rules` and `scheduled_refreshes` are ABSENT from every locale (decommission complete) —
 *     while `scheduled_refreshes_title` (still referenced by settings.html) remains present.
 *
 * Run: node tests/test_i18n_settings_redesign.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, '_locales');
const EXPECTED_LOCALES = ['en','ar','bg','cs','da','de','el','es','et','fa','fi','fr','hi','it','ja','ko','lt','no','pl','pt_PT','ro','ru','sk','sv','tr','uk','zh_CN'];

const ADDED_KEY = 'refreshes_and_rules';
const REMOVED_KEYS = ['url_rules', 'scheduled_refreshes'];
const KEPT_KEY = 'scheduled_refreshes_title'; // must survive — settings.html still uses it

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

// 2: added key present in en; removed keys gone from en; kept key survives
if (!en[ADDED_KEY] || typeof en[ADDED_KEY].message !== 'string') fail(`en is missing new key "${ADDED_KEY}"`);
for (const k of REMOVED_KEYS) if (en[k]) fail(`en still contains decommissioned key "${k}"`);
if (!en[KEPT_KEY]) fail(`en lost the still-referenced key "${KEPT_KEY}"`);

for (const d of dirs) {
    const obj = load(d);

    // parity: every locale carries the exact en key set (so the add/remove stayed in sync)
    if (Object.keys(obj).sort().join('\n') !== enKeys) fail(`${d}: key set differs from en (parity broken)`);

    // decommission pinned in every locale
    for (const k of REMOVED_KEYS) if (k in obj) fail(`${d}: decommissioned key "${k}" still present`);
    if (!(KEPT_KEY in obj)) fail(`${d}: kept key "${KEPT_KEY}" is missing`);

    // added key integrity
    const entry = obj[ADDED_KEY];
    const enMsg = en[ADDED_KEY] ? en[ADDED_KEY].message : null;
    if (!entry || typeof entry.message !== 'string' || typeof entry.description !== 'string') { fail(`${d}: ${ADDED_KEY} missing message/description`); continue; }
    if (entry.description !== en[ADDED_KEY].description) fail(`${d}: ${ADDED_KEY} description is not the English source`);
    if (ARROW.test(entry.message)) fail(`${d}: ${ADDED_KEY} contains an arrow-join (malformed translation?)`);
    if (enMsg && d !== 'en' && entry.message === enMsg && enMsg.length > 8) fail(`${d}: ${ADDED_KEY} is byte-identical to en (untranslated)`);
    if (enMsg) {
        const ratio = entry.message.length / enMsg.length;
        if (ratio < 0.2 || ratio > 4.0) fail(`${d}: ${ADDED_KEY} length ratio ${ratio.toFixed(2)} is a gross outlier vs en`);
    }
}
if (!failures) ok(`all ${dirs.length} locales: +${ADDED_KEY} with parity/integrity, -[${REMOVED_KEYS.join(', ')}] decommissioned, ${KEPT_KEY} retained`);

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all settings-redesign i18n checks passed`);
process.exit(failures ? 1 : 0);

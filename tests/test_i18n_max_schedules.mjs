/**
 * Regression test for the scheduled-rule limit raise (100 -> 300) and the
 * parameterization of the "max schedules reached" message across all locales.
 *
 * Pins:
 *  1. Every one of the 27 locales carries `max_schedules_reached` with the {max}
 *     token and NO leftover hard-coded "100".
 *  2. Substituting the token (as the runtime does: t(key).replace('{max}', MAX))
 *     yields the limit and leaves no stray placeholder.
 *  3. The source of truth (MAX_SCHEDULES, the counter denominator, the enforcement
 *     guard) is consistent and free of a stray literal 100 cap.
 *  4. The counter warning/danger thresholds scale with the limit (75% / 90%).
 *
 * Run: node tests/test_i18n_max_schedules.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, '_locales');
const EXPECTED_LOCALES = ['en','ar','bg','cs','da','de','el','es','et','fa','fi','fr','hi','it','ja','ko','lt','no','pl','pt_PT','ro','ru','sk','sv','tr','uk','zh_CN'];
const KEY = 'max_schedules_reached';
const EXPECTED_MAX = 300;

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };

// --- 1 + 2: locale parameterization ---------------------------------------
const dirs = readdirSync(LOCALES, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
if (dirs.length === EXPECTED_LOCALES.length && EXPECTED_LOCALES.slice().sort().every((l, i) => l === dirs[i])) {
    ok(`27 locales present and match the expected set`);
} else {
    fail(`locale set mismatch: got [${dirs.join(',')}]`);
}

for (const d of dirs) {
    const msg = JSON.parse(readFileSync(join(LOCALES, d, 'messages.json'), 'utf8'))[KEY]?.message;
    if (typeof msg !== 'string') { fail(`${d}: ${KEY} missing`); continue; }
    if (!msg.includes('{max}')) { fail(`${d}: ${KEY} has no {max} token -> "${msg.slice(0, 50)}..."`); continue; }
    if (/\b100\b/.test(msg)) { fail(`${d}: ${KEY} still contains literal 100`); continue; }
    const rendered = msg.replace('{max}', String(EXPECTED_MAX));
    if (rendered.includes('{max}')) { fail(`${d}: token survived substitution`); continue; }
    if (!rendered.includes(String(EXPECTED_MAX))) { fail(`${d}: rendered text lacks ${EXPECTED_MAX}`); continue; }
}
if (!failures) ok(`all ${dirs.length} locales parameterized with {max}, substitute to ${EXPECTED_MAX} cleanly`);

// --- 3: source-of-truth consistency ---------------------------------------
const schedSrc = readFileSync(join(ROOT, 'settings', 'settings.scheduledRefreshes.js'), 'utf8');
const settingsSrc = readFileSync(join(ROOT, 'settings', 'settings.js'), 'utf8');
const htmlSrc = readFileSync(join(ROOT, 'settings', 'settings.html'), 'utf8');

const maxMatch = schedSrc.match(/export const MAX_SCHEDULES\s*=\s*(\d+)/);
if (maxMatch && Number(maxMatch[1]) === EXPECTED_MAX) ok(`MAX_SCHEDULES === ${EXPECTED_MAX}`);
else fail(`MAX_SCHEDULES not ${EXPECTED_MAX} (got ${maxMatch ? maxMatch[1] : 'none'})`);

if (/list\.length\s*>=\s*MAX_SCHEDULES/.test(schedSrc)) ok('limit guard uses MAX_SCHEDULES');
else fail('limit guard does not reference MAX_SCHEDULES');

if (/\.replace\(\s*['"]\{max\}['"]\s*,\s*MAX_SCHEDULES\s*\)/.test(schedSrc)) ok('limit message substitutes {max} with MAX_SCHEDULES');
else fail('limit message does not substitute {max}');

if (/const maxCount\s*=\s*MAX_SCHEDULES/.test(settingsSrc)) ok('counter denominator uses MAX_SCHEDULES');
else fail('counter denominator does not use MAX_SCHEDULES');

if (/>=\s*maxCount\s*\*\s*0\.9/.test(settingsSrc) && />=\s*maxCount\s*\*\s*0\.75/.test(settingsSrc)) ok('counter thresholds scale with the limit (90% / 75%)');
else fail('counter thresholds are not proportional to the limit');

// no stray hard-coded 100-cap denominator left in HTML/JS
if (/\(0\/100\)/.test(htmlSrc) || /\(0\/100\)/.test(settingsSrc)) fail('a "(0/100)" denominator is still hard-coded');
else ok('no hard-coded "(0/100)" denominator remains');

// --- 4: threshold boundaries (mirror of settings.js formula) --------------
const cls = (c, max) => (c >= max * 0.9 ? 'danger' : c >= max * 0.75 ? 'warning' : 'none');
const cases = [[224, 'none'], [225, 'warning'], [269, 'warning'], [270, 'danger'], [300, 'danger']];
let tOk = true;
for (const [c, want] of cases) if (cls(c, EXPECTED_MAX) !== want) { fail(`threshold(${c}) => ${cls(c, EXPECTED_MAX)}, want ${want}`); tOk = false; }
if (tOk) ok('threshold boundaries correct at 225 (warning) and 270 (danger)');

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all checks passed`);
process.exit(failures ? 1 : 0);

/**
 * Regression test for the new `overlapping_schedule_url` message across all 27 locales.
 *
 * Pins:
 *  1. All 27 expected locales are present and each has the exact same KEY SET as en (parity).
 *  2. Every locale carries `overlapping_schedule_url` with a `message` + English `description`.
 *  3. The message holds EXACTLY ONE `{url}` token that substitutes cleanly (as the runtime does:
 *     t(key).replace('{url}', rawUrl)) leaving no residual placeholder.
 *  4. Translation-integrity heuristics: no ASCII/unicode arrow-join, no non-en message byte-identical
 *     to en (untranslated), no gross length outlier vs en, description stays English (== en's).
 *
 * Run: node tests/test_i18n_overlap_schedule.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = join(ROOT, '_locales');
const EXPECTED_LOCALES = ['en','ar','bg','cs','da','de','el','es','et','fa','fi','fr','hi','it','ja','ko','lt','no','pl','pt_PT','ro','ru','sk','sv','tr','uk','zh_CN'];
const KEY = 'overlapping_schedule_url';
const SAMPLE_URL = 'https://example.com/page';

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };

const load = (d) => JSON.parse(readFileSync(join(LOCALES, d, 'messages.json'), 'utf8'));

// --- 1: locale set + full key-set parity vs en ----------------------------
const dirs = readdirSync(LOCALES, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
if (dirs.length === EXPECTED_LOCALES.length && EXPECTED_LOCALES.slice().sort().every((l, i) => l === dirs[i])) {
    ok('27 locales present and match the expected set');
} else {
    fail(`locale set mismatch: got [${dirs.join(',')}]`);
}

const en = load('en');
const enKeys = Object.keys(en).sort().join('\n');
const enMessage = en[KEY]?.message;
const enDescription = en[KEY]?.description;
if (typeof enMessage !== 'string' || typeof enDescription !== 'string') fail('en is missing the overlapping_schedule_url key');

for (const d of dirs) {
    const obj = load(d);
    if (Object.keys(obj).sort().join('\n') !== enKeys) fail(`${d}: key set differs from en (parity broken)`);
    const entry = obj[KEY];
    if (!entry || typeof entry.message !== 'string' || typeof entry.description !== 'string') { fail(`${d}: ${KEY} missing message/description`); continue; }
    const msg = entry.message;

    // 3: exactly one {url} token, substitutes cleanly
    const tokens = (msg.match(/\{url\}/g) || []).length;
    if (tokens !== 1) { fail(`${d}: expected exactly one {url} token, found ${tokens}`); continue; }
    const rendered = msg.replace('{url}', SAMPLE_URL);
    if (rendered.includes('{url}')) { fail(`${d}: {url} survived substitution`); continue; }
    if (!rendered.includes(SAMPLE_URL)) { fail(`${d}: rendered text lacks the substituted url`); continue; }

    // 4: integrity heuristics
    if (/->/.test(msg) || msg.includes(String.fromCharCode(0x2192))) fail(`${d}: message contains an arrow-join (malformed translation?)`);
    if (d !== 'en' && msg === enMessage) fail(`${d}: message is byte-identical to en (untranslated)`);
    if (entry.description !== enDescription) fail(`${d}: description is not the English source string`);
    // length band vs en (generous: CJK run short, some latin locales run long)
    const ratio = msg.length / enMessage.length;
    if (ratio < 0.2 || ratio > 4.0) fail(`${d}: message length ratio ${ratio.toFixed(2)} is a gross outlier vs en`);
}
if (!failures) ok(`all ${dirs.length} locales carry ${KEY} with a single {url} token, clean substitution, and pass integrity heuristics`);

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all checks passed`);
process.exit(failures ? 1 : 0);

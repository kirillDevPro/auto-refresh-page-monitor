/**
 * Guard test: the manifest's permission surface must not drift.
 *
 * Why this is not paranoia. Chrome shows an install-time warning for some permissions, and an update
 * that ADDS a warning-bearing permission DISABLES the extension for every existing user until they
 * manually re-approve it. This extension is published and deliberately ships with ZERO host
 * permissions (chrome.tabs.reload() needs none) — the popup and the store listing both advertise
 * that. A single well-meaning "just add tabGroups" would silently cost the entire install base.
 *
 * Known warning-bearing permissions relevant here (developer.chrome.com/docs/extensions/reference/
 * permissions-list): "tabs" -> "Read your browsing history" (already accepted at v2.5.0),
 * "tabGroups" -> "View and manage your tab groups" (NEW warning — forbidden).
 * "scripting" is warning-free on its own; host_permissions are what carry the scary prompt.
 *
 * The baselines below are v2.5.0's, the last published state. Changing them is a deliberate product
 * decision with a re-approval cost — never an incidental edit. If you are here because this test
 * failed, that is the test working.
 *
 * Pins:
 *  1. manifest_version stays 3.
 *  2. `permissions` matches the v2.5.0 baseline exactly (no additions, no removals).
 *  3. `optional_permissions` matches the v2.5.0 baseline exactly.
 *  4. No `host_permissions` and no `optional_host_permissions` key exists at all.
 *  5. No `content_scripts` key exists (it implies host access).
 *  6. "tabGroups" appears in neither permission list.
 *  7. No "<all_urls>" / wildcard match pattern anywhere in the manifest.
 *
 * Run: node tests/test_permission_drift.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// v2.5.0 baseline — the last state the Web Store review and the install base accepted.
const BASELINE_PERMISSIONS = ['storage', 'tabs', 'alarms', 'offscreen', 'unlimitedStorage', 'idle', 'contextMenus'];
const BASELINE_OPTIONAL_PERMISSIONS = ['webNavigation'];
const FORBIDDEN_PERMISSIONS = ['tabGroups'];

let failures = 0;
const ok = (m) => console.log(`[OK] ${m}`);
const fail = (m) => { console.log(`[FAIL] ${m}`); failures++; };

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

/**
 * Compare an actual permission array against a baseline, reporting additions and removals apart.
 * @param {string[]|undefined} actual - The manifest's array.
 * @param {string[]} baseline - The v2.5.0 expected array.
 * @param {string} label - The manifest key name, for messages.
 * @returns {void}
 */
function comparePermissions(actual, baseline, label) {
    if (!Array.isArray(actual)) {
        fail(`${label} is missing or not an array`);
        return;
    }
    const added = actual.filter(p => !baseline.includes(p));
    const removed = baseline.filter(p => !actual.includes(p));
    if (!added.length && !removed.length) {
        ok(`${label} matches the v2.5.0 baseline (${actual.length} entries)`);
        return;
    }
    if (added.length) fail(`${label} ADDED since v2.5.0: [${added.join(', ')}] — an added warning-bearing permission disables the extension for existing users until they re-approve`);
    if (removed.length) fail(`${label} REMOVED since v2.5.0: [${removed.join(', ')}] — code still relying on it will fail at runtime`);
}

// --- 1: manifest version ---------------------------------------------------
if (manifest.manifest_version === 3) ok('manifest_version is 3');
else fail(`manifest_version is ${manifest.manifest_version}, expected 3`);

// --- 2 + 3: the permission arrays -----------------------------------------
comparePermissions(manifest.permissions, BASELINE_PERMISSIONS, 'permissions');
comparePermissions(manifest.optional_permissions, BASELINE_OPTIONAL_PERMISSIONS, 'optional_permissions');

// --- 4: zero host permissions, the extension's advertised property ---------
for (const key of ['host_permissions', 'optional_host_permissions']) {
    if (key in manifest) fail(`${key} is present — this extension advertises zero host permissions; adding any triggers the "read and change all your data" prompt`);
}
if (!('host_permissions' in manifest) && !('optional_host_permissions' in manifest)) {
    ok('no host_permissions and no optional_host_permissions');
}

// --- 5: no content scripts -------------------------------------------------
if ('content_scripts' in manifest) fail('content_scripts is present — it implies host access and its match patterns carry install warnings');
else ok('no content_scripts');

// --- 6: explicitly forbidden permissions ----------------------------------
const allDeclared = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
const forbidden = allDeclared.filter(p => FORBIDDEN_PERMISSIONS.includes(p));
if (forbidden.length) {
    fail(`forbidden permission(s) declared: [${forbidden.join(', ')}] — tabGroups adds the "View and manage your tab groups" warning. Use tab.groupId + chrome.tabs.query({groupId}) under the existing "tabs" permission instead.`);
} else {
    ok(`no forbidden permissions declared (${FORBIDDEN_PERMISSIONS.join(', ')})`);
}

// --- 7: no wildcard match patterns anywhere -------------------------------
const serialized = JSON.stringify(manifest);
for (const pattern of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']) {
    if (serialized.includes(pattern)) fail(`manifest contains the wildcard match pattern "${pattern}"`);
}
if (!/<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*/.test(serialized)) ok('no wildcard match patterns in the manifest');

console.log(failures ? `\n[FAIL] ${failures} check(s) failed` : `\n[OK] all checks passed`);
process.exit(failures ? 1 : 0);

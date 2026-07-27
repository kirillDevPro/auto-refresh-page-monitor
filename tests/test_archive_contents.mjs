/**
 * Pins the PACKAGING CONTRACT: what `git archive HEAD` puts inside the Chrome Web Store zip, and
 * what is tracked in the repository at all.
 *
 * Why a test and not a comment in .gitattributes: export-ignore is a DENY-list. Every future tracked
 * development file ships inside the uploaded package unless someone remembers to add a rule, and
 * nothing would notice — the zip is built by hand at release time. This inverts it into an ALLOW-list
 * checked on every CI run, the way tests/test_permission_drift.mjs pins the manifest permissions.
 *
 * Pins:
 *  1. The archive's top-level entry set is EXACTLY the shippable set plus LICENSE (deliberately not
 *     export-ignored, so the licence travels with any distributed copy).
 *  2. No development tree (tests/, .github/, docs/, assets/) reaches the archive — not as files and
 *     not as an empty directory entry. Only the bare `dir/` export-ignore form achieves the latter;
 *     `dir/**` excludes the contained files but leaves the directory entry behind.
 *  3. Every TRACKED top-level path is either shippable or a known development file, so an unexpected
 *     tracked file — a scratch note, an editor or tooling config, an accidental export — fails here
 *     instead of being published.
 *
 * Breakage this catches: a new tracked top-level dev file is added with no export-ignore rule for it.
 * Pin 1 then sees an extra top-level entry in the archive and fails, naming the file. (Shown to fail
 * that way by committing a stray CONTRIBUTING.md in a scratch clone.) Pin 3 catches the same mistake
 * one step earlier, at the point the file becomes tracked.
 *
 * Run: node tests/test_archive_contents.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
/**
 * Record and print a failed packaging-contract check.
 * @param {string} msg - Failure description.
 * @returns {void}
 */
const fail = (msg) => { console.error(`[x] ${msg}`); failures++; };
/**
 * Print a successful packaging-contract check.
 * @param {string} msg - Success description.
 * @returns {void}
 */
const ok = (msg) => console.log(`[+] ${msg}`);

/**
 * Run Git from the repository root.
 * @param {string[]} args - Git command arguments.
 * @param {import('node:child_process').ExecFileSyncOptions} [opts] - Synchronous process options.
 * @returns {Buffer|string} Captured command output, decoded when opts specifies an encoding.
 * @throws {Error} If Git cannot start or exits unsuccessfully.
 */
const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, ...opts });
/**
 * Run Git from the repository root and decode its output as UTF-8 text.
 * @param {string[]} args - Git command arguments.
 * @returns {string} Captured UTF-8 command output.
 * @throws {Error} If Git cannot start or exits unsuccessfully.
 */
const gitText = (args) => git(args, { encoding: 'utf8' });

/** Everything that legitimately ships inside the extension package. */
const SHIPPABLE = [
    '_locales', 'background', 'icons', 'popup', 'settings', 'shared', 'sounds',
    'manifest.json', 'offscreen.html', 'offscreen.js'
];
/** Ships as well, but is not extension code — listed apart so the reason stays visible. */
const ARCHIVE_TOP_LEVEL = [...SHIPPABLE, 'LICENSE'].sort();
/** Tracked development files that must NOT ship. */
const DEV_ONLY = [
    '.gitattributes', '.gitignore', '.github', 'assets', 'docs', 'tests',
    'README.md', 'SECURITY.md', 'CHANGELOG.md'
];
const DEV_TREES = ['tests', '.github', 'docs', 'assets'];

/**
 * List the paths inside a tar stream by walking its 512-byte header records.
 * Node ships no tar parser, and `git archive | tar -t` is not portable to a bare Windows checkout.
 * `pax_global_header` is skipped: git prepends it to carry the commit id as archive metadata, and it
 * is not a member of the extracted tree.
 * @param {Buffer} tar - the tar archive bytes
 * @returns {string[]} every entry name, directory entries included (they end in '/')
 */
function tarEntries(tar) {
    const names = [];
    for (let off = 0; off + 512 <= tar.length; ) {
        const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
        if (!name) { off += 512; continue; }
        const size = parseInt(tar.toString('ascii', off + 124, off + 136).replace(/\0.*$/s, '').trim(), 8) || 0;
        if (name !== 'pax_global_header') names.push(name);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
}

const entries = tarEntries(git(['archive', '--format=tar', 'HEAD']));
if (entries.length === 0) fail('git archive HEAD produced no entries');

// --- 1: the archive's top-level set is exactly the shippable set + LICENSE ------------------
const topLevel = [...new Set(entries.map((e) => e.replace(/\/.*$/, '')))].sort();
const unexpected = topLevel.filter((e) => !ARCHIVE_TOP_LEVEL.includes(e));
const missing = ARCHIVE_TOP_LEVEL.filter((e) => !topLevel.includes(e));
if (unexpected.length) {
    fail(`archive has unexpected top-level entries: ${unexpected.join(', ')} — add an export-ignore rule in .gitattributes`);
}
if (missing.length) fail(`archive is MISSING shippable entries: ${missing.join(', ')}`);
if (!unexpected.length && !missing.length) {
    ok(`archive top-level set is exactly the shippable set (${topLevel.length} entries)`);
}

// --- 2: no development tree in the archive, not even an empty directory entry ---------------
let leaked = false;
for (const tree of DEV_TREES) {
    const hits = entries.filter((e) => e === `${tree}/` || e.startsWith(`${tree}/`));
    if (hits.length) {
        fail(`development tree "${tree}" leaked into the archive (${hits.length} entries, e.g. "${hits[0]}")`);
        leaked = true;
    }
}
if (!leaked) ok('no development tree in the archive, and no empty directory entry left behind');

// --- 3: every tracked top-level path is shippable or a known development file ---------------
const trackedTop = [...new Set(
    gitText(['ls-files']).split('\n').filter(Boolean).map((p) => p.replace(/\/.*$/, ''))
)].sort();
const allowed = new Set([...SHIPPABLE, 'LICENSE', ...DEV_ONLY]);
const strays = trackedTop.filter((p) => !allowed.has(p));
if (strays.length) {
    fail(`unexpected TRACKED top-level path(s): ${strays.join(', ')} — if intentional, add it to SHIPPABLE or DEV_ONLY here, and give it an export-ignore rule when it must not ship`);
} else {
    ok(`every tracked top-level path is accounted for (${trackedTop.length} paths)`);
}

if (failures) {
    console.error(`\n[FAIL] ${failures} packaging-contract check(s) failed`);
    process.exit(1);
}
console.log('\n[OK] packaging contract holds');

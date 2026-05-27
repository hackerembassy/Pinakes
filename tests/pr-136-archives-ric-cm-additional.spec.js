// @ts-check
//
// Complementary regression suite for PR #136 (feat/ric-cm-archives,
// closes #122). The PR already ships ~51 tests across 4 new spec
// files (phase5-admin-ui, phase6-oai-ric-o, ric-jsonld, upload-assets).
// This file targets the modifications those don't cover:
//
//   - Migration file presence + version-≤-release invariant
//     (CLAUDE.md ABSOLUTE RULE #6)
//   - ensureSchema() pattern in ArchivesPlugin and OaiPmhServerPlugin
//     (CLAUDE.md "Plugin Schema Rule — ABSOLUTE")
//   - plugin.json version bumps (archives 1.2.x → 1.5.0,
//     oai-pmh-server 1.0.0 → 1.1.0)
//   - Migration content sanity (new tables/cols mentioned)
//   - Locale key presence for admin UI strings introduced by Phase 5
//
// The tests run against the PR branch's tip via `git show
// origin/feat/ric-cm-archives:<path>`, so they work from any checked-out
// branch — caller doesn't need to switch branches first. When the
// branch is checked out locally, the same checks pass against the
// working tree (so the tests double as a pre-push gate on the PR
// branch).
//
// Run:
//   /tmp/run-e2e.sh tests/pr-136-archives-ric-cm-additional.spec.js \
//     --config=tests/playwright.config.js --workers=1

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PR_BRANCH = 'feat/ric-cm-archives';

// Resolve the source of truth ONCE up front:
//   - If HEAD is on the PR branch  → working tree (so tests double as
//                                    a pre-push gate on the branch).
//   - Else                         → `git show origin/PR_BRANCH:<path>`
//                                    (so the tests work from ANY other
//                                    branch without checking out).
// This avoids the trap of preferring the local working tree when the
// caller is on a different branch — the local files there are NOT the
// ones the PR is shipping.
function getCurrentBranch() {
    try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch { return ''; }
}

const onPrBranch = (getCurrentBranch() === PR_BRANCH);

function readPrFile(relPath) {
    if (onPrBranch) {
        const local = path.join(REPO, relPath);
        if (!fs.existsSync(local)) return null;
        return fs.readFileSync(local, 'utf8');
    }
    // execFileSync (safe — no shell interpolation; args are array).
    try {
        const out = execFileSync('git', ['show', `origin/${PR_BRANCH}:${relPath}`], {
            cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        return out;
    } catch {
        return null;
    }
}

// Returns true if `origin/feat/ric-cm-archives` is reachable locally
// (was fetched at some point). Used to skip cleanly on installs where
// the branch hasn't been fetched yet.
function prBranchReachable() {
    try {
        execFileSync('git', ['rev-parse', '--verify', `origin/${PR_BRANCH}`], {
            cwd: REPO, stdio: 'ignore'
        });
        return true;
    } catch {
        return false;
    }
}

const branchReachable = prBranchReachable();

// ═══════════════════════════════════════════════════════════════════
// PR #136 — RiC-CM full roadmap — additional contract checks
// ═══════════════════════════════════════════════════════════════════
test.describe('[STATIC] PR #136 RiC-CM contract checks', () => {

    test.skip(!branchReachable, `origin/${PR_BRANCH} not fetched — run: git fetch origin ${PR_BRANCH}`);

    // R1 — Migration files for Phases 2/3/4/cleanup are all present
    test('R1: phase-2/3/4 + cleanup migration files exist on the PR branch', async () => {
        const expected = [
            'installer/database/migrations/migrate_0.7.08.sql',
            'installer/database/migrations/migrate_0.7.09.sql',
            'installer/database/migrations/migrate_0.7.10.sql',
            'installer/database/migrations/migrate_0.7.12.sql',
        ];
        for (const f of expected) {
            const c = readPrFile(f);
            expect(c, `${f} must exist`).not.toBeNull();
            expect(c.length).toBeGreaterThan(0);
        }
    });

    // R2 — version.json release matches the highest migration version
    test('R2: version.json release ≥ highest migration file version (CLAUDE.md ABSOLUTE RULE #6)', async () => {
        const versionJson = readPrFile('version.json');
        expect(versionJson).not.toBeNull();
        const version = JSON.parse(versionJson).version;
        // CLAUDE.md: "NEVER name a migration file with a version higher
        // than the release version" — updater uses version_compare()
        // with <= so higher-version migrations are silently skipped.
        // The release ships migrate_0.7.12.sql → version.json must be ≥ 0.7.12.
        // Use semver-like comparison via PHP's version_compare semantics:
        // split by '.', compare segment by segment.
        function cmp(a, b) {
            const aa = a.split('.').map(Number);
            const bb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
                const x = aa[i] || 0, y = bb[i] || 0;
                if (x !== y) return x - y;
            }
            return 0;
        }
        expect(cmp(version, '0.7.12')).toBeGreaterThanOrEqual(0);
    });

    // R3 — migrate_0.7.08.sql creates the agent fields (Phase 2 schema)
    test('R3: migrate_0.7.08.sql adds Phase 2 agent columns/tables', async () => {
        const sql = readPrFile('installer/database/migrations/migrate_0.7.08.sql');
        expect(sql).not.toBeNull();
        // Per PR body: "+4 cols on authority_records, +2 tables".
        expect(sql).toMatch(/authority_records/i);
        // At least one ALTER TABLE adding columns.
        expect(sql).toMatch(/ALTER TABLE/i);
    });

    // R4 — migrate_0.7.09.sql creates Phase 3 activity tables
    test('R4: migrate_0.7.09.sql creates archive_activities + archive_unit_activities tables', async () => {
        const sql = readPrFile('installer/database/migrations/migrate_0.7.09.sql');
        expect(sql).not.toBeNull();
        expect(sql).toMatch(/archive_activities/i);
        expect(sql).toMatch(/archive_unit_activities/i);
        // CREATE TABLE IF NOT EXISTS (idempotent — re-runnable on partial fail).
        expect(sql).toMatch(/CREATE TABLE\s+IF NOT EXISTS/i);
    });

    // R5 — migrate_0.7.10.sql creates Phase 4 places + relations
    test('R5: migrate_0.7.10.sql creates archive_places + archive_relations tables', async () => {
        const sql = readPrFile('installer/database/migrations/migrate_0.7.10.sql');
        expect(sql).not.toBeNull();
        expect(sql).toMatch(/archive_places/i);
        expect(sql).toMatch(/archive_relations/i);
    });

    // R6 — migrate_0.7.12.sql drops the reserved-but-unused place_id col
    test('R6: migrate_0.7.12.sql drops archive_activities.place_id (reserved-but-unused cleanup)', async () => {
        const sql = readPrFile('installer/database/migrations/migrate_0.7.12.sql');
        expect(sql).not.toBeNull();
        expect(sql).toMatch(/ALTER TABLE\s+archive_activities/i);
        expect(sql).toMatch(/DROP\s+COLUMN\s+(?:IF EXISTS\s+)?place_id/i);
    });

    // R7 — ArchivesPlugin implements ensureSchema() called from BOTH
    // onActivate() and onInstall() (CLAUDE.md "Plugin Schema Rule — ABSOLUTE")
    test('R7: ArchivesPlugin.ensureSchema() is called from onActivate() AND onInstall()', async () => {
        const src = readPrFile('storage/plugins/archives/ArchivesPlugin.php');
        expect(src).not.toBeNull();
        // Must declare the helper.
        expect(src).toMatch(/function\s+ensureSchema\s*\(/);
        // Must call it from both lifecycle hooks. Locate each method
        // body and check the helper is invoked inside.
        const activateMatch = src.match(/function\s+onActivate[\s\S]*?\n {4}\}/);
        const installMatch  = src.match(/function\s+onInstall[\s\S]*?\n {4}\}/);
        expect(activateMatch, 'onActivate() must exist').not.toBeNull();
        expect(installMatch,  'onInstall() must exist').not.toBeNull();
        expect(activateMatch[0]).toMatch(/(?:\$this->)?ensureSchema\s*\(/);
        expect(installMatch[0]).toMatch(/(?:\$this->)?ensureSchema\s*\(/);
        // ensureSchema body must use CREATE TABLE IF NOT EXISTS (idempotent).
        expect(src).toMatch(/CREATE TABLE\s+IF NOT EXISTS/i);
    });

    // R8 — OaiPmhServerPlugin also follows the ensureSchema pattern
    test('R8: OaiPmhServerPlugin follows ensureSchema() pattern (called from both hooks)', async () => {
        const src = readPrFile('storage/plugins/oai-pmh-server/OaiPmhServerPlugin.php');
        expect(src).not.toBeNull();
        // The OAI-PMH plugin tracks ric-o prefix subscriptions in a
        // table — ensureSchema covers it. If the plugin doesn't create
        // tables, the helper may be absent — accept that case.
        const hasEnsureSchema = /function\s+ensureSchema\s*\(/.test(src);
        if (!hasEnsureSchema) {
            // No tables = no need for the helper. Sanity-check that
            // no CREATE TABLE is hiding in the plugin source then.
            expect(src).not.toMatch(/CREATE TABLE/i);
            return;
        }
        const activateMatch = src.match(/function\s+onActivate[\s\S]*?\n {4}\}/);
        const installMatch  = src.match(/function\s+onInstall[\s\S]*?\n {4}\}/);
        if (activateMatch && installMatch) {
            expect(activateMatch[0]).toMatch(/(?:\$this->)?ensureSchema\s*\(/);
            expect(installMatch[0]).toMatch(/(?:\$this->)?ensureSchema\s*\(/);
        }
    });

    // R9 — archives plugin.json version bumped to ≥ 1.5.0
    test('R9: archives plugin.json version is ≥ 1.5.0', async () => {
        const pj = readPrFile('storage/plugins/archives/plugin.json');
        expect(pj).not.toBeNull();
        const parsed = JSON.parse(pj);
        const version = parsed.version;
        expect(version).toBeTruthy();
        function cmp(a, b) {
            const aa = a.split('.').map(Number);
            const bb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
                const x = aa[i] || 0, y = bb[i] || 0;
                if (x !== y) return x - y;
            }
            return 0;
        }
        expect(cmp(version, '1.5.0')).toBeGreaterThanOrEqual(0);
    });

    // R10 — oai-pmh-server plugin.json version bumped to ≥ 1.1.0
    test('R10: oai-pmh-server plugin.json version is ≥ 1.1.0', async () => {
        const pj = readPrFile('storage/plugins/oai-pmh-server/plugin.json');
        expect(pj).not.toBeNull();
        const parsed = JSON.parse(pj);
        const version = parsed.version;
        expect(version).toBeTruthy();
        function cmp(a, b) {
            const aa = a.split('.').map(Number);
            const bb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
                const x = aa[i] || 0, y = bb[i] || 0;
                if (x !== y) return x - y;
            }
            return 0;
        }
        expect(cmp(version, '1.1.0')).toBeGreaterThanOrEqual(0);
    });

    // R11 — RicJsonLdBuilder exports the expected RiC-O entity types
    test('R11: RicJsonLdBuilder references the RiC-O entity types declared by the PR', async () => {
        const src = readPrFile('storage/plugins/archives/RicJsonLdBuilder.php');
        expect(src).not.toBeNull();
        // Phase 2: agents. Phase 3: activities. Phase 4: places + relations.
        // RiC-O class names in the spec.
        expect(src).toMatch(/RecordResource|RecordSet/i);  // archival units
        expect(src).toMatch(/Agent|CorporateBody|Person/i);
        expect(src).toMatch(/Activity/i);
        expect(src).toMatch(/Place/i);
        // JSON-LD context.
        expect(src).toMatch(/@context|@type/);
    });

    // R12 — Phase 6: OAI-PMH ric-o metadataPrefix is advertised
    test('R12: OaiPmhServerPlugin advertises metadataPrefix=ric-o (Phase 6)', async () => {
        const src = readPrFile('storage/plugins/oai-pmh-server/OaiPmhServerPlugin.php');
        expect(src).not.toBeNull();
        // The plugin must include ric-o in its ListMetadataFormats output
        // OR have a route handler that accepts metadataPrefix=ric-o.
        expect(src).toMatch(/ric-o/);
    });

    // R13 — README "What's new" updated for v0.7.12
    test('R13: README mentions v0.7.12 or RiC-CM in the recent-history section', async () => {
        const readme = readPrFile('README.md');
        expect(readme).not.toBeNull();
        // Either the version number OR the feature label must be in the
        // README — surfaces the release to anyone landing on the repo.
        const mentioned = /0\.7\.12|RiC-CM|Records in Contexts/i.test(readme);
        expect(mentioned).toBe(true);
    });
});

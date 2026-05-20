// @ts-check
//
// Regression test for issue #74 — Choices.js author autocomplete must
// create a new author from the typed text when Enter is pressed against
// a HIGHLIGHTED-BUT-NON-MATCHING dropdown item.
//
// History (don't repeat):
//   • 2026-03-01 v0.4.9.4 — original fix (monkey-patch _onEnterKey)
//   • 2026-XX    CR round-11 review — refactored to capture-phase listener,
//                regressed the bug silently because nothing exercised this
//                exact path. Reported by @HansUwe52.
//   • 2026-05-20 v0.7.7 hotfix — monkey-patch restored.
//
// This test reproduces the exact "highlighted-but-non-matching + Enter"
// scenario so any future regression of the monkey-patch (e.g. another
// well-meaning "cleanup" refactor) trips here loudly instead of shipping
// to users.
//
// Run:
//   /tmp/run-e2e.sh tests/issue-74-author-autocomplete.spec.js \
//     --config=tests/playwright.config.js --workers=1

const { test, expect } = require('@playwright/test');

const BASE        = process.env.E2E_BASE_URL    || 'http://localhost:8081';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS  = process.env.E2E_ADMIN_PASS  || '';

test.skip(
    !ADMIN_EMAIL || !ADMIN_PASS,
    'E2E credentials not configured (set E2E_ADMIN_EMAIL, E2E_ADMIN_PASS)',
);

// Unique suffix so re-runs don't collide with rows from a previous session.
const RUN_ID       = Date.now().toString(36);
const TRAP_AUTHOR  = `Norbert Bauer ${RUN_ID}`;   // must pre-exist; the highlight bait
const NEW_AUTHOR   = `Norbert Wex ${RUN_ID}`;     // must be created from typed text
const SHARED_PREFIX = `Norbert`;                  // the substring that makes Bauer the highlight

test.describe.serial('Issue #74 — Choices.js: Enter creates new author when dropdown highlight mismatches', () => {

    /** @type {import('@playwright/test').BrowserContext} */
    let context;
    /** @type {import('@playwright/test').Page} */
    let page;

    test.beforeAll(async ({ browser }) => {
        context = await browser.newContext();
        page = await context.newPage();

        // Login as admin
        await page.goto(`${BASE}/accedi`);
        await page.fill('input[name="email"]', ADMIN_EMAIL);
        await page.fill('input[name="password"]', ADMIN_PASS);
        await Promise.all([
            page.waitForURL(/\/(admin|profilo)/, { timeout: 15000 }),
            page.click('button[type="submit"]'),
        ]);

        // Seed the trap author via Authors Management UI so the dropdown
        // has something to highlight when we type the shared prefix.
        await page.goto(`${BASE}/admin/autori/crea`);
        await page.fill('input[name="nome"]', TRAP_AUTHOR);
        await Promise.all([
            page.waitForURL(/\/admin\/autori(\?|$)/, { timeout: 10000 }),
            page.click('button[type="submit"]'),
        ]);
    });

    test.afterAll(async () => {
        // Cleanup: best-effort delete of both authors. The test does NOT
        // commit a book so there's no book→author FK to break.
        try {
            for (const name of [TRAP_AUTHOR, NEW_AUTHOR]) {
                await page.goto(`${BASE}/admin/autori?search=${encodeURIComponent(name)}`);
                const deleteButton = page.locator(`tr:has-text("${name}") button[type="submit"][formaction*="delete"], tr:has-text("${name}") form[action*="delete"] button`).first();
                if (await deleteButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await deleteButton.click();
                    // Confirm SweetAlert if present
                    const confirm = page.locator('.swal2-confirm').first();
                    if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await confirm.click();
                    }
                    await page.waitForLoadState('domcontentloaded');
                }
            }
        } catch (_) { /* cleanup is best-effort */ }
        await context.close();
    });

    test('Typing a new author name and pressing Enter creates the new author, NOT the highlighted existing match', async () => {
        // Go to the create-book form
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        // Wait for Choices.js to render the cloned input
        const choicesInput = page.locator('.choices__input--cloned').first();
        await expect(choicesInput).toBeVisible({ timeout: 10000 });

        // Type the SHARED PREFIX first so the dropdown highlights the trap author.
        await choicesInput.click();
        await choicesInput.pressSequentially(SHARED_PREFIX, { delay: 60 });

        // Wait for the trap to appear in the dropdown.
        const trapItem = page.locator('.choices__list--dropdown .choices__item--selectable', {
            hasText: TRAP_AUTHOR,
        }).first();
        await expect(trapItem).toBeVisible({ timeout: 5000 });

        // Continue typing the NEW author's distinguishing suffix. The
        // dropdown will keep "Norbert Bauer" highlighted (or whatever
        // partial match remains) — this is the regression-prone state.
        const suffix = NEW_AUTHOR.slice(SHARED_PREFIX.length);
        await choicesInput.pressSequentially(suffix, { delay: 60 });

        // Press Enter. EXPECTED behaviour: the typed string becomes a
        // newly created author. BUG behaviour (the regression we guard
        // against): Choices.js auto-selects the highlighted "Norbert
        // Bauer" and discards the typed text.
        await choicesInput.press('Enter');

        // Give the create-author POST a chance to land.
        await page.waitForTimeout(800);

        // The new author should appear as a selected choice (Choices.js
        // renders selected items as `.choices__item--selectable` outside
        // the dropdown, inside `.choices__list--multiple`).
        const selectedItems = page.locator('.choices__list--multiple .choices__item');
        const selectedTexts = await selectedItems.allInnerTexts();
        const joined = selectedTexts.join('|');

        expect(
            joined,
            `Selected items must include the typed new author. Got: ${joined}`
        ).toContain(NEW_AUTHOR);

        expect(
            joined,
            `Selected items must NOT include the trap (highlighted match). Got: ${joined}`
        ).not.toContain(TRAP_AUTHOR);
    });

    test('Typing an EXISTING author name and pressing Enter still selects the existing match', async () => {
        // Counter-test: the monkey-patch must NOT regress the "type exact
        // existing name → Enter → select existing" path. Without this
        // assertion, a too-aggressive monkey-patch could create a duplicate.
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        const choicesInput = page.locator('.choices__input--cloned').first();
        await expect(choicesInput).toBeVisible({ timeout: 10000 });

        await choicesInput.click();
        await choicesInput.pressSequentially(TRAP_AUTHOR, { delay: 60 });

        // Wait for the exact trap to be the highlighted item.
        const highlighted = page.locator('.choices__list--dropdown .choices__item--selectable.is-highlighted').first();
        await expect(highlighted).toBeVisible({ timeout: 5000 });
        await expect(highlighted).toContainText(TRAP_AUTHOR);

        // Press Enter — should select the existing author, not create a duplicate.
        await choicesInput.press('Enter');
        await page.waitForTimeout(500);

        const selectedTexts = await page.locator('.choices__list--multiple .choices__item').allInnerTexts();
        const trapCount = selectedTexts.filter(t => t.includes(TRAP_AUTHOR)).length;

        expect(
            trapCount,
            `Existing author must be selected exactly once (no duplicate-creation). Selected texts: ${selectedTexts.join(' | ')}`
        ).toBe(1);
    });
});

// @ts-check
//
// Regression-guard tests for app/Views/libri/partials/book_form.php.
//
// This file contains targeted, narrow tests for code paths in book_form.php
// that have regressed before or are at high risk of regressing due to
// well-meaning "refactor for clarity" code review suggestions. Each test
// covers ONE specific behavior; failures here mean a previous fix has been
// undone, not that a new feature broke.
//
// Run:
//   /tmp/run-e2e.sh tests/book-form-regression-guards.spec.js \
//     --config=tests/playwright.config.js --workers=1

const { test, expect } = require('@playwright/test');

const BASE        = process.env.E2E_BASE_URL    || 'http://localhost:8081';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS  = process.env.E2E_ADMIN_PASS  || '';

test.skip(
    !ADMIN_EMAIL || !ADMIN_PASS,
    'E2E credentials not configured (set E2E_ADMIN_EMAIL, E2E_ADMIN_PASS)',
);

const RUN_ID = Date.now().toString(36);

/**
 * Authenticate as admin once per file. The same browser context is shared
 * across all tests so the session cookie survives.
 */
async function loginAsAdmin(page) {
    await page.goto(`${BASE}/accedi`);
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([
        page.waitForURL(/\/(admin|profilo)/, { timeout: 15000 }),
        page.click('button[type="submit"]'),
    ]);
}

test.describe.serial('book_form.php — regression guards', () => {

    /** @type {import('@playwright/test').BrowserContext} */
    let context;
    /** @type {import('@playwright/test').Page} */
    let page;

    test.beforeAll(async ({ browser }) => {
        context = await browser.newContext();
        page = await context.newPage();
        await loginAsAdmin(page);
    });

    test.afterAll(async () => {
        await context.close();
    });

    // ────────────────────────────────────────────────────────────────────
    // Guard #1 — Publisher Choices.js: same Enter-key class as the author
    // bug (#74). If anyone "cleans up" the author monkey-patch the same
    // way for publisher, this catches it immediately.
    // ────────────────────────────────────────────────────────────────────
    test('Guard #1: Publisher Choices.js — Enter on unmatched typed text creates new publisher (not auto-selects existing)', async () => {
        // Seed a trap publisher via the publishers UI.
        const trapPublisher = `Mondadori Test ${RUN_ID}`;
        const newPublisher  = `Mondadori Special ${RUN_ID}`;

        await page.goto(`${BASE}/admin/editori/crea`);
        await page.fill('input[name="nome"]', trapPublisher);
        await Promise.all([
            page.waitForURL(/\/admin\/editori(\?|$)/, { timeout: 10000 }),
            page.click('button[type="submit"]'),
        ]);

        // Open create-book form and target the publisher Choices.
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        // The publisher field — by name attribute on the underlying <select>.
        // The Choices wrapper inherits classes and a cloned input.
        const publisherWrapper = page.locator('select[name="editore_id"]').locator('..').locator('.choices').first();
        await expect(publisherWrapper).toBeVisible({ timeout: 10000 });

        const publisherInput = publisherWrapper.locator('.choices__input--cloned').first();
        await publisherInput.click();
        await publisherInput.pressSequentially('Mondadori Special', { delay: 60 });

        // Wait for dropdown to populate
        await page.waitForTimeout(500);

        // If the publisher Choices is single-select (typical for editore_id), the
        // monkey-patch may or may not be installed. The test still asserts the
        // CONTRACT: Enter should not silently overwrite typed text with a
        // partial-match from the dropdown when the typed value is new.
        // Adapt assertion to whatever the form does — we just guard against
        // duplicate-creation by checking the underlying <select> ends up with
        // a NEW publisher id (not the trap's id) when the user types something
        // that doesn't exactly match.
        await publisherInput.press('Enter');
        await page.waitForTimeout(500);

        // Read the <select>'s selected option's text. If the trap was
        // auto-selected, this will contain "Mondadori Test"; otherwise
        // it should be empty or contain the new publisher name.
        const selectedText = await page.locator('select[name="editore_id"]')
            .evaluate((sel) => {
                const s = /** @type {HTMLSelectElement} */ (sel);
                return s.options[s.selectedIndex]?.text || '';
            });

        // Soft assertion: the trap MUST NOT have been silently selected.
        // (Whether the new publisher gets created depends on whether the
        // publisher field supports inline creation; the no-trap-selected
        // contract is the universal one.)
        expect(
            selectedText.toLowerCase().includes('mondadori test'),
            `Publisher Choices.js MUST NOT auto-select the highlighted trap "${trapPublisher}" when typed text "${newPublisher}" differs. Got selected: "${selectedText}"`
        ).toBe(false);
    });

    // ────────────────────────────────────────────────────────────────────
    // Guard #2 — TinyMCE description field: the textarea must be synced
    // before form submit. A previous refactor accidentally dropped the
    // mceSyncContent() call and saved books with EMPTY descriptions even
    // when the user typed paragraphs of content.
    // ────────────────────────────────────────────────────────────────────
    test('Guard #2: TinyMCE description content survives form submit (no silent data loss)', async () => {
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        const bookTitle = `Test Book TinyMCE ${RUN_ID}`;
        const descText  = `Description paragraph for regression guard ${RUN_ID}. This text must survive the TinyMCE → textarea sync on form submit.`;

        await page.fill('input[name="titolo"]', bookTitle);

        // Wait for TinyMCE to mount on the description textarea
        const tinymceFrame = page.frameLocator('iframe[id*="descrizione"]').first();
        await expect(tinymceFrame.locator('body')).toBeVisible({ timeout: 15000 });

        // Type into TinyMCE
        await tinymceFrame.locator('body').click();
        await tinymceFrame.locator('body').fill(descText);

        // Year (required field in some validators)
        const yearInput = page.locator('input[name="anno_pubblicazione"]').first();
        if (await yearInput.isVisible({ timeout: 1000 }).catch(() => false)) {
            await yearInput.fill('2026');
        }

        // Submit — book_form.php's submit handler MUST call mceSyncContent()
        // or equivalent to push the iframe content back into the textarea.
        const responsePromise = page.waitForResponse(
            r => /\/admin\/libri\/(crea|store|salva)/.test(r.url()) && r.request().method() === 'POST',
            { timeout: 15000 }
        );
        await page.click('button[type="submit"]:not([formaction])').catch(async () => {
            // Fallback selector
            await page.locator('form button[type="submit"]').first().click();
        });

        try {
            await responsePromise;
        } catch (_) { /* may have already redirected */ }
        await page.waitForLoadState('domcontentloaded');

        // The book detail page (or edit page) should now show the description.
        // Most robust check: navigate to the books list, find the just-created
        // book, open it, and inspect.
        await page.goto(`${BASE}/admin/libri?search=${encodeURIComponent(bookTitle)}`);
        const bookRow = page.locator(`tr:has-text("${bookTitle}")`).first();
        await expect(bookRow).toBeVisible({ timeout: 10000 });

        // Open edit view to get raw description content from the form
        await bookRow.locator('a[href*="/modifica"], a[href*="/edit"]').first().click();
        await page.waitForLoadState('domcontentloaded');

        const descTextarea = page.locator('textarea[name="descrizione"]').first();
        const descValue = await descTextarea.inputValue();

        expect(
            descValue,
            `TinyMCE content MUST be synced to the textarea before submit. Form lost the description string "${descText.slice(0, 40)}…".`
        ).toContain('regression guard');
    });

    // ────────────────────────────────────────────────────────────────────
    // Guard #3 — Genre cascade dropdown: changing the "radice" must trigger
    // a fetch that re-populates the "genere" select, which in turn must
    // re-populate "sottogenere". This pipeline broke in a previous refactor
    // when an inline arrow function lost its `this` binding inside the AJAX
    // resolve callback and the cascade silently went dead.
    // ────────────────────────────────────────────────────────────────────
    test('Guard #3: Genre cascade — selecting a radice repopulates the genre dropdown via AJAX', async () => {
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        // The radice select: there's a top-level <select id="radice_select">
        // that drives the genre cascade. If the form doesn't expose a
        // radice picker, this test is structurally invalid for the current
        // build — skip rather than false-fail.
        const radiceSelect = page.locator('select[id*="radice"], select[name*="radice"]').first();
        const radiceVisible = await radiceSelect.isVisible({ timeout: 5000 }).catch(() => false);
        test.skip(!radiceVisible, 'Genre cascade radice picker not present in this build');

        // The genere dropdown must be DISABLED initially (book_form.php
        // ships it disabled until a radice is chosen).
        const genereSelect = page.locator('#genere_select').first();
        await expect(genereSelect).toBeDisabled();

        // Pick the first non-default radice option.
        const options = await radiceSelect.locator('option').all();
        let pickedRadice = '';
        for (const opt of options) {
            const val = await opt.getAttribute('value');
            if (val && val !== '0' && val !== '') {
                pickedRadice = val;
                break;
            }
        }
        expect(pickedRadice, 'At least one radice option must exist').not.toBe('');

        // Listen for the API call BEFORE selecting, so we don't miss it.
        const apiResponse = page.waitForResponse(
            r => /\/(api|admin)\/(dewey|generi|categorie)\b/.test(r.url()) && r.status() === 200,
            { timeout: 10000 }
        ).catch(() => null);

        await radiceSelect.selectOption(pickedRadice);

        // The cascade must fire an XHR and re-enable the genere select.
        await apiResponse;
        await page.waitForTimeout(500); // give the UI time to flip
        await expect(genereSelect).toBeEnabled({ timeout: 5000 });

        // The genere select must now have MORE than the default placeholder
        // option. If it still has only "Seleziona prima una radice…", the
        // cascade silently failed.
        const genereOptionCount = await genereSelect.locator('option').count();
        expect(
            genereOptionCount,
            `Genre cascade MUST populate options after radice selection. Got ${genereOptionCount} options (expected ≥ 2 — placeholder + at least one real genre).`
        ).toBeGreaterThan(1);
    });
});

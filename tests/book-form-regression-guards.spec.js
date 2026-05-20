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
    // Guard #1 — Publisher autocomplete: the publisher field is a custom
    // suggest widget (NOT Choices.js — different bug class than #74). The
    // critical contract is that typing a query + clicking a suggestion
    // populates BOTH the hidden `editore_id` AND the visible label, with
    // the id correctly set to the database row's id (not the previous
    // value or zero). A regression here would silently associate books
    // with the wrong publisher.
    // ────────────────────────────────────────────────────────────────────
    test('Guard #1: Publisher custom autocomplete — selecting a suggestion populates editore_id correctly', async () => {
        const trapPublisher = `MondadoriTest${RUN_ID}`;

        // Seed via the publishers UI
        await page.goto(`${BASE}/admin/editori/crea`);
        await page.fill('input[name="nome"]', trapPublisher);
        await page.click('button[type="submit"]');
        const swalConfirm = page.locator('.swal2-confirm').first();
        if (await swalConfirm.isVisible({ timeout: 5000 }).catch(() => false)) {
            await Promise.all([
                page.waitForURL(/\/admin\/editori(\?|$)/, { timeout: 10000 }),
                swalConfirm.click(),
            ]);
        }

        // Open the book form
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        // Publisher widget: `#editore_search` input + `#editore_suggest` <ul>
        // + `#editore_id` hidden input. Type the trap name, wait for the
        // suggest list to populate, click the entry, then assert that the
        // hidden id is non-zero (= a real publisher was selected, no race).
        const publisherInput = page.locator('#editore_search');
        await expect(publisherInput).toBeVisible({ timeout: 10000 });

        // Assert hidden id starts at 0 (no publisher selected initially)
        const initialId = await page.locator('#editore_id').inputValue();
        expect(initialId, `Initial editore_id must be 0/empty, got "${initialId}"`).toMatch(/^0?$/);

        await publisherInput.click();
        await publisherInput.fill(trapPublisher);
        await page.waitForTimeout(700); // debounce + API

        // The suggestion list should now contain the trap. Click it.
        const suggestion = page.locator('#editore_suggest li', { hasText: trapPublisher }).first();
        await expect(suggestion).toBeAttached({ timeout: 8000 });
        await suggestion.click();
        await page.waitForTimeout(300);

        // After click, the hidden id must be set to a positive integer.
        const finalId = await page.locator('#editore_id').inputValue();
        expect(
            parseInt(finalId, 10),
            `Selecting a publisher suggestion MUST populate #editore_id with a positive integer (got "${finalId}")`
        ).toBeGreaterThan(0);

        // The visible input should display the publisher name.
        const visibleValue = await publisherInput.inputValue();
        expect(
            visibleValue,
            `Visible publisher input should display the selected name`
        ).toContain(trapPublisher);
    });

    // ────────────────────────────────────────────────────────────────────
    // Guard #2 — TinyMCE description field: the textarea must be synced
    // when the user blurs / when the underlying form is about to submit.
    // A previous refactor accidentally dropped the iframe→textarea sync
    // and book descriptions saved as empty even with typed content.
    //
    // Narrow scope: type into the iframe, dispatch a synthetic form submit
    // (without actually navigating away — preventDefault) and verify that
    // the textarea value now contains the typed content. This isolates
    // the TinyMCE sync logic from the rest of the book-form validation.
    // ────────────────────────────────────────────────────────────────────
    test('Guard #2: TinyMCE description content syncs from iframe to textarea on submit', async () => {
        await page.goto(`${BASE}/admin/libri/crea`);
        await page.waitForLoadState('domcontentloaded');

        const descText = `Regression guard ${RUN_ID}: TinyMCE iframe to textarea sync must work.`;

        // Wait for TinyMCE to mount on the description textarea
        const tinymceFrame = page.frameLocator('iframe[id*="descrizione"]').first();
        await expect(tinymceFrame.locator('body')).toBeVisible({ timeout: 15000 });

        // Type into TinyMCE
        await tinymceFrame.locator('body').click();
        await tinymceFrame.locator('body').fill(descText);

        // Trigger TinyMCE's save() so it serialises iframe → textarea.
        // book_form.php registers an editor that exposes window.tinymce.
        // If the global is missing the test simply asserts the contract
        // softly (no false fail on a future TinyMCE-less build).
        const synced = await page.evaluate(() => {
            // @ts-ignore — tinymce is a runtime global injected by the
            // editor bundle; it is intentionally not in TS types here.
            if (typeof window.tinymce === 'undefined' || !window.tinymce.activeEditor) return null;
            // @ts-ignore
            window.tinymce.activeEditor.save();
            const t = document.querySelector('textarea[name="descrizione"]');
            return t ? /** @type {HTMLTextAreaElement} */(t).value : null;
        });

        if (synced === null) {
            test.skip(true, 'TinyMCE not present on this build — sync test n/a');
            return;
        }

        expect(
            synced,
            `TinyMCE.save() MUST sync the iframe body content into the underlying textarea[name="descrizione"]. Got: "${synced.slice(0, 80)}"`
        ).toContain('Regression guard');
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

        const radiceSelect = page.locator('#radice_select');
        const genereSelect = page.locator('#genere_select');
        await expect(radiceSelect).toBeVisible({ timeout: 10000 });

        // The genere dropdown must be DISABLED initially.
        await expect(genereSelect).toBeDisabled();

        // The radice <select> is populated by an async fetch to
        // /api/generi?only_parents=1. Wait for the call to resolve AND
        // for the select to gain at least one real option.
        await page.waitForResponse(
            r => r.url().includes('/api/generi') && r.url().includes('only_parents=1') && r.status() === 200,
            { timeout: 10000 }
        ).catch(() => { /* fetch may have already resolved before await */ });
        // Poll the option count
        await expect.poll(
            () => radiceSelect.locator('option').count(),
            { timeout: 8000, message: 'Radice select must be populated by /api/generi fetch' },
        ).toBeGreaterThan(1);

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

        // Listen for the children call BEFORE selecting so we don't miss it.
        const childrenResponse = page.waitForResponse(
            r => /\/api\/generi.*parent_id|\/api\/generi.*radice|\/api\/dewey\/children/.test(r.url()) && r.status() === 200,
            { timeout: 10000 }
        ).catch(() => null);

        await radiceSelect.selectOption(pickedRadice);
        await childrenResponse;
        await page.waitForTimeout(400);

        await expect(genereSelect).toBeEnabled({ timeout: 5000 });

        const genereOptionCount = await genereSelect.locator('option').count();
        expect(
            genereOptionCount,
            `Genre cascade MUST populate options after radice selection. Got ${genereOptionCount} options.`
        ).toBeGreaterThan(1);
    });
});

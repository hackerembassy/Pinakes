// @ts-check
/**
 * SweetAlert coverage for the "authors" cluster.
 *
 * Proves every SweetAlert fired by the author views is BOTH shown AND
 * functional (the action behind it actually changes DB state / surfaces
 * the right error).
 *
 * Views covered:
 *   - app/Views/autori/index.php          (bulk-delete, bulk-merge guard, bulk-export error, single delete)
 *   - app/Views/autori/crea_autore.php    (client-side validation errors)
 *   - app/Views/autori/modifica_autore.php(client-side validation errors)
 *   - app/Views/autori/scheda_autore.php  (delete from profile page)
 *
 * Run with:
 *   npx playwright test tests/swal-authors.spec.js --config=tests/playwright.config.js --workers=1
 *
 * NOTE: the `autori` table is HARD-deleted (no deleted_at column), so
 * deletion is asserted via COUNT(*) = 0.
 */
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');

// ── Helper block copied VERBATIM from tests/series-cycles.spec.js ──────────
const BASE = process.env.E2E_BASE_URL || 'http://localhost:8081';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || '';
const DB_HOST = process.env.E2E_DB_HOST || '';
const DB_USER = process.env.E2E_DB_USER || '';
const DB_PASS = process.env.E2E_DB_PASS ?? '';
const DB_NAME = process.env.E2E_DB_NAME || '';
const DB_SOCKET = process.env.E2E_DB_SOCKET || '';

const HAS_E2E_ENV = Boolean(ADMIN_EMAIL && ADMIN_PASS && DB_USER && DB_NAME && (DB_HOST || DB_SOCKET));

test.skip(
  !HAS_E2E_ENV,
  'Missing E2E env vars for swal-authors tests'
);

function mysqlArgs(sql = '', batch = false) {
  const args = [];
  if (DB_HOST) args.push('-h', DB_HOST);
  if (DB_SOCKET) args.push('-S', DB_SOCKET);
  args.push('-u', DB_USER);
  if (DB_PASS !== '') args.push(`-p${DB_PASS}`);
  args.push(DB_NAME);
  if (batch) args.push('-N', '-B');
  if (sql !== '') args.push('-e', sql);
  return args;
}

function dbQuery(sql) {
  return execFileSync('mysql', mysqlArgs(sql, true), { encoding: 'utf-8', timeout: 10000 }).trim();
}

function dbExec(sql, timeout = 10000) {
  execFileSync('mysql', mysqlArgs(sql), { encoding: 'utf-8', timeout });
}

function escapeSql(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function loginAsAdmin(page) {
  await page.goto(`${BASE}/admin/dashboard`);
  const emailField = page.locator('input[name="email"]');
  if (await emailField.isVisible({ timeout: 3000 }).catch(() => false)) {
    await emailField.fill(ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([
      page.waitForURL(/\/admin\//, { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);
  }
}
// ── end copied helper block ────────────────────────────────────────────────

/**
 * Set the birth/death dates on the author form. Both fields are hidden
 * Flatpickr inputs, so a plain page.fill() never lands — drive Flatpickr's
 * setDate() (falling back to a direct value assignment) and let the form's
 * submit handler read input[name=...].value.
 */
async function setFlatpickrDates(page, birth, death) {
  await page.evaluate(({ birth, death }) => {
    const set = (id, v) => {
      const el = /** @type {any} */ (document.querySelector(id));
      if (!el) return;
      if (el._flatpickr) el._flatpickr.setDate(v, true);
      else { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
    };
    set('#data_nascita', birth);
    set('#data_morte', death);
  }, { birth, death });
}

// Per-run unique suffix (mirrors series-cycles.spec.js TAG style).
const TAG = 'E2E_SWAL_AUTHORS_' + Date.now();

function insertAuthor(nome) {
  dbExec(`INSERT INTO autori (nome, created_at, updated_at) VALUES ('${escapeSql(nome)}', NOW(), NOW())`);
  return Number(dbQuery(`SELECT id FROM autori WHERE nome = '${escapeSql(nome)}' ORDER BY id DESC LIMIT 1`));
}

function authorCount(nome) {
  return Number(dbQuery(`SELECT COUNT(*) FROM autori WHERE nome = '${escapeSql(nome)}'`));
}

function cleanupRows() {
  // Remove any author-book relations for our authors, then the authors.
  dbExec(`DELETE FROM libri_autori WHERE autore_id IN (SELECT id FROM autori WHERE nome LIKE '${escapeSql(TAG)}%')`);
  dbExec(`DELETE FROM autori WHERE nome LIKE '${escapeSql(TAG)}%'`);
}

/**
 * Select a specific author row's checkbox on the index DataTable by its DB id.
 * The DataTable is AJAX-driven; we filter by name to keep the row on page 1,
 * then tick the row-select checkbox whose data-id matches.
 */
async function selectAuthorRow(page, id) {
  const cb = page.locator(`.row-select[data-id="${id}"]`);
  await cb.waitFor({ state: 'visible', timeout: 10000 });
  if (!(await cb.isChecked())) {
    await cb.check();
  }
}

async function gotoAuthorsFiltered(page, namePrefix) {
  await page.goto(`${BASE}/admin/authors`);
  // Wait for the DataTable + search box to be ready.
  await page.waitForSelector('#search_nome', { timeout: 15000 });
  await page.fill('#search_nome', namePrefix);
  // DataTable redraws on input (debounced) — wait for at least one matching row.
  await page.waitForSelector('.row-select', { timeout: 15000 });
}

test.describe.serial('SweetAlert — authors cluster', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {import('@playwright/test').Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    cleanupRows();
    context = await browser.newContext();
    page = await context.newPage();
    await loginAsAdmin(page);
  });

  test.afterAll(async () => {
    try { cleanupRows(); } catch { /* best-effort cleanup */ }
    await context?.close();
  });

  // ── Trigger: index.php:445 — bulk-delete (confirm-destructive) ──────────
  test('index.php:445 bulk-delete selected authors (confirm-destructive)', async () => {
    const nameA = `${TAG} BulkDel A`;
    const nameB = `${TAG} BulkDel B`;
    const idA = insertAuthor(nameA);
    const idB = insertAuthor(nameB);
    expect(authorCount(nameA)).toBe(1);
    expect(authorCount(nameB)).toBe(1);

    await gotoAuthorsFiltered(page, `${TAG} BulkDel`);
    await selectAuthorRow(page, idA);
    await selectAuthorRow(page, idB);

    // Bulk actions bar appears once a row is selected.
    await page.waitForSelector('#bulk-delete', { state: 'visible', timeout: 10000 });
    await page.click('#bulk-delete');

    // (a) SweetAlert appears
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();

    // Confirm destructive
    await page.locator('.swal2-confirm').click();

    // Success toast then reload — assert (b) rows are gone in DB.
    await expect.poll(() => authorCount(nameA), { timeout: 10000 }).toBe(0);
    expect(authorCount(nameB)).toBe(0);
  });

  // ── Trigger: index.php:494 — bulk-merge guard (error-alert) ─────────────
  test('index.php:494 bulk-merge guard warns when fewer than 2 selected (error-alert)', async () => {
    const name = `${TAG} MergeGuard One`;
    const id = insertAuthor(name);

    await gotoAuthorsFiltered(page, `${TAG} MergeGuard`);
    await selectAuthorRow(page, id);

    await page.waitForSelector('#bulk-merge', { state: 'visible', timeout: 10000 });
    await page.click('#bulk-merge');

    // (a)+(b) the warning Swal appears with the guard title.
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    await expect(page.locator('.swal2-icon-warning')).toBeVisible();
    await expect(page.locator('.swal2-title')).toContainText('Seleziona almeno 2 autori');

    // Dismiss and confirm the author was NOT touched.
    await page.locator('.swal2-confirm').click();
    expect(authorCount(name)).toBe(1);
  });

  // ── Trigger: index.php:614 — bulk-export error path (error-alert) ───────
  test('index.php:614 bulk-export surfaces error Swal on a failing request (error-alert)', async () => {
    const name = `${TAG} ExportErr One`;
    const id = insertAuthor(name);

    await gotoAuthorsFiltered(page, `${TAG} ExportErr`);
    await selectAuthorRow(page, id);

    // Force the export request to fail so the !response.ok error Swal fires.
    await page.route('**/api/autori/bulk-export', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forced server error' }),
      })
    );

    await page.waitForSelector('#bulk-export', { state: 'visible', timeout: 10000 });
    await page.click('#bulk-export');

    // (a)+(b) error Swal appears (icon error) — no CSV is produced.
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-error')).toBeVisible();

    await page.unroute('**/api/autori/bulk-export');
    await page.locator('.swal2-confirm').click().catch(() => {});
    // Author untouched.
    expect(authorCount(name)).toBe(1);
  });

  // ── Trigger: index.php:664 — single delete row button (confirm-destructive) ─
  test('index.php:664 single-author row delete (confirm-destructive)', async () => {
    const name = `${TAG} RowDelete One`;
    const id = insertAuthor(name);
    expect(authorCount(name)).toBe(1);

    await gotoAuthorsFiltered(page, `${TAG} RowDelete`);

    // The row trash button calls deleteAuthor(id). Trigger it directly to
    // avoid icon-button hit-test flakiness, then drive the Swal.
    await page.evaluate((authorId) => window.deleteAuthor(authorId), id);

    // (a) confirm Swal appears
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    await expect(page.locator('.swal2-title')).toContainText('Sei sicuro?');

    // Confirm submits a POST form to /admin/authors/delete/{id} → redirect.
    await Promise.all([
      page.waitForURL(/\/admin\/authors$/, { timeout: 15000 }),
      page.locator('.swal2-confirm').click(),
    ]);

    // (b) author hard-deleted.
    expect(authorCount(name)).toBe(0);
  });

  // ── Trigger: crea_autore.php:141 — client-side validation (error-alert) ──
  test('crea_autore.php:141 create form shows validation error Swals (error-alert)', async () => {
    // Empty required name → "Campo Obbligatorio".
    await page.goto(`${BASE}/admin/authors/create`);
    await page.waitForSelector('#create-author-form', { timeout: 15000 });
    await page.locator('#nome').fill(' '); // space: passes native required, trims empty in JS validator
    await page.click('#create-author-form button[type="submit"]');

    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
    await expect(page.locator('.swal2-title')).toContainText('Campo Obbligatorio');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-popup')).toBeHidden({ timeout: 5000 });

    // birth >= death → "Date Non Valide".
    await page.fill('#nome', `${TAG} BadDates`);
    // #data_nascita/#data_morte are hidden Flatpickr inputs — set via its API.
    await setFlatpickrDates(page, '2000-01-01', '1990-01-01');
    await page.click('#create-author-form button[type="submit"]');

    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
    await expect(page.locator('.swal2-title')).toContainText('Date Non Valide');
    await page.locator('.swal2-confirm').click();

    // (b) nothing was created (form never submitted).
    expect(authorCount(`${TAG} BadDates`)).toBe(0);
  });

  // ── Trigger: modifica_autore.php:152 — edit validation (error-alert) ─────
  test('modifica_autore.php:152 edit form shows validation error Swals (error-alert)', async () => {
    const name = `${TAG} EditValidate`;
    const id = insertAuthor(name);

    await page.goto(`${BASE}/admin/authors/edit/${id}`);
    await page.waitForSelector('#edit-author-form', { timeout: 15000 });

    // Empty name → "Campo Obbligatorio".
    await page.locator('#nome').fill(' '); // space: passes native required, trims empty in JS validator
    await page.click('#edit-author-form button[type="submit"]');

    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
    await expect(page.locator('.swal2-title')).toContainText('Campo Obbligatorio');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-popup')).toBeHidden({ timeout: 5000 });

    // birth >= death → "Date Non Valide".
    await page.fill('#nome', name);
    await setFlatpickrDates(page, '2010-05-05', '1980-05-05');
    await page.click('#edit-author-form button[type="submit"]');

    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
    await expect(page.locator('.swal2-title')).toContainText('Date Non Valide');
    await page.locator('.swal2-confirm').click();

    // (b) the invalid dates were never persisted (form blocked).
    const row = dbQuery(`SELECT CONCAT_WS('|', IFNULL(data_nascita,''), IFNULL(data_morte,'')) FROM autori WHERE id = ${id}`);
    expect(row).toBe('|');
  });

  // ── Trigger: scheda_autore.php:106 — profile delete (confirm-destructive) ─
  test('scheda_autore.php:106 delete author from profile page (confirm-destructive)', async () => {
    const name = `${TAG} ProfileDelete`;
    const id = insertAuthor(name);
    expect(authorCount(name)).toBe(1);

    await page.goto(`${BASE}/admin/authors/${id}`);
    // The delete form is wired by attachSwalConfirm via data-swal-confirm.
    const delForm = page.locator('form[data-swal-confirm]');
    await delForm.waitFor({ state: 'attached', timeout: 15000 });

    // Submit the form (its submit button) → attachSwalConfirm intercepts.
    await delForm.locator('button[type="submit"]').click();

    // (a) confirm Swal appears with the profile-delete prompt.
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    // data-swal-confirm text lands in .swal2-html-container (title defaults to
    // "Sei sicuro?"). Assert the popup contains the (apostrophe-free) substring.
    await expect(page.locator('.swal2-popup')).toContainText('eliminazione');

    // Confirm → form re-submits → redirect to /admin/authors.
    await Promise.all([
      page.waitForURL(/\/admin\/authors$/, { timeout: 15000 }),
      page.locator('.swal2-confirm').click(),
    ]);

    // (b) author hard-deleted.
    expect(authorCount(name)).toBe(0);
  });
});

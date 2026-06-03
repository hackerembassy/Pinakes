// @ts-check
/**
 * E2E coverage for every SweetAlert in the "publishers" (editori) cluster.
 *
 * Each test asserts BOTH that the SweetAlert is shown (.swal2-popup visible)
 * AND that the underlying outcome happened (DB row created/removed, success
 * toast text, or the error/warning alert surfaced).
 *
 * Views covered:
 *   - app/Views/editori/crea_editore.php   (create: confirm + loading + validation errors)
 *   - app/Views/editori/modifica_editore.php (edit: confirm + loading + validation errors)
 *   - app/Views/editori/index.php          (single/bulk delete, bulk merge, bulk export, toasts)
 *   - app/Views/editori/scheda_editore.php (profile-page delete via data-swal-confirm)
 *
 * Run with:
 *   npx playwright test tests/swal-publishers.spec.js --config=tests/playwright.config.js --workers=1
 */
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');

// --- Helper block copied VERBATIM (env wiring) from tests/series-cycles.spec.js ---
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
  'Missing E2E env vars for publishers SweetAlert tests'
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
// --- end verbatim helper block ---

// run-id / unique-suffix style copied verbatim from the template
const TAG = 'E2E_SWAL_PUBLISHERS_' + Date.now();

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

/** Insert a publisher directly and return its id. */
function createPublisher(name) {
  dbExec(`INSERT INTO editori (nome, created_at, updated_at) VALUES ('${escapeSql(name)}', NOW(), NOW())`);
  return Number(dbQuery(`SELECT id FROM editori WHERE nome = '${escapeSql(name)}' ORDER BY id DESC LIMIT 1`));
}

function publisherExists(id) {
  return dbQuery(`SELECT COUNT(*) FROM editori WHERE id = ${Number(id)}`) === '1';
}

function cleanupRows() {
  // libri_editori associations first (FK-safe), then editori rows by TAG.
  dbExec(`
    DELETE FROM libri_editori
     WHERE editore_id IN (SELECT id FROM editori WHERE nome LIKE '${escapeSql(TAG)}%')
  `);
  dbExec(`DELETE FROM editori WHERE nome LIKE '${escapeSql(TAG)}%'`);
}

/**
 * Tick the row checkbox for a publisher id inside the DataTable and confirm the
 * bulk-actions bar became visible. Returns false if the row is not on the page.
 */
async function selectRow(page, id) {
  const cb = page.locator(`.row-select[data-id="${id}"]`);
  await cb.waitFor({ state: 'visible', timeout: 10000 });
  await cb.check();
  await expect(page.locator('#bulk-actions-bar')).toBeVisible();
}

/** Navigate to the editori list and wait for the DataTable to render rows. */
async function gotoList(page) {
  await page.goto(`${BASE}/admin/publishers`);
  await page.waitForSelector('#editori-table tbody tr', { timeout: 15000 });
}

test.describe.serial('Publishers cluster — SweetAlert shown + functional', () => {
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
    try {
      cleanupRows();
    } catch { /* best-effort cleanup */ }
    await context?.close();
  });

  // ---------------------------------------------------------------------------
  // crea_editore.php
  // ---------------------------------------------------------------------------

  test('crea_editore.php:150 — create validation error: missing name (SwalApp.error)', async () => {
    await page.goto(`${BASE}/admin/publishers/create`);
    await page.waitForSelector('#form-crea-editore', { timeout: 10000 });
    // Leave required #nome empty, bypass native required via JS submit listener:
    // click submit — the form's own submit handler runs validation first.
    await page.fill('#nome', '');
    // The form has required attr; trigger the JS validation by dispatching submit.
    await page.evaluate(() => {
      const f = document.getElementById('form-crea-editore');
      if (f) f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
    // No publisher created.
    expect(dbQuery(`SELECT COUNT(*) FROM editori WHERE nome = ''`)).toBe('0');
  });

  test('crea_editore.php:178+187 — create confirm dialog + loading modal + row saved', async () => {
    const name = `${TAG} Created Confirm`;
    await page.goto(`${BASE}/admin/publishers/create`);
    await page.waitForSelector('#form-crea-editore', { timeout: 10000 });
    await page.fill('#nome', name);

    // Submit -> SwalApp.confirm (line 178) appears.
    await page.click('#form-crea-editore button[type="submit"]');
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    await expect(page.locator('.swal2-popup')).toContainText('Conferma Salvataggio');

    // Confirm -> loading modal (line 187) flashes, then form.submit() POSTs.
    await Promise.all([
      page.waitForURL(/\/admin\/publishers(\/|$|\?)/, { timeout: 15000 }),
      page.locator('.swal2-confirm').click(),
    ]);

    expect(dbQuery(`SELECT COUNT(*) FROM editori WHERE nome = '${escapeSql(name)}'`)).toBe('1');
  });

  // ---------------------------------------------------------------------------
  // modifica_editore.php
  // ---------------------------------------------------------------------------

  test('modifica_editore.php:158 — edit validation error: missing name (SwalApp.error)', async () => {
    const id = createPublisher(`${TAG} Edit Validation`);
    await page.goto(`${BASE}/admin/publishers/edit/${id}`);
    await page.waitForSelector('form[action*="/admin/publishers/update/"]', { timeout: 10000 });
    await page.fill('input[name="nome"]', '');
    await page.evaluate(() => {
      const f = document.querySelector('form[action*="/admin/publishers/update/"]');
      if (f) f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
    // Name unchanged in DB (validation blocked submit).
    expect(dbQuery(`SELECT nome FROM editori WHERE id = ${id}`)).toBe(`${TAG} Edit Validation`);
  });

  test('modifica_editore.php:166 — edit validation error: invalid URL (SwalApp.error)', async () => {
    const id = createPublisher(`${TAG} Edit Bad URL`);
    await page.goto(`${BASE}/admin/publishers/edit/${id}`);
    await page.waitForSelector('form[action*="/admin/publishers/update/"]', { timeout: 10000 });
    await page.fill('input[name="nome"]', `${TAG} Edit Bad URL`);
    await page.fill('input[name="sito_web"]', 'not a valid url');
    await page.evaluate(() => {
      const f = document.querySelector('form[action*="/admin/publishers/update/"]');
      if (f) f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('URL Non Valido');
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
  });

  test('modifica_editore.php:176 — edit validation error: invalid email (SwalApp.error)', async () => {
    const id = createPublisher(`${TAG} Edit Bad Email`);
    await page.goto(`${BASE}/admin/publishers/edit/${id}`);
    await page.waitForSelector('form[action*="/admin/publishers/update/"]', { timeout: 10000 });
    await page.fill('input[name="nome"]', `${TAG} Edit Bad Email`);
    await page.fill('input[name="email"]', 'definitely-not-an-email');
    await page.evaluate(() => {
      const f = document.querySelector('form[action*="/admin/publishers/update/"]');
      if (f) f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Email Non Valida');
    await expect(page.locator('.swal2-icon-error')).toBeVisible();
  });

  test('modifica_editore.php:183+191 — edit confirm dialog + loading modal + row updated', async () => {
    const id = createPublisher(`${TAG} Edit Confirm`);
    const newName = `${TAG} Edit Confirm Updated`;
    await page.goto(`${BASE}/admin/publishers/edit/${id}`);
    await page.waitForSelector('form[action*="/admin/publishers/update/"]', { timeout: 10000 });
    await page.fill('input[name="nome"]', newName);

    await page.click('form[action*="/admin/publishers/update/"] button[type="submit"]');
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Conferma Aggiornamento');

    await Promise.all([
      page.waitForURL(/\/admin\/publishers(\/|$|\?)/, { timeout: 15000 }),
      page.locator('.swal2-confirm').click(),
    ]);

    expect(dbQuery(`SELECT nome FROM editori WHERE id = ${id}`)).toBe(newName);
  });

  // ---------------------------------------------------------------------------
  // index.php — single delete
  // ---------------------------------------------------------------------------

  test('index.php:648 — single-row delete: confirm modal -> publisher removed', async () => {
    const id = createPublisher(`${TAG} Single Delete`);
    await gotoList(page);
    // Trigger the global deletePublisher(id) (same call the row button makes).
    await page.evaluate((pid) => window.deletePublisher(pid), id);
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    await expect(page.locator('.swal2-icon-warning')).toBeVisible();

    await Promise.all([
      page.waitForURL(/\/admin\/publishers(\/|$|\?)/, { timeout: 15000 }),
      page.locator('.swal2-confirm').click(),
    ]);

    expect(publisherExists(id)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // index.php — bulk delete + toasts
  // ---------------------------------------------------------------------------

  test('index.php:444+472 — bulk delete: confirm modal -> success toast -> rows removed', async () => {
    const a = createPublisher(`${TAG} Bulk Del A`);
    const b = createPublisher(`${TAG} Bulk Del B`);
    await gotoList(page);
    await selectRow(page, a);
    await selectRow(page, b);

    await page.click('#bulk-delete');
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Conferma eliminazione');
    await page.locator('.swal2-confirm').click();

    // Success toast (timer 2000, no confirm button) — line 472.
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Eliminati');

    // Both rows hard-deleted.
    await expect.poll(() => publisherExists(a), { timeout: 8000 }).toBe(false);
    expect(publisherExists(b)).toBe(false);
  });

  test('index.php:477 — bulk delete: server-error alert (fetch stubbed to fail)', async () => {
    const a = createPublisher(`${TAG} Bulk Del Err`);
    await gotoList(page);
    await selectRow(page, a);

    // Force the bulk-delete endpoint to return success:false so the error
    // alert at line 477 surfaces, without actually deleting anything.
    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/editori/bulk-delete')) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: false, error: 'Forced server error' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return orig(url, opts);
      };
    });

    await page.click('#bulk-delete');
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await page.locator('.swal2-confirm').click(); // confirm the delete dialog
    // Error alert appears next.
    await page.waitForSelector('.swal2-icon-error', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Forced server error');

    // Publisher still present (delete never executed).
    expect(publisherExists(a)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // index.php — bulk merge
  // ---------------------------------------------------------------------------

  test('index.php:488 — bulk merge guard: fewer than 2 selected (warning)', async () => {
    const a = createPublisher(`${TAG} Merge Guard`);
    await gotoList(page);
    await selectRow(page, a); // exactly 1 selected
    await page.click('#bulk-merge');
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-icon-warning')).toBeVisible();
    await expect(page.locator('.swal2-popup')).toContainText('Seleziona almeno 2 editori');
  });

  test('index.php:512 — bulk merge: bulk-export fetch failed -> data load error', async () => {
    const a = createPublisher(`${TAG} Merge Load A`);
    const b = createPublisher(`${TAG} Merge Load B`);
    await gotoList(page);
    await selectRow(page, a);
    await selectRow(page, b);

    // First bulk-export call (used to load names) returns success:false.
    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/editori/bulk-export')) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return orig(url, opts);
      };
    });

    await page.click('#bulk-merge');
    await page.waitForSelector('.swal2-icon-error', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Impossibile recuperare i dati degli editori');
  });

  test('index.php:569 — bulk merge: HTTP error from /api/editori/merge', async () => {
    const a = createPublisher(`${TAG} Merge HTTP A`);
    const b = createPublisher(`${TAG} Merge HTTP B`);
    await gotoList(page);
    await selectRow(page, a);
    await selectRow(page, b);

    // bulk-export succeeds (so the merge form modal opens); merge returns HTTP 500.
    await page.evaluate(({ a, b }) => {
      const orig = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/editori/bulk-export')) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: true, data: [
              { id: a, nome: 'A', libri_count: 0 },
              { id: b, nome: 'B', libri_count: 0 }
            ] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        if (typeof url === 'string' && url.includes('/api/editori/merge')) {
          return Promise.resolve(new Response(
            JSON.stringify({ message: 'Boom 500' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return orig(url, opts);
      };
    }, { a, b });

    await page.click('#bulk-merge');
    // Merge form modal opens.
    await page.waitForSelector('#swal-primary-publisher', { timeout: 8000 });
    await page.locator('.swal2-confirm').click();
    // HTTP-error alert (line 569).
    await page.waitForSelector('.swal2-icon-error', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Boom 500');

    // No merge actually happened — both publishers still exist.
    expect(publisherExists(a)).toBe(true);
    expect(publisherExists(b)).toBe(true);
  });

  test('index.php:594 — bulk merge: server returned success=false', async () => {
    const a = createPublisher(`${TAG} Merge False A`);
    const b = createPublisher(`${TAG} Merge False B`);
    await gotoList(page);
    await selectRow(page, a);
    await selectRow(page, b);

    await page.evaluate(({ a, b }) => {
      const orig = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/editori/bulk-export')) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: true, data: [
              { id: a, nome: 'A', libri_count: 0 },
              { id: b, nome: 'B', libri_count: 0 }
            ] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        if (typeof url === 'string' && url.includes('/api/editori/merge')) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: false, error: 'Merge refused' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return orig(url, opts);
      };
    }, { a, b });

    await page.click('#bulk-merge');
    await page.waitForSelector('#swal-primary-publisher', { timeout: 8000 });
    await page.locator('.swal2-confirm').click();
    await page.waitForSelector('.swal2-icon-error', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Merge refused');

    expect(publisherExists(a)).toBe(true);
    expect(publisherExists(b)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // index.php — bulk export
  // ---------------------------------------------------------------------------

  test('index.php:621 — bulk export: server-error alert (success=false)', async () => {
    const a = createPublisher(`${TAG} Export Err`);
    await gotoList(page);
    await selectRow(page, a);

    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/editori/bulk-export')) {
          return Promise.resolve(new Response(
            JSON.stringify({ success: false, error: 'Export failed' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return orig(url, opts);
      };
    });

    await page.click('#bulk-export');
    await page.waitForSelector('.swal2-icon-error', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toContainText('Export failed');
  });

  // ---------------------------------------------------------------------------
  // scheda_editore.php — profile-page delete
  // ---------------------------------------------------------------------------

  test('scheda_editore.php:77 — profile delete form (data-swal-confirm) -> publisher removed', async () => {
    const id = createPublisher(`${TAG} Profile Delete`);
    // Profile page only shows the delete form when the publisher has no books.
    await page.goto(`${BASE}/admin/publishers/${id}`);
    const form = page.locator('form[data-swal-confirm]');
    await form.waitFor({ state: 'attached', timeout: 10000 });

    await page.locator('form[data-swal-confirm] button[type="submit"]').click();
    await page.waitForSelector('.swal2-popup', { timeout: 8000 });
    await expect(page.locator('.swal2-popup')).toBeVisible();

    await Promise.all([
      page.waitForURL(/\/admin\/publishers(\/|$|\?)/, { timeout: 15000 }),
      page.locator('.swal2-confirm').click(),
    ]);

    expect(publisherExists(id)).toBe(false);
  });
});

// @ts-check
/**
 * Issue #255 — configurable registration fields.
 *
 * End-to-end through the real UI:
 *   1. Defaults: surname/phone/address are required on the public form.
 *   2. Admin unticks the three requirement toggles and defines a custom
 *      "ZZ Telegram 255" field from Settings → Email (Registrazione utenti).
 *   3. The public form drops the required attributes, shows the custom field,
 *      and a registration WITHOUT surname/phone/address succeeds; the custom
 *      value is stored in utenti_campi_valori and surname lands as ''.
 *   4. Cleanup restores the toggles, deletes the custom field (cascade wipes
 *      the value) and removes the test user.
 */

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:8081';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || '';
const DB_USER = process.env.E2E_DB_USER || '';
const DB_PASS = process.env.E2E_DB_PASS || '';
const DB_SOCKET = process.env.E2E_DB_SOCKET || '';
const DB_NAME = process.env.E2E_DB_NAME || '';

test.skip(!ADMIN_EMAIL || !ADMIN_PASS || !DB_USER || !DB_NAME,
  'E2E credentials not configured (set E2E_ADMIN_EMAIL, E2E_ADMIN_PASS, E2E_DB_*)');

function dbQuery(sql) {
  const args = ['-u', DB_USER];
  if (DB_SOCKET) args.push('--socket=' + DB_SOCKET);
  args.push(DB_NAME, '-N', '-B', '-e', sql);
  return execFileSync('mysql', args, {
    encoding: 'utf-8', timeout: 10000,
    env: { ...process.env, MYSQL_PWD: DB_PASS },
  }).trim();
}

const TOKEN = Math.random().toString(16).slice(2, 8);
const FIELD_LABEL = `ZZ Telegram 255 ${TOKEN}`;
const USER_EMAIL = `zz-255-${TOKEN}@example.test`;

test.describe.serial('Issue #255 — configurable registration fields', () => {
  /** @type {import('@playwright/test').Page} */
  let admin;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    admin = await ctx.newPage();
    await admin.goto(`${BASE}/login`);
    await admin.fill('input[name="email"]', ADMIN_EMAIL);
    await admin.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([
      admin.waitForURL(/\/admin\//, { timeout: 15000 }),
      admin.click('button[type="submit"]'),
    ]);
  });

  test.afterAll(async () => {
    // Restore defaults + remove test data regardless of earlier failures.
    dbQuery("UPDATE system_settings SET setting_value='1' WHERE category='registration' AND setting_key IN ('require_cognome','require_telefono','require_indirizzo')");
    dbQuery(`DELETE FROM registrazione_campi WHERE etichetta='${FIELD_LABEL.replace(/'/g, "''")}'`);
    dbQuery(`DELETE FROM utenti WHERE email='${USER_EMAIL}'`);
    await admin?.context()?.close();
  });

  test('1. Defaults: surname/phone/address required on the public form', async ({ page }) => {
    await page.goto(`${BASE}/registrati`);
    for (const field of ['cognome', 'telefono', 'indirizzo']) {
      await expect(page.locator(`[name="${field}"]`)).toHaveAttribute('required', /.*/);
    }
  });

  test('2. Admin relaxes the toggles and adds a custom field', async () => {
    await admin.goto(`${BASE}/admin/settings?tab=email`);
    for (const toggle of ['require_cognome', 'require_telefono', 'require_indirizzo']) {
      await admin.locator(`input[name="${toggle}"]`).uncheck();
    }
    await admin.fill('input[name="new_custom_field_label"]', FIELD_LABEL);
    await admin.selectOption('select[name="new_custom_field_type"]', 'text');
    await admin.click('form[action*="/admin/settings/email"] button[type="submit"]');
    await admin.waitForLoadState('domcontentloaded');

    // Persisted: toggles off + field row present after reload.
    await admin.goto(`${BASE}/admin/settings?tab=email`);
    for (const toggle of ['require_cognome', 'require_telefono', 'require_indirizzo']) {
      await expect(admin.locator(`input[name="${toggle}"]`)).not.toBeChecked();
    }
    await expect(admin.locator(`input[value="${FIELD_LABEL}"]`)).toBeVisible();
    const fieldId = dbQuery(`SELECT id FROM registrazione_campi WHERE etichetta='${FIELD_LABEL.replace(/'/g, "''")}'`);
    expect(Number(fieldId)).toBeGreaterThan(0);
  });

  test('3. Public registration without surname/phone/address succeeds with the custom value', async ({ page }) => {
    await page.goto(`${BASE}/registrati`);
    for (const field of ['cognome', 'telefono', 'indirizzo']) {
      await expect(page.locator(`[name="${field}"]`)).not.toHaveAttribute('required', /.*/);
    }
    const fieldId = dbQuery(`SELECT id FROM registrazione_campi WHERE etichetta='${FIELD_LABEL.replace(/'/g, "''")}'`);
    const customInput = page.locator(`[name="custom_field[${fieldId}]"]`);
    await expect(customInput).toBeVisible();

    await page.fill('input[name="nome"]', 'SoloNome255');
    await page.fill('input[name="email"]', USER_EMAIL);
    await page.fill('input[name="password"]', 'Password255!ok');
    await page.fill('input[name="password_confirm"]', 'Password255!ok');
    await customInput.fill('@solonome');
    await page.check('input[name="privacy_acceptance"]');
    await Promise.all([
      page.waitForURL(/register|registrati|success|successo/i, { timeout: 20000 }),
      page.click('button[type="submit"]'),
    ]);

    const row = dbQuery(`SELECT nome, cognome, IFNULL(telefono,'<null>'), IFNULL(indirizzo,'<null>') FROM utenti WHERE email='${USER_EMAIL}'`);
    expect(row).toContain('SoloNome255');
    const [, cognome, telefono, indirizzo] = row.split('\t');
    expect(cognome).toBe('');
    expect(telefono).toBe('<null>');
    expect(indirizzo).toBe('<null>');

    const stored = dbQuery(`SELECT v.valore FROM utenti_campi_valori v JOIN utenti u ON u.id=v.utente_id WHERE u.email='${USER_EMAIL}'`);
    expect(stored).toBe('@solonome');
  });

  test('4. Restoring the toggles makes the fields required again', async ({ page }) => {
    await admin.goto(`${BASE}/admin/settings?tab=email`);
    for (const toggle of ['require_cognome', 'require_telefono', 'require_indirizzo']) {
      await admin.locator(`input[name="${toggle}"]`).check();
    }
    await admin.click('form[action*="/admin/settings/email"] button[type="submit"]');
    await admin.waitForLoadState('domcontentloaded');

    await page.goto(`${BASE}/registrati`);
    for (const field of ['cognome', 'telefono', 'indirizzo']) {
      await expect(page.locator(`[name="${field}"]`)).toHaveAttribute('required', /.*/);
    }
  });
});

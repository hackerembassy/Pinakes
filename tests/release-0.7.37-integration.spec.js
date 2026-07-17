// @ts-check
/**
 * Release 0.7.37 integration guard.
 *
 * The email-test and configurable-registration features both edit the settings
 * page. These browser checks protect the merge boundary: correct panel
 * ownership, a live email-test listener, and the destructive-field confirm.
 */

const { test, expect } = require('@playwright/test');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:8081';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || '';

test.skip(!ADMIN_EMAIL || !ADMIN_PASS,
  'E2E credentials not configured (set E2E_ADMIN_EMAIL and E2E_ADMIN_PASS)');

test.describe.serial('Release 0.7.37 — settings integration', () => {
  /** @type {import('@playwright/test').Page} */
  let admin;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    admin = await context.newPage();
    await admin.goto(`${BASE}/login`);
    await admin.fill('input[name="email"]', ADMIN_EMAIL);
    await admin.fill('input[name="password"]', ADMIN_PASS);
    await Promise.all([
      admin.waitForURL(/\/admin\//, { timeout: 15000 }),
      admin.click('button[type="submit"]'),
    ]);
  });

  test.afterAll(async () => {
    await admin?.context()?.close();
  });

  test('1. settings JavaScript parses and the email-test controls belong only to Email', async () => {
    const pageErrors = [];
    admin.on('pageerror', (error) => pageErrors.push(error.message));

    await admin.goto(`${BASE}/admin/settings?tab=registration`);

    await expect(admin.locator('section[data-settings-panel="email"] #btn-test-email')).toHaveCount(1);
    await expect(admin.locator('section[data-settings-panel="registration"] #btn-test-email')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('2. email-test button sends the CSRF-protected AJAX request and restores its state', async () => {
    let body = '';
    await admin.route('**/admin/settings/email/test', async (route) => {
      body = route.request().postData() || '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: 'RC integration test intercepted' }),
      });
    });

    await admin.goto(`${BASE}/admin/settings?tab=email`);
    await admin.fill('#test_email', 'rc-integration@example.test');
    await admin.click('#btn-test-email');

    await expect(admin.locator('#test-email-result')).toHaveText('RC integration test intercepted');
    await expect(admin.locator('#btn-test-email')).toBeEnabled();
    expect(body).toContain('test_email=rc-integration%40example.test');
    expect(body).toMatch(/(?:^|&)csrf_token=[^&]+/);
  });

  test('3. cancelling the custom-field deletion confirmation blocks form submission', async () => {
    await admin.goto(`${BASE}/admin/settings?tab=registration`);
    await admin.evaluate(() => {
      const form = document.querySelector('form[action$="/admin/settings/registration"]');
      if (!(form instanceof HTMLFormElement)) throw new Error('registration form missing');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'custom_fields[999999][delete]';
      checkbox.checked = true;
      form.appendChild(checkbox);
    });

    let dialogMessage = '';
    let posted = false;
    admin.once('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });
    await admin.route('**/admin/settings/registration', async (route) => {
      if (route.request().method() === 'POST') posted = true;
      await route.abort();
    });

    await admin.locator('form[action$="/admin/settings/registration"] button[type="submit"]').click();
    await expect.poll(() => dialogMessage).toContain('campi personalizzati');
    await admin.waitForTimeout(200);
    expect(posted).toBe(false);
    expect(admin.url()).toContain('tab=registration');
  });
});

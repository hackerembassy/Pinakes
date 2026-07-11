// @ts-check
//
// Real E2E for the copy-label PDF (Nikola #238): it isn't enough that the
// endpoint returns 200 — the produced PDF must actually honour the settings.
// This drives the real settings UI, generates the real PDF via the real
// endpoint, then inspects the bytes with pdfinfo (page size) and pdftotext
// (content) to assert:
//   • custom label size (89×41mm) becomes the PDF page size;
//   • a per-copy print emits ONLY that copy's label (not every copy);
//   • the "label content" checkboxes really add/remove fields (app name off →
//     absent, subtitle on → present, Dewey off → absent).
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:8081';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS  = process.env.E2E_ADMIN_PASS  || '';
const DB_USER   = process.env.E2E_DB_USER   || '';
const DB_PASS   = process.env.E2E_DB_PASS   || '';
const DB_HOST   = process.env.E2E_DB_HOST   || '';
const DB_PORT   = process.env.E2E_DB_PORT   || '';
const DB_SOCKET = process.env.E2E_DB_SOCKET || '';
const DB_NAME   = process.env.E2E_DB_NAME   || '';

// pdftotext/pdfinfo (poppler) are required to inspect the PDF.
let poppler = true;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' }); }
catch { poppler = false; }

test.skip(!ADMIN_EMAIL || !ADMIN_PASS || !DB_USER || !DB_NAME || (!DB_HOST && !DB_SOCKET), 'E2E credentials not configured');
test.skip(!poppler, 'poppler (pdftotext/pdfinfo) not installed');

function mysqlArgs(sql, batch) {
  const args = [];
  if (DB_HOST) { args.push('-h', DB_HOST); if (DB_PORT) args.push('-P', DB_PORT); }
  else if (DB_SOCKET) { args.push('-S', DB_SOCKET); }
  args.push('-u', DB_USER, DB_NAME);
  if (batch) args.push('-N', '-B');
  args.push('-e', sql);
  return args;
}
function dbQuery(sql) {
  return execFileSync('mysql', mysqlArgs(sql, true), { encoding: 'utf-8', timeout: 10000, env: { ...process.env, MYSQL_PWD: DB_PASS } }).trim();
}
function dbExec(sql) { execFileSync('mysql', mysqlArgs(sql, false), { encoding: 'utf-8', timeout: 10000, env: { ...process.env, MYSQL_PWD: DB_PASS } }); }
function sqlStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

const RUN = Date.now().toString(36);
const TITLE = `ZLabelTitle ${RUN}`;
const SUBTITLE = `ZLabelSub ${RUN}`;
const DEWEY = '823.92';
const CODE_A = `ZLBLA-${RUN}`;
const CODE_B = `ZLBLB-${RUN}`;

/** Download the label PDF to a temp file and return {text, widthPt, heightPt}. */
async function inspectLabel(page, urlPath) {
  const resp = await page.request.get(`${BASE}${urlPath}`);
  expect(resp.status(), `GET ${urlPath}`).toBe(200);
  expect(resp.headers()['content-type']).toContain('application/pdf');
  const file = path.join(os.tmpdir(), `label-${RUN}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(file, await resp.body());
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf-8' });
  const info = execFileSync('pdfinfo', [file], { encoding: 'utf-8' });
  fs.unlinkSync(file);
  const m = info.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i);
  return { text, widthPt: m ? parseFloat(m[1]) : 0, heightPt: m ? parseFloat(m[2]) : 0 };
}

test.describe.serial('Copy-label PDF content (#238)', () => {
  let bookId = 0, copyAId = 0, copyBId = 0;
  /** @type {Record<string,string>} */
  const savedLabel = {};

  test.beforeAll(async () => {
    dbExec(`INSERT INTO libri (titolo, sottotitolo, classificazione_dewey, copie_totali, copie_disponibili, created_at, updated_at)
            VALUES (${sqlStr(TITLE)}, ${sqlStr(SUBTITLE)}, ${sqlStr(DEWEY)}, 2, 2, NOW(), NOW())`);
    bookId = Number(dbQuery(`SELECT id FROM libri WHERE titolo=${sqlStr(TITLE)} ORDER BY id DESC LIMIT 1`));
    dbExec(`INSERT INTO copie (libro_id, stato, numero_inventario, created_at) VALUES
            (${bookId}, 'disponibile', ${sqlStr(CODE_A)}, NOW()), (${bookId}, 'disponibile', ${sqlStr(CODE_B)}, NOW())`);
    copyAId = Number(dbQuery(`SELECT id FROM copie WHERE numero_inventario=${sqlStr(CODE_A)}`));
    copyBId = Number(dbQuery(`SELECT id FROM copie WHERE numero_inventario=${sqlStr(CODE_B)}`));
    // Snapshot label settings so we can restore them.
    for (const k of ['width', 'height', 'format_name', 'show_app_name', 'show_title', 'show_subtitle', 'show_author_publisher', 'show_dewey']) {
      savedLabel[k] = dbQuery(`SELECT COALESCE((SELECT setting_value FROM system_settings WHERE category='label' AND setting_key=${sqlStr(k)} LIMIT 1),'')`);
    }
  });

  test.afterAll(async () => {
    dbExec(`DELETE FROM copie WHERE libro_id=${bookId}`);
    dbExec(`DELETE FROM libri WHERE id=${bookId}`);
    // Restore label settings exactly as they were.
    for (const [k, v] of Object.entries(savedLabel)) {
      if (v === '') { dbExec(`DELETE FROM system_settings WHERE category='label' AND setting_key=${sqlStr(k)}`); }
      else { dbExec(`INSERT INTO system_settings (category, setting_key, setting_value) VALUES ('label', ${sqlStr(k)}, ${sqlStr(v)})
                     ON DUPLICATE KEY UPDATE setting_value=${sqlStr(v)}`); }
    }
  });

  test('custom size 89×41 becomes the page size; per-copy prints only that copy; field toggles apply', async ({ page }) => {
    // Drive the REAL settings UI: custom size + content checkboxes.
    await page.goto(`${BASE}/accedi`);
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(u => u.toString().includes('/admin'), { timeout: 15000 });

    await page.goto(`${BASE}/admin/settings?tab=labels`);
    await page.locator('[data-settings-tab="labels"]').click();
    await expect(page.locator('section[data-settings-panel="labels"]')).toBeVisible();
    await page.locator('input[name="label_format"][value="custom"]').check();
    await page.locator('input[name="custom_width"]').fill('89');
    await page.locator('input[name="custom_height"]').fill('41');
    await page.locator('input[name="show_app_name"]').uncheck();     // OFF → must be absent
    await page.locator('input[name="show_title"]').check();
    await page.locator('input[name="show_subtitle"]').check();       // ON → must be present
    await page.locator('input[name="show_dewey"]').uncheck();        // OFF → must be absent
    await page.locator('section[data-settings-panel="labels"] button[type="submit"]').click();
    await page.waitForLoadState('networkidle');
    expect(dbQuery(`SELECT setting_value FROM system_settings WHERE category='label' AND setting_key='width'`)).toBe('89');

    // Single copy A.
    const a = await inspectLabel(page, `/admin/books/${bookId}/copy-labels-pdf?copy_id=${copyAId}`);
    // 89mm × 41mm in points (1mm = 2.83465pt): 252.3 × 116.2, allow ±3pt.
    expect(Math.abs(a.widthPt - 252.28)).toBeLessThan(3);
    expect(Math.abs(a.heightPt - 116.22)).toBeLessThan(3);
    expect(a.text).toContain(CODE_A);                 // this copy's code…
    expect(a.text).not.toContain(CODE_B);             // …and ONLY this copy
    expect(a.text).toContain(TITLE);                  // title shown
    expect(a.text).toContain(SUBTITLE);               // subtitle ON → present
    expect(a.text).not.toContain('Pinakes');          // app name OFF → absent
    expect(a.text).not.toContain(DEWEY);              // Dewey OFF → absent

    // Whole book (no copy_id) → BOTH copies' labels.
    const all = await inspectLabel(page, `/admin/books/${bookId}/copy-labels-pdf`);
    expect(all.text).toContain(CODE_A);
    expect(all.text).toContain(CODE_B);
  });
});

// @ts-check
/**
 * E2E — MAG 2.0.1 metadata validation (v0.7.4)
 *
 * Covers deep validation of the MAG (Metadati Amministrativi e Gestionali) 2.0.1
 * metadata format as produced by the oai-pmh-server plugin.
 *
 * Covers:
 *  1. mag_project_config table exists
 *  2. OAI ListMetadataFormats includes metadataPrefix=mag
 *  3. OAI ListRecords?metadataPrefix=mag → 200 no error
 *  4. MAG record has version="2.0.1" attribute
 *  5. MAG record contains <gen> section
 *  6. MAG <gen> contains <stprog> element
 *  7. MAG <gen> contains <collection> element
 *  8. MAG <gen> contains <rights> element
 *  9. MAG record contains <bib> section
 * 10. MAG <bib> contains dc:title element
 * 11. MAG <bib> contains dc:creator when authors exist
 * 12. MAG <bib> contains <paese>IT</paese>
 * 13. OAI GetRecord with metadataPrefix=mag → 200 for specific book
 * 14. GetRecord MAG response has correct OAI-PMH envelope
 * 15. GetRecord MAG <bib> title matches DB title
 * 16. Book with file_url set → MAG <doc> section present
 * 17. Book without file_url → no <doc> section
 * 18. MAG records use proper XML namespace (iccu.sbn.it/mag)
 *
 * Run: /tmp/run-e2e.sh tests/mag-validation.spec.js --config=tests/playwright.config.js --workers=1
 */

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');

const BASE      = process.env.E2E_BASE_URL  || 'http://localhost:8081';
const DB_USER   = process.env.E2E_DB_USER   || '';
const DB_PASS   = process.env.E2E_DB_PASS   || '';
const DB_NAME   = process.env.E2E_DB_NAME   || '';
const DB_SOCKET = process.env.E2E_DB_SOCKET || '';
const DB_HOST   = process.env.E2E_DB_HOST   || '';
const DB_PORT   = process.env.E2E_DB_PORT   || '';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || '';
const ADMIN_PASS  = process.env.E2E_ADMIN_PASS  || '';

function mysqlArgs(sql, batch = false) {
    const args = [];
    if (DB_SOCKET) {
        args.push('-S', DB_SOCKET);
    } else {
        if (DB_HOST) args.push('-h', DB_HOST);
        if (DB_PORT) args.push('-P', DB_PORT);
    }
    args.push('-u', DB_USER, DB_NAME);
    if (batch) args.push('-N', '-B');
    if (sql !== '') args.push('-e', sql);
    return args;
}
const MYSQL_ENV = () => ({ ...process.env, MYSQL_PWD: DB_PASS });
function dbQuery(sql) {
    return execFileSync('mysql', mysqlArgs(sql, true), {
        encoding: 'utf-8', timeout: 10000, env: MYSQL_ENV(),
    }).trim();
}

function getOaiPluginState() {
    const row = dbQuery(
        "SELECT p.id, p.is_active, COUNT(ph.id) AS hooks " +
        "FROM plugins p " +
        "LEFT JOIN plugin_hooks ph ON ph.plugin_id = p.id " +
        "AND ph.hook_name = 'app.routes.register' " +
        "AND ph.callback_method = 'registerRoutes' " +
        "AND ph.is_active = 1 " +
        "WHERE p.name = 'oai-pmh-server' " +
        "GROUP BY p.id, p.is_active " +
        "LIMIT 1"
    );
    if (!row) return { id: 0, active: false, hooks: 0 };
    const parts = row.split('\t');
    return {
        id: parseInt(parts[0]) || 0,
        active: parts[1] === '1',
        hooks: parseInt(parts[2]) || 0,
    };
}

async function activateOaiPlugin(browser) {
    if (!ADMIN_EMAIL || !ADMIN_PASS) {
        return false;
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(`${BASE}/login`);
        await page.fill('input[name="email"]', ADMIN_EMAIL);
        await page.fill('input[name="password"]', ADMIN_PASS);
        await Promise.all([
            page.waitForURL(/\/admin\//, { timeout: 15000 }),
            page.click('button[type="submit"]'),
        ]);
        await page.goto(`${BASE}/admin/plugins`);

        const plugin = getOaiPluginState();
        if (plugin.id === 0) {
            return false;
        }

        const pluginApiCall = async (action) => page.evaluate(async ([act, pid]) => {
            const csrfInput = document.querySelector('input[name="csrf_token"]');
            const token = csrfInput ? (/** @type {HTMLInputElement} */ (csrfInput)).value : '';
            const formData = new FormData();
            formData.append('csrf_token', token);
            const res = await fetch(
                `${window.location.origin}${window.BASE_PATH || ''}/admin/plugins/${pid}/${act}`,
                { method: 'POST', body: formData }
            );
            return res.json();
        }, [action, plugin.id]);

        if (plugin.active && plugin.hooks === 0) {
            const deactivate = await pluginApiCall('deactivate');
            if (!deactivate.success) {
                return false;
            }
        }

        const current = getOaiPluginState();
        if (!current.active || current.hooks === 0) {
            const activate = await pluginApiCall('activate');
            return Boolean(activate.success);
        }
        return true;
    } finally {
        await context.close();
    }
}

async function ensureOaiPmhRoute(browser) {
    let plugin = getOaiPluginState();
    if (plugin.id === 0) {
        return;
    }

    if (!plugin.active || plugin.hooks === 0) {
        const activated = await activateOaiPlugin(browser);
        plugin = getOaiPluginState();
        if (!activated || !plugin.active || plugin.hooks === 0) {
            throw new Error('OAI-PMH plugin activation did not register the /oai route hook');
        }
    }
}

test.skip(
    !DB_USER || !DB_NAME,
    'Missing E2E env (DB_*)'
);

test.describe.serial('MAG 2.0.1 metadata validation — v0.7.4 (18 tests)', () => {
    /** @type {number} */
    let testBookId = 0;
    /** @type {string} */
    let testBookTitle = '';
    /** @type {string} */
    let bookWithFile = '';
    /** @type {string} */
    let bookWithoutFile = '';

    test.beforeAll(async ({ browser }) => {
        await ensureOaiPmhRoute(browser);

        // Basic book for OAI tests
        const row = dbQuery(
            "SELECT id, titolo FROM libri WHERE deleted_at IS NULL ORDER BY id LIMIT 1"
        );
        if (row) {
            const parts = row.split('\t');
            testBookId    = parseInt(parts[0]) || 0;
            testBookTitle = (parts[1] ?? '').trim();
        }

        // Book with file_url set (for <doc> section test)
        const withFile = dbQuery(
            "SELECT id FROM libri WHERE deleted_at IS NULL AND file_url IS NOT NULL AND file_url <> '' ORDER BY id LIMIT 1"
        );
        bookWithFile = withFile || '';

        // Book without file_url (for no-<doc> section test)
        const withoutFile = dbQuery(
            "SELECT id FROM libri WHERE deleted_at IS NULL AND (file_url IS NULL OR file_url = '') ORDER BY id LIMIT 1"
        );
        bookWithoutFile = withoutFile || '';
    });

    // ── Tests 1-2: Schema and format registration ────────────────────────────

    test('1. mag_project_config table exists', async () => {
        const cnt = dbQuery(
            "SELECT COUNT(*) FROM information_schema.TABLES " +
            "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mag_project_config'"
        );
        expect(parseInt(cnt)).toBe(1);
    });

    test('2. OAI ListMetadataFormats includes metadataPrefix=mag', async ({ request }) => {
        const res = await request.get(`${BASE}/oai?verb=ListMetadataFormats`);
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).toContain('<metadataPrefix>mag</metadataPrefix>');
    });

    // ── Tests 3-4: ListRecords basic ─────────────────────────────────────────

    test('3. OAI ListRecords?metadataPrefix=mag → 200, no OAI error', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).not.toContain('<error code=');
        expect(body).toContain('<metadigit');
    });

    test('4. MAG record has version="2.0.1" attribute', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('version="2.0.1"');
    });

    // ── Tests 5-8: <gen> section ─────────────────────────────────────────────

    test('5. MAG record contains <gen> section', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<gen>');
        expect(body).toContain('</gen>');
    });

    test('6. MAG <gen> contains <stprog> (project provenance)', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<stprog>');
        expect(body).toContain('<progetto>');
    });

    test('7. MAG <gen> contains <collection> element', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<collection>');
    });

    test('8. MAG <gen> contains <rights> element', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<rights>');
    });

    // ── Tests 9-12: <bib> section ────────────────────────────────────────────

    test('9. MAG record contains <bib> section', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<bib>');
        expect(body).toContain('</bib>');
    });

    test('10. MAG <bib> contains dc:title', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<dc:title>');
    });

    test('11. MAG <bib> contains dc:creator element if authors exist', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const authorCount = dbQuery(
            `SELECT COUNT(*) FROM libri_autori WHERE libro_id = ${testBookId}`
        );
        const res = await request.get(`${BASE}/oai?verb=GetRecord&metadataPrefix=mag&identifier=oai:pinakes:book:${testBookId}`);
        const body = await res.text();
        if (parseInt(authorCount) > 0) {
            expect(body).toContain('<dc:creator>');
        } else {
            // When no authors are linked, dc:creator must be absent.
            expect(body).not.toContain('<dc:creator>');
        }
    });

    test('12. MAG <bib> contains <paese>IT</paese>', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('<paese>IT</paese>');
    });

    // ── Tests 13-15: GetRecord ────────────────────────────────────────────────

    test('13. OAI GetRecord metadataPrefix=mag → 200 for specific book', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(
            `${BASE}/oai?verb=GetRecord&metadataPrefix=mag&identifier=oai:pinakes:book:${testBookId}`
        );
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).not.toContain('<error code=');
        expect(body).toContain('<metadigit');
    });

    test('14. GetRecord MAG response has proper OAI-PMH envelope', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(
            `${BASE}/oai?verb=GetRecord&metadataPrefix=mag&identifier=oai:pinakes:book:${testBookId}`
        );
        const body = await res.text();
        expect(body).toContain('<OAI-PMH');
        expect(body).toContain('<GetRecord>');
        expect(body).toContain('<record>');
        expect(body).toContain('<metadata>');
    });

    test('15. GetRecord MAG <bib> title matches DB title', async ({ request }) => {
        test.skip(testBookId === 0 || testBookTitle === '', 'No book in DB');
        const res = await request.get(
            `${BASE}/oai?verb=GetRecord&metadataPrefix=mag&identifier=oai:pinakes:book:${testBookId}`
        );
        const body = await res.text();
        expect(body).toContain('<dc:title>');
        // Extract <dc:title> value and compare with DB title (XML may HTML-encode chars).
        const match = body.match(/<dc:title>([^<]*)<\/dc:title>/);
        expect(match).not.toBeNull();
        if (match) {
            const xmlTitle = match[1]
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                .replace(/&#0*39;/g, "'").replace(/&#0*34;/g, '"')
                .replace(/&#0*60;/g, '<').replace(/&#0*62;/g, '>')
                .replace(/&#0*38;/g, '&')
                .replace(/&amp;/g, '&').trim();
            expect(xmlTitle).toBe(testBookTitle);
        }
    });

    // ── Tests 16-17: <doc> section (file presence) ───────────────────────────

    test('16. Book with file_url → MAG <doc> section present in GetRecord', async ({ request }) => {
        test.skip(!bookWithFile, 'No book with file_url in DB');
        const res = await request.get(
            `${BASE}/oai?verb=GetRecord&metadataPrefix=mag&identifier=oai:pinakes:book:${bookWithFile}`
        );
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).not.toContain('<error code=');
        expect(body).toContain('<doc>');
        expect(body).toContain('<defile>');
    });

    test('17. Book without file_url → no <doc> section in GetRecord', async ({ request }) => {
        test.skip(!bookWithoutFile, 'No book without file_url in DB');
        const res = await request.get(
            `${BASE}/oai?verb=GetRecord&metadataPrefix=mag&identifier=oai:pinakes:book:${bookWithoutFile}`
        );
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).not.toContain('<error code=');
        expect(body).not.toContain('<doc>');
    });

    // ── Test 18: Namespace ────────────────────────────────────────────────────

    test('18. MAG records use iccu.sbn.it/mag XML namespace', async ({ request }) => {
        test.skip(testBookId === 0, 'No book in DB');
        const res = await request.get(`${BASE}/oai?verb=ListRecords&metadataPrefix=mag&set=books`);
        const body = await res.text();
        expect(body).toContain('iccu.sbn.it/mag');
    });
});

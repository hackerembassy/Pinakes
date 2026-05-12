// @ts-check
/**
 * E2E — FAIR Signposting (RFC 9264) on book detail pages (v0.7.4+)
 *
 * Verifies that book detail responses include FAIR Signposting link relations
 * both as HTTP Link headers and as HTML <link> elements in <head>.
 *
 * Tests:
 *  1.  Book detail page response has Link HTTP header
 *  2.  Link header contains rel="describedby"
 *  3.  describedby points to /api/bibframe/book/{id}
 *  4.  describedby entry has type="application/ld+json"
 *  5.  Link header contains rel="type"
 *  6.  rel="type" href contains https://schema.org/
 *  7.  HTML <head> contains <link rel="describedby">
 *  8.  HTML <link rel="describedby"> href matches BIBFRAME API URI
 *  9.  HTML <head> contains <link rel="type">
 * 10.  HTML <link rel="type"> href contains schema.org
 * 11.  Catalog index page does NOT have Link: rel="describedby" header
 * 12.  Book Schema.org JSON-LD includes BIBFRAME /id/instance/{id} in sameAs
 *
 * Run: /tmp/run-e2e.sh tests/fair-signposting.spec.js --config=tests/playwright.config.js --workers=1
 */

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');

const BASE      = process.env.E2E_BASE_URL  || 'http://localhost:8081';
const DB_USER   = process.env.E2E_DB_USER   || '';
const DB_PASS   = process.env.E2E_DB_PASS   || '';
const DB_NAME   = process.env.E2E_DB_NAME   || '';
const DB_SOCKET = process.env.E2E_DB_SOCKET || '';
const TAG       = `E2E_Signposting_Book_${Date.now()}`;

function mysqlArgs(sql, batch = false) {
    const args = [];
    if (DB_SOCKET) args.push('-S', DB_SOCKET);
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
function dbExec(sql) {
    execFileSync('mysql', mysqlArgs(sql), { encoding: 'utf-8', timeout: 10000, env: MYSQL_ENV() });
}

test.skip(!DB_USER || !DB_NAME, 'Missing E2E env (DB_*)');

test.describe.serial('FAIR Signposting — HTTP headers and HTML <link> (12 tests)', () => {
    /** @type {number} */
    let bookId = 0;
    /** @type {string} */
    let bookUrl = '';

    test.beforeAll(async ({ request }) => {
        dbExec(
            "INSERT INTO libri (titolo, anno_pubblicazione, created_at, updated_at) " +
            `VALUES ('${TAG}', 2024, NOW(), NOW())`
        );
        bookId = parseInt(
            dbQuery(`SELECT id FROM libri WHERE titolo='${TAG}' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`)
        ) || 0;

        if (bookId > 0) {
            // Follow the 301 chain (/libro/{id} → canonical slug URL) to get final URL
            const res = await request.get(`${BASE}/libro/${bookId}`, { maxRedirects: 10 });
            bookUrl = res.url();
        }
    });

    test.afterAll(async () => {
        try { if (bookId > 0) dbExec(`DELETE FROM libri WHERE id=${bookId}`); } catch { /* best-effort */ }
    });

    /** Follow redirects and return the final response for a book detail page. */
    async function fetchBookDetail(request) {
        // /libro/{id} redirects (301) to canonical /{author}/{slug}/{id} — follow chain
        const res = await request.get(`${BASE}/libro/${bookId}`, { maxRedirects: 10 });
        return res;
    }

    // ── HTTP Link header checks ───────────────────────────────────────────────

    test('1. Book detail response has Link HTTP header', async ({ request }) => {
        test.skip(bookId === 0, 'No test book');
        const res = await fetchBookDetail(request);
        const link = res.headers()['link'] ?? '';
        expect(link).toBeTruthy();
    });

    test('2. Link header contains rel="describedby"', async ({ request }) => {
        test.skip(bookId === 0, 'No test book');
        const res = await fetchBookDetail(request);
        const link = res.headers()['link'] ?? '';
        expect(link).toContain('rel="describedby"');
    });

    test('3. describedby points to /api/bibframe/book/{id}', async ({ request }) => {
        test.skip(bookId === 0, 'No test book');
        const res = await fetchBookDetail(request);
        const link = res.headers()['link'] ?? '';
        expect(link).toContain(`/api/bibframe/book/${bookId}`);

        // Live GET: the describedby URL must be reachable and return JSON-LD
        const descRes = await request.get(`${BASE}/api/bibframe/book/${bookId}`, {
            headers: { Accept: 'application/ld+json' },
        });
        expect(descRes.status()).toBe(200);
        const ct = descRes.headers()['content-type'] ?? '';
        expect(ct).toContain('application/ld+json');
    });

    test('4. describedby entry has type="application/ld+json"', async ({ request }) => {
        test.skip(bookId === 0, 'No test book');
        const res = await fetchBookDetail(request);
        const link = res.headers()['link'] ?? '';
        expect(link).toContain('type="application/ld+json"');
    });

    test('5. Link header contains rel="type"', async ({ request }) => {
        test.skip(bookId === 0, 'No test book');
        const res = await fetchBookDetail(request);
        const link = res.headers()['link'] ?? '';
        expect(link).toContain('rel="type"');
    });

    test('6. rel="type" href contains https://schema.org/', async ({ request }) => {
        test.skip(bookId === 0, 'No test book');
        const res = await fetchBookDetail(request);
        const link = res.headers()['link'] ?? '';
        expect(link).toContain('https://schema.org/');
    });

    // ── HTML <link> in <head> checks ──────────────────────────────────────────

    test('7. HTML <head> contains <link rel="describedby">', async ({ page }) => {
        test.skip(bookId === 0, 'No test book');
        await page.goto(`${BASE}/libro/${bookId}`, { waitUntil: 'domcontentloaded' });
        const el = page.locator('head link[rel="describedby"]');
        await expect(el).toHaveCount(1);
    });

    test('8. <link rel="describedby"> href matches BIBFRAME API URI', async ({ page }) => {
        test.skip(bookId === 0, 'No test book');
        await page.goto(`${BASE}/libro/${bookId}`, { waitUntil: 'domcontentloaded' });
        const href = await page.locator('head link[rel="describedby"]').getAttribute('href');
        expect(href ?? '').toContain(`/api/bibframe/book/${bookId}`);
    });

    test('9. HTML <head> contains <link rel="type">', async ({ page }) => {
        test.skip(bookId === 0, 'No test book');
        await page.goto(`${BASE}/libro/${bookId}`, { waitUntil: 'domcontentloaded' });
        const el = page.locator('head link[rel="type"]');
        await expect(el).toHaveCount(1);
    });

    test('10. <link rel="type"> href contains schema.org', async ({ page }) => {
        test.skip(bookId === 0, 'No test book');
        await page.goto(`${BASE}/libro/${bookId}`, { waitUntil: 'domcontentloaded' });
        const href = await page.locator('head link[rel="type"]').getAttribute('href');
        expect(href ?? '').toContain('schema.org');
    });

    // ── Negative / catalog check ──────────────────────────────────────────────

    test('11. Catalog page does NOT have Link: rel="describedby" header', async ({ request }) => {
        const res = await request.get(`${BASE}/catalogo`, { maxRedirects: 5 });
        const link = res.headers()['link'] ?? '';
        // May have other link rels (e.g. canonical) but not describedby
        expect(link).not.toContain('rel="describedby"');
    });

    // ── Schema.org sameAs BIBFRAME ────────────────────────────────────────────

    test('12. Book Schema.org JSON-LD includes BIBFRAME /id/instance/{id} in sameAs', async ({ page, request }) => {
        test.skip(bookId === 0, 'No test book');
        await page.goto(`${BASE}/libro/${bookId}`, { waitUntil: 'domcontentloaded' });
        const ldJson = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const s of scripts) {
                try {
                    const parsed = JSON.parse(s.textContent || '[]');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const item of arr) {
                        if (item['@type'] && String(item['@type']).includes('Book')) return item;
                        if (item['@type'] === 'CreativeWork') return item;
                    }
                } catch { /* skip */ }
            }
            return null;
        });
        expect(ldJson).not.toBeNull();
        const sameAs = ldJson?.sameAs ?? [];
        const sameAsArr = Array.isArray(sameAs) ? sameAs : [sameAs];
        const hasBibframe = sameAsArr.some(u => String(u).includes(`/id/instance/${bookId}`));
        expect(hasBibframe).toBe(true);

        // Live GET: the persistent URI in sameAs must be reachable (200)
        // The BIBFRAME instance URI is served by the app at /api/bibframe/book/{id}
        const bibframeUri = `${BASE}/api/bibframe/book/${bookId}`;
        const bibRes = await request.get(bibframeUri, {
            headers: { Accept: 'application/rdf+xml' },
        });
        expect(bibRes.status()).toBe(200);
        const bibCt = bibRes.headers()['content-type'] ?? '';
        expect(bibCt).toContain('application/rdf+xml');
    });
});

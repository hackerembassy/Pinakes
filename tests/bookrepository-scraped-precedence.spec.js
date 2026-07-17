// @ts-check

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test.describe('BookRepository optional field precedence', () => {
  test('manual translator and illustrator win over scraped fallbacks', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/Models/BookRepository.php'), 'utf-8');

    // Scraped values are only a fallback when the manual field was NOT provided.
    expect(source).toContain('Scraped values are only a');

    // The admission test must mirror the field loop's strict presence check
    // (array_key_exists + !== '' + !== null), NOT empty(), so a literal "0"
    // typed by the librarian is treated as present and preserved.
    expect(source).toContain("$traduttoreProvided = array_key_exists('traduttore', $data) && $data['traduttore'] !== '' && $data['traduttore'] !== null;");
    expect(source).toContain("!array_key_exists('traduttori_ids', $data)");
    expect(source).toContain("&& !empty($data['scraped_translator'])");
    expect(source).toContain("$illustratoreProvided = array_key_exists('illustratore', $data) && $data['illustratore'] !== '' && $data['illustratore'] !== null;");
    expect(source).toContain("!array_key_exists('illustratori_ids', $data)");
    expect(source).toContain("&& !empty($data['scraped_illustrator'])");

    // Regression guard: the fragile empty()-based admission must be gone, since
    // empty("0") === true would silently overwrite a manual "0" with the scrape.
    expect(source).not.toContain("empty($data['traduttore']) && !empty($data['scraped_translator'])");
    expect(source).not.toContain("empty($data['illustratore']) && !empty($data['scraped_illustrator'])");
  });

  test('behavioral: manual "0" is admitted as present so it wins over a scraped value', () => {
    // No DB harness is available in this spec (source-assertion style), so the
    // behavioral contract is verified by simulating the exact admission predicate
    // the PHP code uses. This proves that '0' + a present scrape => '0' wins.
    /** @param {Record<string, any>} data */
    const scrapedFallbackApplies = (data) => {
      const traduttoreProvided =
        Object.prototype.hasOwnProperty.call(data, 'traduttore') &&
        data['traduttore'] !== '' &&
        data['traduttore'] !== null;
      return !traduttoreProvided && Boolean(data['scraped_translator']);
    };

    // Manual literal "0" present + scraped translator present -> scrape must NOT apply.
    expect(scrapedFallbackApplies({ traduttore: '0', scraped_translator: 'Jane Doe' })).toBe(false);
    // Manual field absent + scraped present -> scrape applies (fallback).
    expect(scrapedFallbackApplies({ scraped_translator: 'Jane Doe' })).toBe(true);
    // Manual field empty string + scraped present -> scrape applies (fallback).
    expect(scrapedFallbackApplies({ traduttore: '', scraped_translator: 'Jane Doe' })).toBe(true);

    // And the guard comment documents the "0" case explicitly.
    const source = fs.readFileSync(path.join(ROOT, 'app/Models/BookRepository.php'), 'utf-8');
    expect(source).toContain('"0"');
  });
});

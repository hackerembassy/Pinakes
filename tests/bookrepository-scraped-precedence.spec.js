// @ts-check

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

test.describe('BookRepository optional field precedence', () => {
  test('manual translator and illustrator win over scraped fallbacks', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/Models/BookRepository.php'), 'utf-8');

    expect(source).toContain("empty($data['traduttore']) && !empty($data['scraped_translator'])");
    expect(source).toContain("empty($data['illustratore']) && !empty($data['scraped_illustrator'])");
    expect(source).toContain('Scraped values are only a');
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const filenameSlug = require('./slug.cjs');

const CASES = [
  { input: 'Weekly Sales Report.pdf', expected: 'weekly-sales-report.pdf' },
  { input: ' invoice   copy.txt ', expected: 'invoice-copy.txt' },
  { input: 'photo.JPG', expected: 'photo.jpg' },
];

for (const { input, expected } of CASES) {
  test(`normalizes every whitespace group in ${JSON.stringify(input)}`, () => {
    assert.equal(filenameSlug(input), expected);
  });
}

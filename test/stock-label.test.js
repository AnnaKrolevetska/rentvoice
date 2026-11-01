// Heading above the equipment cards (public/stock-label.js).
// Regression: "Availability for 1 Nov 2026 (undefined day)" when the server
// response had no `source` / `days` fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityLabel, daysInclusive, formatRange } from '../public/stock-label.js';

test('no period chosen → "Availability today"', () => {
  assert.equal(availabilityLabel({ start: '2026-11-01', end: '2026-11-01', source: 'today', days: 1 }), 'Availability today');
});

test('regression: response without source/days never shows "undefined"', () => {
  const stale = { start: '2026-11-01', end: '2026-11-01' }; // what the old server sent
  assert.equal(availabilityLabel(stale, false), 'Availability today');
  const withRange = availabilityLabel({ start: '2026-11-09', end: '2026-11-13' }, true);
  assert.equal(withRange, 'Availability for 9 Nov – 13 Nov 2026 (5 days)');
  for (const s of [stale, {}, null, undefined, { start: 'x', end: 'y', source: 'request' }]) {
    assert.doesNotMatch(availabilityLabel(s, true), /undefined|NaN|null/);
    assert.doesNotMatch(availabilityLabel(s, false), /undefined|NaN|null/);
  }
});

test('one day: singular "1 day"', () => {
  assert.equal(availabilityLabel({ start: '2026-11-05', end: '2026-11-05', source: 'proposal', days: 1 }),
    'Availability for 5 Nov 2026 (1 day)');
});

test('several days: both dates included', () => {
  assert.equal(availabilityLabel({ start: '2026-11-10', end: '2026-11-12', source: 'request' }), 'Availability for 10 Nov – 12 Nov 2026 (3 days)');
  assert.equal(availabilityLabel({ start: '2026-11-05', end: '2026-11-06', source: 'booking' }), 'Availability for 5 Nov – 6 Nov 2026 (2 days)');
});

test('day count is computed from the dates, not trusted from the server', () => {
  // A wrong `days` value from the server must not leak into the heading.
  assert.equal(availabilityLabel({ start: '2026-11-10', end: '2026-11-12', source: 'request', days: 99 }),
    'Availability for 10 Nov – 12 Nov 2026 (3 days)');
});

test('ranges across months and years', () => {
  assert.equal(daysInclusive('2026-11-30', '2026-12-02'), 3);
  assert.equal(daysInclusive('2026-12-30', '2027-01-02'), 4);
  assert.equal(formatRange('2026-12-30', '2027-01-02'), '30 Dec 2026 – 2 Jan 2027');
  assert.equal(daysInclusive('2026-11-12', '2026-11-10'), null); // reversed
  assert.equal(daysInclusive('2026-02-31', '2026-03-01'), null); // impossible date
});

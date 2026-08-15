import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { median, formatMoney, formatDuration, delta } from '../lib/metrics';

describe('median', () => {
  test('odd and even counts', () => {
    assert.equal(median([5]), 5);
    assert.equal(median([1, 3, 5]), 3);
    assert.equal(median([1, 2, 3, 4]), 3); // rounds the midpoint
  });

  test('is not thrown off by one very slow reply', () => {
    // The reason §2.7 asks for median, not mean: one thread the merchant left
    // for a week should not make a fast week look slow.
    assert.equal(median([3, 4, 5, 6, 604_800]), 5);
  });

  test('no data means no number, not zero', () => {
    // Zero would read as "instant", which is a lie.
    assert.equal(median([]), null);
  });

  test('does not mutate its input', () => {
    const input = [3, 1, 2];
    median(input);
    assert.deepEqual(input, [3, 1, 2]);
  });
});

describe('money formatting', () => {
  test('compacts large figures per the stat-tile contract', () => {
    assert.equal(formatMoney(420_000), '$4,200');
    assert.equal(formatMoney(1_500_000), '$15.0K');
    assert.equal(formatMoney(420_000_000), '$4.2M');
  });

  test('rounds away cents at a glanceable size', () => {
    assert.equal(formatMoney(4599), '$46');
  });

  test('uses the merchant currency symbol', () => {
    assert.equal(formatMoney(4500, 'GBP'), '£45');
    assert.equal(formatMoney(4500, 'EUR'), '€45');
  });

  test('zero is a real number, not a dash', () => {
    assert.equal(formatMoney(0), '$0');
  });
});

describe('duration formatting', () => {
  test('says it the way a person would', () => {
    assert.equal(formatDuration(8), '8s');
    assert.equal(formatDuration(90), '2 min');
    assert.equal(formatDuration(5400), '1.5 hr');
    assert.equal(formatDuration(180_000), '2 days');
  });

  test('no data shows a dash, not zero seconds', () => {
    assert.equal(formatDuration(null), '—');
  });
});

describe('week-on-week delta', () => {
  test('reports direction and size', () => {
    assert.deepEqual(delta(150, 100), { pct: 50, direction: 'up', good: true });
    assert.deepEqual(delta(50, 100), { pct: 50, direction: 'down', good: false });
  });

  test('down is the win for response time', () => {
    // Speed is the feature, so a faster week has to read as good news.
    assert.deepEqual(delta(30, 60, true), { pct: 50, direction: 'down', good: true });
    assert.deepEqual(delta(120, 60, true), { pct: 100, direction: 'up', good: false });
  });

  test('no comparison when there is nothing to compare against', () => {
    // A first week has no previous week, and dividing by zero would show ∞%.
    assert.equal(delta(100, 0), null);
    assert.equal(delta(100, null), null);
    assert.equal(delta(null, 100), null);
  });

  test('a flat week reads as flat, not as a rounding artefact', () => {
    assert.deepEqual(delta(100, 100), { pct: 0, direction: 'flat', good: true });
    assert.deepEqual(delta(100, 101), { pct: 1, direction: 'down', good: false });
  });
});

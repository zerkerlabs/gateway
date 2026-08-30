import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UNKNOWN, count, duration, percent, pricing, rateLimit, relative, timestamp, usdc } from './format.js';

// The whole point of this module is that absence never becomes zero, so that
// is what the bulk of these assertions are about.

test('usdc converts smallest-unit strings at six decimals', () => {
  assert.equal(usdc('250000'), '$0.25');
  assert.equal(usdc('50000'), '$0.05');
  assert.equal(usdc('1000000'), '$1.00');
  assert.equal(usdc('1500000000'), '$1,500.00');
  assert.equal(usdc('0'), '$0.00');
});

test('usdc keeps sub-cent precision instead of rounding a price to zero', () => {
  assert.equal(usdc('25'), '$0.000025');
  assert.equal(usdc('1'), '$0.000001');
});

test('usdc reports absent or malformed amounts as unknown, never as zero', () => {
  assert.equal(usdc(null), UNKNOWN);
  assert.equal(usdc(undefined), UNKNOWN);
  assert.equal(usdc(''), UNKNOWN);
  assert.equal(usdc('not-a-number'), UNKNOWN);
  assert.equal(usdc('-1'), UNKNOWN);
});

test('usdc labels a non-USDC asset rather than assuming a dollar sign', () => {
  assert.equal(usdc('250000', 'EURC'), '0.25 EURC');
});

test('duration scales its unit and rejects absent values', () => {
  assert.equal(duration(680), '680ms');
  assert.equal(duration(1200), '1.2s');
  assert.equal(duration(10_000), '10s');
  assert.equal(duration(90_000), '1m 30s');
  assert.equal(duration(null), UNKNOWN);
  assert.equal(duration(undefined), UNKNOWN);
  assert.equal(duration(Number.NaN), UNKNOWN);
});

test('count formats known numbers and refuses to invent a zero', () => {
  assert.equal(count(1256), '1,256');
  assert.equal(count(0), '0');
  assert.equal(count(null), UNKNOWN);
  assert.equal(count(undefined), UNKNOWN);
});

test('percent separates unknown, empty, and a real ratio', () => {
  assert.equal(percent(4, 486), '0.8%');
  assert.equal(percent(50, 100), '50%');
  assert.equal(percent(0, 100), '0.0%');
  // A known-zero denominator has no ratio; saying "0%" would read as a clean
  // window rather than an empty one.
  assert.equal(percent(0, 0), 'No calls');
  assert.equal(percent(null, 100), UNKNOWN);
  assert.equal(percent(4, null), UNKNOWN);
});

test('percent does not round a real failure rate away to zero', () => {
  assert.equal(percent(1, 100_000), '<0.1%');
});

test('timestamp and relative report absent input as unknown', () => {
  assert.equal(timestamp(null), UNKNOWN);
  assert.equal(timestamp('not-a-date'), UNKNOWN);
  assert.equal(relative(null), UNKNOWN);
  assert.equal(relative('not-a-date'), UNKNOWN);
});

test('relative buckets recent times and falls back to a date past a week', () => {
  const now = Date.parse('2026-08-18T09:12:00Z');
  assert.equal(relative('2026-08-18T09:11:30Z', now), 'just now');
  assert.equal(relative('2026-08-18T09:09:00Z', now), '3m ago');
  assert.equal(relative('2026-08-18T06:12:00Z', now), '3h ago');
  assert.equal(relative('2026-08-16T09:12:00Z', now), '2d ago');
  assert.equal(relative('2026-06-01T09:12:00Z', now), timestamp('2026-06-01T09:12:00Z'));
});

test('an absent rate limit is the process default, not unlimited', () => {
  assert.equal(rateLimit(2, 20), '2/s · burst 20');
  assert.equal(rateLimit(0.5, 10), '30/min · burst 10');
  assert.equal(rateLimit(4, null), '4/s');
  assert.equal(rateLimit(null, null), 'Process default');
});

test('pricing states the gate is off rather than reporting unknown', () => {
  assert.equal(pricing(null), 'No payment gate');
  assert.equal(pricing({ amount: '250000', asset: 'USDC' }), '$0.25 / call');
  assert.equal(
    pricing({ amount: '250000', asset: 'USDC', tools: { 'research.report': '500000' } }),
    '$0.25 / call · 1 tool override',
  );
  assert.equal(
    pricing({ amount: '50000', asset: 'USDC', tools: { a: '1', b: '2' } }),
    '$0.05 / call · 2 tool overrides',
  );
});

'use strict';

/**
 * Unit tests for rationalize() — the core trade-ratio function.
 * Run with: npm test
 */

const assert = require('assert');
const { rationalize, rationalizeRealistic } = require('../src/arbitrage');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function approx(actual, expected, tol = 0.002) {
  return Math.abs(actual - expected) <= tol;
}

console.log('\nrationalize()');

// ── Integer rates ─────────────────────────────────────────────────────────────
test('rate=1 → {p:1, q:1}', () => {
  const r = rationalize(1);
  assert.strictEqual(r.p, 1); assert.strictEqual(r.q, 1);
});
test('rate=5 → {p:5, q:1}', () => {
  const r = rationalize(5);
  assert.strictEqual(r.p, 5); assert.strictEqual(r.q, 1);
});
test('rate=19 → {p:19, q:1}', () => {
  const r = rationalize(19);
  assert.strictEqual(r.p, 19); assert.strictEqual(r.q, 1);
});

// ── Simple fractions ──────────────────────────────────────────────────────────
test('rate=0.5 → {p:1, q:2}', () => {
  const r = rationalize(0.5);
  assert.strictEqual(r.p, 1); assert.strictEqual(r.q, 2);
});
test('rate=1/3 → {p:1, q:3}', () => {
  const r = rationalize(1 / 3);
  assert.strictEqual(r.p, 1); assert.strictEqual(r.q, 3);
});
test('rate=2/3 → {p:2, q:3}', () => {
  const r = rationalize(2 / 3);
  assert.strictEqual(r.p, 2); assert.strictEqual(r.q, 3);
});
test('rate=1/20 (0.05) → {p:1, q:20}', () => {
  const r = rationalize(0.05, 200);
  assert.strictEqual(r.p, 1); assert.strictEqual(r.q, 20);
});

// ── Small rates (previously broken with maxD=20) ──────────────────────────────
test('rate=0.006681 with maxD=200 → p>0, q>0, close approximation', () => {
  const r = rationalize(0.006681, 200);
  assert.ok(r.p > 0, `expected p>0, got ${r.p}`);
  assert.ok(r.q > 0, `expected q>0, got ${r.q}`);
  assert.ok(r.q <= 200, `q=${r.q} exceeds maxD=200`);
  assert.ok(approx(r.p / r.q, 0.006681, 0.002), `p/q=${r.p}/${r.q}=${r.p / r.q} too far from 0.006681`);
});
test('rate=0.0125 (1/80) → p:1, q:80', () => {
  const r = rationalize(0.0125, 200);
  assert.strictEqual(r.p, 1);
  assert.strictEqual(r.q, 80);
});

// ── maxD enforcement ──────────────────────────────────────────────────────────
test('q never exceeds maxD across varied rates', () => {
  const rates = [0.1234, 0.0071, 3.141, 0.333333, 17.7777, 0.006, 0.999];
  for (const rate of rates) {
    const r = rationalize(rate, 50);
    assert.ok(r.q <= 50, `rate=${rate}: q=${r.q} exceeds maxD=50`);
  }
});
test('maxD=20 still works for simple fractions', () => {
  const r = rationalize(0.05, 20);
  assert.strictEqual(r.p, 1);
  assert.strictEqual(r.q, 20);
});

// ── Output always valid positive integers ─────────────────────────────────────
test('p and q are positive integers for typical real rates', () => {
  const rates = [0.05, 0.2, 1.5, 3.0, 18.5, 0.0534, 52.3];
  for (const rate of rates) {
    const r = rationalize(rate, 200);
    assert.ok(Number.isInteger(r.p) && r.p > 0, `rate=${rate}: p=${r.p} not positive integer`);
    assert.ok(Number.isInteger(r.q) && r.q > 0, `rate=${rate}: q=${r.q} not positive integer`);
  }
});

// ── Edge / degenerate inputs ──────────────────────────────────────────────────
test('rate=0 → returns finite, non-crashing ratio', () => {
  const r = rationalize(0);
  assert.ok(Number.isFinite(r.p) && Number.isFinite(r.q));
  assert.ok(r.q > 0);
});
test('rate=Infinity → returns finite ratio', () => {
  const r = rationalize(Infinity);
  assert.ok(isFinite(r.p) && isFinite(r.q));
});
test('rate=-1 (negative) → returns finite ratio without crashing', () => {
  const r = rationalize(-1);
  assert.ok(isFinite(r.p) && isFinite(r.q));
});
test('rate=NaN → returns finite ratio without crashing', () => {
  const r = rationalize(NaN);
  assert.ok(isFinite(r.p) && isFinite(r.q));
});

// ── Round-trip accuracy ───────────────────────────────────────────────────────
test('p/q is always close to input rate (within 1%)', () => {
  const rates = [0.05, 0.1, 0.25, 0.333, 0.5, 2.0, 5.0, 10.0, 19.8];
  for (const rate of rates) {
    const r = rationalize(rate, 200);
    const reproduced = r.p / r.q;
    const relErr = Math.abs(reproduced - rate) / rate;
    assert.ok(relErr < 0.01, `rate=${rate}: p/q=${reproduced} has ${(relErr*100).toFixed(2)}% error`);
  }
});

// ── rationalizeRealistic ──────────────────────────────────────────────────────
console.log('\nrationalizeRealistic()');

test('Chaos→Divine (rate≈0.00667): finds p=1, small q', () => {
  const r = rationalizeRealistic(0.006671, 200);
  assert.ok(r !== null, 'should find a ratio');
  assert.strictEqual(r.p, 1, 'numerator should be 1');
  assert.ok(r.q >= 100 && r.q <= 200, `q=${r.q} should be 100-200`);
  // Result must be within 2% of actual rate
  assert.ok(Math.abs(r.p / r.q - 0.006671) / 0.006671 <= 0.02);
});

test('150 Chaos for 1 Divine (rate≈149.9)', () => {
  const r = rationalizeRealistic(149.9, 200);
  assert.ok(r !== null);
  assert.strictEqual(r.p, 150);
  assert.strictEqual(r.q, 1);
});

test('prefers simple fraction — 1:2 over 499:998', () => {
  const r = rationalizeRealistic(0.5, 200);
  assert.ok(r !== null);
  assert.strictEqual(r.q, 2); // simplest denominator
});

test('returns null for extreme rate (17301 — PoT vs Divine)', () => {
  // Rate of ~17000 requires p>1000 for any q≤200 — should be skipped
  const r = rationalizeRealistic(17301, 200, 0.02, 1000);
  assert.strictEqual(r, null);
});

test('returns null when no fraction within tolerance exists', () => {
  // Rate 0.0000578 — too small for maxD=200 to represent within 2%
  const r = rationalizeRealistic(0.0000578, 200);
  assert.strictEqual(r, null);
});

test('p never exceeds maxP', () => {
  const rates = [500, 1000, 5000, 150, 75, 0.5, 0.1];
  for (const rate of rates) {
    const r = rationalizeRealistic(rate, 200, 0.02, 1000);
    if (r !== null) {
      assert.ok(r.p <= 1000, `p=${r.p} exceeds maxP for rate=${rate}`);
    }
  }
});

test('result is within 2% of target rate', () => {
  const rates = [0.006671, 149.9, 12.5, 0.5, 1/3, 2/3];
  for (const rate of rates) {
    const r = rationalizeRealistic(rate, 200);
    if (r !== null) {
      const actual = r.p / r.q;
      const relErr = Math.abs(actual - rate) / rate;
      assert.ok(relErr <= 0.02, `rate=${rate}: error ${(relErr*100).toFixed(2)}% > 2%`);
    }
  }
});

test('returns null for zero and negative rates', () => {
  assert.strictEqual(rationalizeRealistic(0), null);
  assert.strictEqual(rationalizeRealistic(-5), null);
  assert.strictEqual(rationalizeRealistic(NaN), null);
  assert.strictEqual(rationalizeRealistic(Infinity), null);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

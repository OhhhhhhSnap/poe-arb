'use strict';

/**
 * Unit tests for find3HopOpportunities() and the merged arbitrage engine.
 * Run with: node test/threehop.test.js
 */

const assert = require('assert');
const { findArbitrageOpportunities, find3HopOpportunities } = require('../src/arbitrage');

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal poe.ninja-shaped data object from a rate map.
 * rates: { 'Chaos Orb': 0.05, 'Exalted Orb': 0.2, ... }  (all relative to divine = 1.0)
 * volumes: { 'Chaos Orb': 50, ... }
 */
function makeData(rates, volumes = {}) {
  const lines = Object.entries(rates).map(([name, primaryValue]) => ({
    id: name,
    primaryValue,
    volumePrimaryValue: volumes[name] ?? 10,
    sparkline: { totalChange: 0, data: [0, 0, 0, 0, 0, 0, 0] },
  }));
  const items = Object.keys(rates).map(name => ({ id: name, name, image: '' }));
  return { lines, items, core: { items: [], rates: [] } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\nfind3HopOpportunities()');

test('returns an array', () => {
  const data = makeData({ 'Chaos Orb': 0.05, 'Exalted Orb': 0.2, 'Orb of Alteration': 0.01 });
  const result = find3HopOpportunities(data);
  assert.ok(Array.isArray(result));
});

test('each result has type === "3hop"', () => {
  const data = makeData({ A: 0.1, B: 0.3, C: 0.2 });
  const result = find3HopOpportunities(data);
  for (const op of result) {
    assert.strictEqual(op.type, '3hop');
  }
});

test('each result has required fields', () => {
  const data = makeData({ A: 0.1, B: 0.3, C: 0.2 });
  const result = find3HopOpportunities(data);
  if (result.length === 0) return; // no profitable cycle found — still passes
  const op = result[0];
  assert.ok('fromCurrency'   in op, 'fromCurrency missing');
  assert.ok('viaCurrency'    in op, 'viaCurrency missing');
  assert.ok('viaCurrency2'   in op, 'viaCurrency2 missing');
  assert.ok('actualMarginPct' in op, 'actualMarginPct missing');
  assert.ok('minLot'         in op, 'minLot missing');
  assert.ok('returnAmount'   in op, 'returnAmount missing');
  assert.ok('cAmount'        in op, 'cAmount missing');
  assert.ok('step1'          in op, 'step1 missing');
  assert.ok('step2'          in op, 'step2 missing');
  assert.ok('step3'          in op, 'step3 missing');
});

test('detects a known profitable 3-hop cycle', () => {
  // Construct rates so that A→B→C→A should yield >0 margin:
  // A=1.0 (divine), B has primaryValue=0.5 (so 1A buys 2B),
  // C has primaryValue=0.25 (so 2B buys 8C),
  // 8C back to A: 8 * 0.25/1.0 = 2A → 100% theoretical margin
  const data = makeData({ B: 0.5, C: 0.25 }, { B: 5, C: 5 });
  const result = find3HopOpportunities(data, { minMarginPct: -100 });
  // There should be at least one cycle involving divine, B, C
  assert.ok(result.length > 0, 'expected at least one 3-hop cycle');
});

test('returnAmount is always a positive integer', () => {
  const data = makeData({ X: 0.07, Y: 0.13, Z: 0.22 });
  const result = find3HopOpportunities(data);
  for (const op of result) {
    assert.ok(Number.isInteger(op.returnAmount), `returnAmount ${op.returnAmount} not integer`);
    assert.ok(op.returnAmount > 0, `returnAmount ${op.returnAmount} not positive`);
  }
});

test('minLot (q1) never exceeds maxLotSize', () => {
  const data = makeData({ A: 0.05, B: 0.1, C: 0.15 });
  const maxLotSize = 50;
  const result = find3HopOpportunities(data, { maxLotSize });
  for (const op of result) {
    assert.ok(op.minLot <= maxLotSize, `minLot ${op.minLot} exceeds maxLotSize ${maxLotSize}`);
  }
});

test('minMarginPct filter correctly excludes low-margin results', () => {
  const data = makeData({ A: 0.1, B: 0.2, C: 0.15 });
  const minMarginPct = 5;
  const result = find3HopOpportunities(data, { minMarginPct });
  for (const op of result) {
    assert.ok(op.actualMarginPct >= minMarginPct,
      `actualMarginPct ${op.actualMarginPct} below minMarginPct ${minMarginPct}`);
  }
});

test('deduplication: sorted triple appears at most once', () => {
  const data = makeData({ P: 0.1, Q: 0.3, R: 0.2 });
  const result = find3HopOpportunities(data);
  const seen = new Set();
  for (const op of result) {
    const key = [op.fromCurrency, op.viaCurrency, op.viaCurrency2].sort().join('|||');
    assert.ok(!seen.has(key), `duplicate key: ${key}`);
    seen.add(key);
  }
});

test('cAmount is positive integer', () => {
  const data = makeData({ A: 0.05, B: 0.1, C: 0.15 });
  const result = find3HopOpportunities(data);
  for (const op of result) {
    assert.ok(Number.isInteger(op.cAmount), `cAmount ${op.cAmount} not integer`);
    assert.ok(op.cAmount > 0, `cAmount ${op.cAmount} not positive`);
  }
});

test('step strings reference correct currencies', () => {
  const data = makeData({ X: 0.1, Y: 0.3, Z: 0.2 });
  const result = find3HopOpportunities(data);
  for (const op of result) {
    assert.ok(op.step1.includes(op.fromCurrency), `step1 missing fromCurrency`);
    assert.ok(op.step1.includes(op.viaCurrency),  `step1 missing viaCurrency`);
    assert.ok(op.step2.includes(op.viaCurrency),  `step2 missing viaCurrency`);
    assert.ok(op.step2.includes(op.viaCurrency2), `step2 missing viaCurrency2`);
    assert.ok(op.step3.includes(op.viaCurrency2), `step3 missing viaCurrency2`);
    assert.ok(op.step3.includes(op.fromCurrency), `step3 missing fromCurrency`);
  }
});

console.log('\nfindArbitrageOpportunities() — merged 2+3 hop');

test('merged results contain both 2hop and 3hop types', () => {
  const data = makeData({ A: 0.1, B: 0.3, C: 0.2 }, { A: 5, B: 5, C: 5 });
  const result = findArbitrageOpportunities(data, { minMarginPct: -100 });
  const types = new Set(result.map(r => r.type));
  // With 3+ currencies there should be both types (2-hop pairs + 3-hop cycles)
  assert.ok(types.has('2hop'), 'expected 2hop results');
  assert.ok(types.has('3hop'), 'expected 3hop results');
});

test('merged results are sorted by actualMarginPct descending', () => {
  const data = makeData({ A: 0.1, B: 0.3, C: 0.2 });
  const result = findArbitrageOpportunities(data, { minMarginPct: -100 });
  for (let i = 1; i < result.length; i++) {
    assert.ok(
      result[i].actualMarginPct <= result[i - 1].actualMarginPct,
      `not sorted at index ${i}`
    );
  }
});

test('merged results capped at 50', () => {
  // Build a data set with many currencies to generate many results
  const rates = {};
  for (let i = 0; i < 15; i++) rates[`Curr${i}`] = 0.01 * (i + 1);
  const data = makeData(rates);
  const result = findArbitrageOpportunities(data, { minMarginPct: -100 });
  assert.ok(result.length <= 50, `expected ≤50, got ${result.length}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

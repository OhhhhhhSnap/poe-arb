'use strict';

/**
 * Arbitrage engine for PoE2 currency exchange.
 */

// Stern-Brocot: most mathematically precise fraction with denominator ≤ maxD.
// Kept for unit tests and as a fallback — NOT used for actual arbitrage.
function rationalize(rate, maxD = 200) {
  if (!isFinite(rate) || rate <= 0) return { p: 1, q: 1 };
  if (Number.isInteger(rate) && rate <= maxD) return { p: rate, q: 1 };

  let p0 = 0, q0 = 1;
  let p1 = 1, q1 = 0;

  while (true) {
    const medP = p0 + p1;
    const medQ = q0 + q1;
    if (medQ > maxD) {
      const err0 = Math.abs(rate - p0 / q0);
      const err1 = Math.abs(rate - p1 / q1);
      return err0 <= err1 ? { p: p0, q: q0 } : { p: p1, q: q1 };
    }
    const medVal = medP / medQ;
    if (Math.abs(rate - medVal) < 1e-9) return { p: medP, q: medQ };
    if (rate < medVal) { p1 = medP; q1 = medQ; }
    else               { p0 = medP; q0 = medQ; }
  }
}

/**
 * Realistic ratio finder for PoE2 exchange offers.
 *
 * Players post offers with simple integer ratios — "1 Divine for 150 Chaos",
 * not "7 Divine for 1049 Chaos". This finds the SMALLEST denominator q such that
 * round(rate * q) / q is within `tol` of `rate` AND the resulting numerator p
 * doesn't exceed `maxP` (no one has 1000+ of an expensive currency in one trade).
 *
 * Returns null if no realistic ratio exists — the pair should be skipped.
 *
 * @param {number} rate
 * @param {number} maxD      Max denominator (lot size cap), default 200
 * @param {number} tol       Relative tolerance, default 0.02 (2%)
 * @param {number} maxP      Max numerator (receive side), default 1000
 * @returns {{ p: number, q: number } | null}
 */
function rationalizeRealistic(rate, maxD = 200, tol = 0.02, maxP = 1000) {
  if (!isFinite(rate) || rate <= 0) return null;
  for (let q = 1; q <= maxD; q++) {
    const p = Math.round(rate * q);
    if (p <= 0 || p > maxP) continue;
    if (Math.abs(p / q - rate) / rate <= tol) {
      return { p, q };
    }
  }
  return null; // No realistic ratio found — skip this pair
}

function buildGraph(data, { minVolumeDivine = 1.0 } = {}) {
  const graph    = new Map();
  const lines    = data.lines ?? [];
  const allItems = [...(data.items ?? []), ...(data.core?.items ?? [])];

  const idToName = new Map();
  const idToIcon = new Map();
  for (const item of allItems) {
    if (item.id) {
      if (item.name)  idToName.set(item.id, item.name);
      if (item.image) idToIcon.set(item.id, 'https://web.poecdn.com' + item.image);
    }
  }
  if (!idToName.has('divine')) idToName.set('divine', 'Divine Orb');

  const idToRate         = new Map([['divine', 1.0]]);
  const volumeMap        = new Map([['divine', Infinity]]);
  const sparklineTotMap  = new Map();
  const sparklineDataMap = new Map();

  for (const line of lines) {
    if (!line.id) continue;
    if (typeof line.primaryValue === 'number' && line.primaryValue > 0)
      idToRate.set(line.id, line.primaryValue);
    volumeMap.set(line.id, line.volumePrimaryValue ?? 0);
    if (line.sparkline) {
      sparklineTotMap.set(line.id,  line.sparkline.totalChange ?? 0);
      sparklineDataMap.set(line.id, line.sparkline.data ?? []);
    }
  }

  const liquidIds = new Set(['divine']);
  for (const line of lines) {
    if (line.id && (line.volumePrimaryValue ?? 0) >= minVolumeDivine)
      liquidIds.add(line.id);
  }

  const addEdge = (from, to, rate) => {
    if (!isFinite(rate) || rate <= 0) return;
    if (!graph.has(from)) graph.set(from, new Map());
    graph.get(from).set(to, rate);
  };

  const ids = Array.from(liquidIds).filter(id => idToRate.has(id));
  for (const idA of ids) {
    for (const idB of ids) {
      if (idA === idB) continue;
      addEdge(idToName.get(idA) ?? idA, idToName.get(idB) ?? idB,
              idToRate.get(idA) / idToRate.get(idB));
    }
  }

  // Build name-keyed lookup maps for results
  const volumeByName        = new Map();
  const sparklineTotByName  = new Map();
  const sparklineDataByName = new Map();
  const iconByName          = new Map();

  for (const [id] of idToRate) {
    const name = idToName.get(id) ?? id;
    volumeByName.set(name,        volumeMap.get(id)        ?? 0);
    sparklineTotByName.set(name,  sparklineTotMap.get(id)  ?? 0);
    sparklineDataByName.set(name, sparklineDataMap.get(id) ?? []);
    if (idToIcon.has(id)) iconByName.set(name, idToIcon.get(id));
  }

  return { graph, volumeByName, sparklineTotByName, sparklineDataByName, iconByName };
}

function findArbitrageOpportunities(data, settings = {}) {
  const {
    minVolumeDivine  = 1.0,
    maxLotSize       = 200,
    minMarginPct     = -100,
    maxSparklineDrop = -50,
  } = settings;

  const { graph, volumeByName, sparklineTotByName, sparklineDataByName, iconByName } =
    buildGraph(data, { minVolumeDivine });

  const currencies = Array.from(graph.keys());
  const raw = [];

  for (const a of currencies) {
    const fromA = graph.get(a);
    if (!fromA) continue;

    for (const [b, rateAB] of fromA.entries()) {
      const fromB = graph.get(b);
      if (!fromB) continue;
      const rateBA = fromB.get(a);
      if (!rateBA) continue;

      const volB   = volumeByName.get(b)       ?? 0;
      const sparkB = sparklineTotByName.get(b)  ?? 0;
      const sparkA = sparklineTotByName.get(a)  ?? 0;
      if (volB  < minVolumeDivine)   continue;
      if (sparkB < maxSparklineDrop) continue;
      if (sparkA < maxSparklineDrop) continue; // skip if the base currency is crashing too

      const r1 = rationalizeRealistic(rateAB, maxLotSize);
      const r2 = rationalizeRealistic(rateBA, maxLotSize);
      if (!r1 || !r2) continue; // no realistic trade ratio exists for this pair
      const { p: p1, q: q1 } = r1;
      const { p: p2, q: q2 } = r2;

      const aBack             = Math.floor(p1 * p2 / q2);
      const actualReturn      = aBack / q1;
      const actualMarginPct   = (actualReturn - 1) * 100;
      const theoreticalReturn = rateAB * rateBA;

      if (actualMarginPct < minMarginPct) continue;

      raw.push({
        type: '2hop',
        fromCurrency:    a,
        viaCurrency:     b,
        iconA:           iconByName.get(a) ?? '',
        iconB:           iconByName.get(b) ?? '',
        rateAB,
        rateBA,
        theoreticalMarginPct: (theoreticalReturn - 1) * 100,
        actualMarginPct,
        minLot:          q1,
        returnAmount:    aBack,   // explicit field — avoids fragile string splitting
        volumeB:         volB,
        sparklineB:      sparkB,
        sparklineDataB:  sparklineDataByName.get(b) ?? [],
        step1: `${q1} ${a} → ${p1} ${b}`,
        step2: `${p1} ${b} → ${aBack} ${a}`,
        score: actualMarginPct,
      });
    }
  }

  const best = new Map();
  for (const op of raw) {
    const key = [op.fromCurrency, op.viaCurrency].sort().join('|||');
    if (!best.has(key) || op.actualMarginPct > best.get(key).actualMarginPct)
      best.set(key, op);
  }

  const twoHop = Array.from(best.values());

  // ── 3-hop ────────────────────────────────────────────────────────────────
  const threeHop = find3HopOpportunities(
    data, settings,
    { graph, volumeByName, sparklineTotByName, sparklineDataByName, iconByName }
  );

  const all = [...twoHop, ...threeHop];
  all.sort((a, b) => b.actualMarginPct - a.actualMarginPct);
  return all.slice(0, 50);
}

// ── 3-hop cycle detection: A → B → C → A ─────────────────────────────────────
function find3HopOpportunities(data, settings = {}, prebuilt = null) {
  const {
    minVolumeDivine  = 1.0,
    maxLotSize       = 200,
    minMarginPct     = -100,
    maxSparklineDrop = -50,
  } = settings;

  const { graph, volumeByName, sparklineTotByName, sparklineDataByName, iconByName } =
    prebuilt ?? buildGraph(data, { minVolumeDivine });

  // Limit to top-30 by volume to keep O(N³) manageable (≤27,000 triples)
  const ranked = Array.from(graph.keys())
    .map(c => ({ c, vol: volumeByName.get(c) ?? 0 }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 30)
    .map(x => x.c);

  const raw = [];

  for (const a of ranked) {
    const fromA = graph.get(a);
    if (!fromA) continue;
    if ((sparklineTotByName.get(a) ?? 0) < maxSparklineDrop) continue;

    for (const [b, rateAB] of fromA.entries()) {
      if (!ranked.includes(b)) continue;
      const fromB = graph.get(b);
      if (!fromB) continue;
      if ((sparklineTotByName.get(b) ?? 0) < maxSparklineDrop) continue;

      const r1 = rationalizeRealistic(rateAB, maxLotSize);
      if (!r1) continue;
      const { p: p1, q: q1 } = r1;

      for (const [c, rateBC] of fromB.entries()) {
        if (c === a || !ranked.includes(c)) continue;
        const fromC = graph.get(c);
        if (!fromC) continue;
        const rateCA = fromC.get(a);
        if (!rateCA) continue;
        if ((sparklineTotByName.get(c) ?? 0) < maxSparklineDrop) continue;

        const r2 = rationalizeRealistic(rateBC, maxLotSize);
        if (!r2) continue;
        const { p: p2, q: q2 } = r2;
        const r3 = rationalizeRealistic(rateCA, maxLotSize);
        if (!r3) continue;
        const { p: p3, q: q3 } = r3;

        // Floor-arithmetic simulation of the 3-leg trade
        const cAmount = Math.floor(p1 * p2 / q2);
        if (cAmount <= 0) continue;
        const aBack = Math.floor(cAmount * p3 / q3);
        if (aBack <= 0) continue;

        const actualMarginPct = (aBack / q1 - 1) * 100;
        if (actualMarginPct < minMarginPct) continue;

        raw.push({
          type:           '3hop',
          fromCurrency:   a,
          viaCurrency:    b,
          viaCurrency2:   c,
          iconA:          iconByName.get(a) ?? '',
          iconB:          iconByName.get(b) ?? '',
          iconC:          iconByName.get(c) ?? '',
          rateAB, rateBC, rateCA,
          theoreticalMarginPct: (rateAB * rateBC * rateCA - 1) * 100,
          actualMarginPct,
          minLot:         q1,
          returnAmount:   aBack,
          cAmount,
          volumeB:        volumeByName.get(b) ?? 0,
          volumeC:        volumeByName.get(c) ?? 0,
          sparklineB:     sparklineTotByName.get(b) ?? 0,
          sparklineDataB: sparklineDataByName.get(b) ?? [],
          step1: `${q1} ${a} → ${p1} ${b}`,
          step2: `${p1} ${b} → ${cAmount} ${c}`,
          step3: `${cAmount} ${c} → ${aBack} ${a}`,
          score: actualMarginPct,
        });
      }
    }
  }

  // Deduplicate: per sorted triple, keep highest margin rotation
  const best = new Map();
  for (const op of raw) {
    const key = [op.fromCurrency, op.viaCurrency, op.viaCurrency2].sort().join('|||');
    if (!best.has(key) || op.actualMarginPct > best.get(key).actualMarginPct)
      best.set(key, op);
  }

  return Array.from(best.values());
}

module.exports = { findArbitrageOpportunities, find3HopOpportunities, rationalize, rationalizeRealistic };

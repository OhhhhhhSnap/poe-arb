'use strict';

/**
 * poe.ninja API client for PoE2 currency exchange.
 *
 * PoE2 currency exchange endpoint:
 *   GET https://poe.ninja/poe2/api/economy/exchange/current/overview
 *       ?league=<name>&type=Currency
 *
 * Response shape:
 *   {
 *     lines: [
 *       {
 *         id: "exalted",                  // internal currency id
 *         primaryValue: 0.053,            // value in divine orbs (divine = 1.0)
 *         volumePrimaryValue: 42.3,       // daily trading volume in divine-equivalent
 *         sparkline: {
 *           totalChange: -4.2,            // 7-day % change
 *           data: [0, -1.2, -2.0, ...]    // 7 cumulative % change points
 *         },
 *         maxVolumeCurrency: "divine",
 *         maxVolumeRate: 18.8
 *       }, ...
 *     ],
 *     items: [
 *       { id: "exalted", name: "Exalted Orb", image: "/gen/image/..." }, ...
 *     ],
 *     core: { items: [...], rates: {...} }
 *   }
 *
 * All rates are anchored to divine orb (primaryValue = 1.0 for divine).
 * Cross-rate: rate(A→B) = primaryValue[A] / primaryValue[B]
 */

const https = require('https');

const POE2_CURRENCY_URL  = 'https://poe.ninja/poe2/api/economy/exchange/current/overview';
const POE2_LEAGUES_URL   = 'https://poe.ninja/poe2/api/leagues';
const USER_AGENT         = 'poe-arb/2.0 (github.com/ohhhhhhsnap/poe-arb)';
const TIMEOUT_MS         = 12000;
const MAX_RETRIES        = 2;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB safety cap

function httpGet(url, params) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    for (const [k, v] of Object.entries(params ?? {})) {
      urlObj.searchParams.set(k, v);
    }

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    };

    const req = https.get(options, (res) => {
      const chunks = [];
      let totalBytes = 0;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new Error(`Response too large (>${MAX_RESPONSE_BYTES / 1e6} MB)`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode} from poe.ninja`));
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Request timed out after ' + TIMEOUT_MS + 'ms'));
    });

    req.on('error', reject);
  });
}

async function httpGetWithRetry(url, params, retries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpGet(url, params);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = 1500 * (attempt + 1);
        await new Promise(r => setTimeout(r, delay));
        console.log(`[ninja] Retry ${attempt + 1}/${retries}: ${err.message}`);
      }
    }
  }
  throw lastErr;
}

/**
 * Fetch PoE2 currency exchange rates from poe.ninja.
 * Returns the raw API response object (see JSDoc above for shape).
 */
async function fetchPoe2Currency(league) {
  console.log(`[ninja] Fetching PoE2 currency for league="${league}"`);
  const data = await httpGetWithRetry(POE2_CURRENCY_URL, { league, type: 'Currency' });
  const lineCount = data.lines?.length ?? 0;
  console.log(`[ninja] OK — ${lineCount} exchange entries`);
  return data;
}

/**
 * Discover active PoE2 leagues by probing the currency endpoint.
 * The /leagues API endpoint no longer exists as of 0.5, so we probe a known
 * list of league names and return the ones that have actual data.
 * Falls back to an empty array on total failure (caller uses hardcoded list).
 */
const PROBE_LEAGUES = [
  'Runes of Aldur', 'HC Runes of Aldur',
  'Return of the Ancients', 'HC Return of the Ancients',
  'Mercenaries', 'HC Mercenaries',
  'Dawn of the Hunt', 'HC Dawn of the Hunt',
  'Standard', 'Hardcore',
];

async function fetchPoe2Leagues() {
  try {
    const results = await Promise.all(
      PROBE_LEAGUES.map(async (name) => {
        try {
          const url = `${POE2_CURRENCY_URL}?league=${encodeURIComponent(name)}&type=Currency`;
          const data = await httpGetWithRetry(url, {});
          const hasData = (data.lines?.length ?? 0) > 0;
          return hasData ? name : null;
        } catch {
          return null;
        }
      })
    );
    const active = results.filter(Boolean);
    console.log(`[ninja] Active leagues: ${active.join(', ') || 'none found'}`);
    return active;
  } catch (err) {
    console.warn('[ninja] Could not probe league list:', err.message);
    return [];
  }
}

module.exports = { fetchPoe2Currency, fetchPoe2Leagues };

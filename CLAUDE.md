# poe-arb

Path of Exile currency arbitrage detector. Fetches live exchange rates from poe.ninja, finds profitable multi-hop trading cycles (e.g., Divine → Essence → Scarab → Divine), and displays them in a web UI with optional Discord alerts and an Electron in-game overlay.

## How to run

```bash
# Docker (recommended)
make run          # build & start on port 5001
make logs         # tail container logs
make stop

# Local dev
pip install -r requirements.txt
cp .env.example .env
python app.py     # http://localhost:5001
```

## Key modules

| File | Purpose |
|------|---------|
| `app.py` | Flask server, APScheduler background refresh, all API routes |
| `ninja_client.py` | poe.ninja HTTP client — fetching, parsing, rate-limit cache |
| `arbitrage.py` | DFS cycle detection, margin calc, confidence scoring |
| `config.py` | Env-based config, runtime updates via `POST /api/config` |
| `notifier.py` | Discord webhook sender |
| `flip_tracker.py` | In-memory trade log |
| `static/` | Single-page web UI (vanilla JS) |
| `overlay/` | Electron in-game overlay (Node.js) |

## Configuration (`.env`)

```
GAME_VERSION=poe2               # poe2 | poe1
LEAGUE_NAME=Return of the Ancients
REFRESH_INTERVAL_SECONDS=60
MIN_MARGIN_PCT=3.0
MIN_ABSOLUTE_PROFIT_CHAOS=5.0
MIN_VOLUME=10
MAX_HOP_DEPTH=4
DISCORD_WEBHOOK_URL=            # optional
NOTIFY_MIN_MARGIN_PCT=5.0
BIND_ALL_INTERFACES=true        # expose on 0.0.0.0 for LAN/Pi access
```

## poe.ninja API endpoints

All requests include `User-Agent: poe-arb/1.0 (github.com/ohhhhhhsnap/poe-arb)`.

| Endpoint | Params |
|----------|--------|
| `https://poe.ninja/poe2/api/economy/exchange/current/overview` | `league=<name>&type=Currency` |
| `https://poe.ninja/poe2/api/economy/item/overview` | `league=<name>&type=<category>` |
| `https://poe.ninja/api/data/currencyoverview` | `league=<name>&type=Currency` |
| `https://poe.ninja/api/data/itemoverview` | `league=<name>&type=<category>` |

**Parameter note:** PoE2 endpoints use `league=` (not `leagueName=`). PoE1 endpoints also use `league=`. A prior bug used `leagueName=` and `overviewName=` for PoE2 — these cause 403s.

Rate limiting: 30s minimum between refreshes per cache key; retries on 429 with 2s/4s/8s backoff.

## API routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/opportunities` | GET | Active cycles with margin, path, confidence |
| `/api/config` | GET/POST | Read or update config at runtime |
| `/api/refresh` | GET | Force immediate poe.ninja refresh |
| `/api/leagues` | GET | Available leagues for current game version |
| `/api/flips` | GET/POST/DELETE | Trade log + session profit |
| `/api/status` | GET | Server health, LAN IP, demo mode |

## Arbitrage algorithm

1. Build directed graph: nodes = currencies, edges = exchange rates
2. Edge weight: `sell[A] / buy[B]` (profit when A→B via chaos)
3. DFS from each node looking for cycles with ≥ 2 hops
4. Margin = product of edge weights − 1.0
5. Deduplicate by rotating cycle to lexicographically smallest start
6. Confidence: high (vol ≥ 100, hops ≤ 3), medium (vol ≥ 30), low otherwise

## No test suite

No automated tests. Use `DEMO_MODE=true` in `.env` or the demo data fallback in `app.js` for UI testing without live API.

## Deployment target

Raspberry Pi via Docker. Deploy with:
```bash
make deploy PI_HOST=192.168.1.x PI_USER=pi PI_DIR=/opt/poe-arb
```
Container restarts automatically (`unless-stopped`). All state is in-memory (no database).

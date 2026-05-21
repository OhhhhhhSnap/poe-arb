"""
Arbitrage engine — unrestricted cycle detection.

Rate graph:
  Nodes = any currency
  Edge A→B = sell[A] / buy[B]
    sell[A]: Chaos you receive when selling 1 unit of A (BID)
    buy[B]:  Chaos you pay to acquire 1 unit of B  (ASK)

  This models the two-step route: sell A → Chaos → buy B.
  poe.ninja only provides per-currency-vs-Chaos rates, so all edges
  are implicitly mediated through Chaos even when the displayed path
  doesn't include Chaos Orb explicitly.

Cycle deduplication:
  A rotation of the same cycle (A→B→C→A vs B→C→A→B) is the same
  set of trades. We canonicalise by rotating to the lexicographically
  smallest starting node and keep one entry per unique cycle.

  Margin % is rotation-invariant (it's the product of all edge rates).
  The "start" node is chosen as the canonical minimum — or, if the user
  sets a preferred base currency, cycles are re-rotated to start there.
"""
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_seen_opportunities: dict = {}  # canonical_id -> spotted_at ISO


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _canonical_key(inner: list[str]) -> str:
    """Rotate path to lex-smallest start; return '|'-joined string."""
    mi = inner.index(min(inner))
    return "|".join(inner[mi:] + inner[:mi])


def _spotted_at(cid: str) -> str:
    if cid not in _seen_opportunities:
        _seen_opportunities[cid] = datetime.now(timezone.utc).isoformat()
    return _seen_opportunities[cid]


def clear_seen():
    _seen_opportunities.clear()


def _confidence(volume: int, hop_count: int) -> str:
    if volume >= 100 and hop_count <= 3:
        return "high"
    if volume >= 30:
        return "medium"
    return "low"


def _human_rate(name_a: str, name_b: str, exchange_rates: dict) -> str:
    ra = exchange_rates[name_a]
    rb = exchange_rates[name_b]
    effective = ra["sell"] / rb["buy"]
    if effective >= 1.0:
        return f"1 {name_a} = {effective:.2f} {name_b}"
    else:
        return f"{1.0 / effective:.2f} {name_a} = 1 {name_b}"


def _trade_whisper(path: list[str], exchange_rates: dict, league: str) -> str:
    """Bulk trade whisper for the first leg of any path."""
    if len(path) < 2:
        return ""
    a, b = path[0], path[1]
    if a not in exchange_rates or b not in exchange_rates:
        return ""
    effective = exchange_rates[a]["sell"] / exchange_rates[b]["buy"]
    if effective >= 1.0:
        x, y = round(effective), 1
        if x == 0:
            x = 1
    else:
        x, y = 1, round(1.0 / effective)
        if y == 0:
            y = 1
    return f"@whisper Hi, I'd like to buy your {x} {b} for my {y} {a} in {league}."


def _rotate_to_start(inner: list[str], preferred: str) -> list[str]:
    """Rotate inner cycle so it starts at `preferred` (if present)."""
    if preferred not in inner:
        return inner
    idx = inner.index(preferred)
    return inner[idx:] + inner[:idx]


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def find_opportunities(
    exchange_rates: dict,
    icons: dict,
    league: str,
    min_margin_pct: float,
    min_absolute_profit: float,
    min_volume: int,
    max_depth: int = 4,
    preferred_base: str = "",  # rotate cycles to start here if set
) -> list[dict]:
    """
    Find all profitable cycles of length 2–max_depth across any currency pair.

    exchange_rates: {name: {'sell': float, 'buy': float, 'chaos_eq': float, 'volume': int}}
    preferred_base: if set, cycles containing this currency are shown starting from it.
    """
    if len(exchange_rates) < 2:
        return []

    # Cap depth for large graphs to keep search time reasonable
    if len(exchange_rates) > 100 and max_depth > 3:
        max_depth = 3

    currencies = list(exchange_rates.keys())
    seen_canonical: set = set()
    opportunities: list = []

    def dfs(path: list[str], product: float):
        current = path[-1]
        start_node = path[0]

        # Cycle closed? (need at least 2 hops: start→X→start)
        if len(path) > 2 and current == start_node:
            inner = path[:-1]  # strip duplicate tail
            cid = _canonical_key(inner)
            if cid in seen_canonical:
                return
            seen_canonical.add(cid)

            margin_pct = (product - 1.0) * 100.0
            abs_profit = product - 1.0  # per 1 unit of starting currency

            if margin_pct < min_margin_pct or abs_profit < min_absolute_profit:
                return

            min_vol = min(
                exchange_rates[c]["volume"]
                for c in inner
                if c in exchange_rates
            )
            if min_vol < min_volume:
                return

            # Rotate to preferred base, or canonical minimum
            if preferred_base and preferred_base in inner:
                display_inner = _rotate_to_start(inner, preferred_base)
            else:
                mi = inner.index(min(inner))
                display_inner = inner[mi:] + inner[:mi]

            display_path = display_inner + [display_inner[0]]
            base_currency = display_path[0]
            hop_count = len(display_inner)

            buy_r = _human_rate(display_path[0], display_path[1], exchange_rates)
            sell_r = _human_rate(display_path[-2], display_path[-1], exchange_rates)

            path_icons = [icons.get(c, "") for c in display_path]
            spotted = _spotted_at(cid)

            category = exchange_rates[base_currency].get("category", "Currency")

            opp = {
                "id": cid,
                "type": "direct" if hop_count == 2 else "multihop",
                "path": display_path,
                "base_currency": base_currency,
                "category": category,
                "margin_pct": round(margin_pct, 3),
                "absolute_profit_chaos": round(
                    abs_profit * exchange_rates[base_currency]["chaos_eq"], 6
                ),
                "buy_rate": buy_r,
                "sell_rate": sell_r,
                "profit_per_trade": (
                    f"{abs_profit * 100:.3f}% per {base_currency} cycled"
                ),
                "volume": min_vol,
                "confidence": _confidence(min_vol, hop_count),
                "icons": path_icons,
                "spotted_at": spotted,
                "trade_whisper": _trade_whisper(display_path, exchange_rates, league),
                "urgency": "FAST" if hop_count > 3 else "",
            }
            opportunities.append(opp)
            return

        if len(path) > max_depth + 1:
            return

        for nxt in currencies:
            if nxt == current:
                continue
            start_node = path[0]
            # Can only return to start after ≥2 hops
            if nxt == start_node and len(path) < 3:
                continue
            # Don't revisit non-start nodes
            if nxt != start_node and nxt in path:
                continue

            sell_cur = exchange_rates[current]["sell"]
            buy_nxt = exchange_rates[nxt]["buy"]
            if buy_nxt <= 0:
                continue

            dfs(path + [nxt], product * (sell_cur / buy_nxt))

    # Start DFS from every currency
    for start in currencies:
        dfs([start], 1.0)

    opportunities.sort(key=lambda x: x["margin_pct"], reverse=True)
    for idx, opp in enumerate(opportunities):
        opp["rank"] = idx + 1
    return opportunities

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
from fractions import Fraction

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


def _rationalize(rate: float, max_d: int = 20) -> tuple[int, int]:
    """Return (p, q) whole-number ratio closest to rate with q ≤ max_d.

    Handles very small rates (e.g. 1/200 for Chaos→Divine) by inverting:
    Fraction.limit_denominator collapses anything < 1/max_d to 0/1, so we
    detect that case and return (1, round(1/rate)) instead.
    """
    if rate <= 0:
        return 1, 1
    if rate >= max_d:
        return round(rate), 1
    if rate < 1.0 / max_d:
        return 1, round(1.0 / rate)
    f = Fraction(rate).limit_denominator(max_d)
    return f.numerator, f.denominator


def _human_rate(name_a: str, name_b: str, exchange_rates: dict) -> str:
    effective = exchange_rates[name_a]["sell"] / exchange_rates[name_b]["buy"]
    p, q = _rationalize(effective)  # p B for q A
    if q == 1:
        return f"1 {name_a} = {p} {name_b}"
    elif p == 1:
        return f"{q} {name_a} = 1 {name_b}"
    else:
        return f"{q} {name_a} = {p} {name_b}"


def _trade_whisper(path: list[str], exchange_rates: dict, league: str) -> str:
    """Bulk trade whisper for the first leg of any path."""
    if len(path) < 2:
        return ""
    a, b = path[0], path[1]
    if a not in exchange_rates or b not in exchange_rates:
        return ""
    effective = exchange_rates[a]["sell"] / exchange_rates[b]["buy"]
    p, q = _rationalize(effective)  # p B for q A
    return f"@whisper Hi, I'd like to buy your {p} {b} for my {q} {a} in {league}."


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

            # Use canonical-min node for the profit filter so the threshold is
            # rotation-invariant regardless of preferred_base display choice.
            canonical_base = min(inner)
            margin_pct = (product - 1.0) * 100.0
            abs_profit = product - 1.0  # per 1 unit of starting currency
            abs_profit_chaos = abs_profit * exchange_rates[canonical_base]["chaos_eq"]

            if margin_pct < min_margin_pct or abs_profit_chaos < min_absolute_profit:
                return

            # Rotate for display only — does not affect filtering
            if preferred_base and preferred_base in inner:
                display_inner = _rotate_to_start(inner, preferred_base)
            else:
                mi = inner.index(min(inner))
                display_inner = inner[mi:] + inner[:mi]

            display_path = display_inner + [display_inner[0]]
            base_currency = display_path[0]

            min_vol = min(
                exchange_rates[c]["volume"]
                for c in inner
                if c in exchange_rates
            )
            if min_vol < min_volume:
                return
            hop_count = len(display_inner)

            buy_r = _human_rate(display_path[0], display_path[1], exchange_rates)
            sell_r = _human_rate(display_path[-2], display_path[-1], exchange_rates)

            path_icons = [icons.get(c, "") for c in display_path]
            spotted = _spotted_at(cid)

            category = exchange_rates[base_currency].get("category", "Currency")

            # Whole-number executable margin (2-hop only; multi-hop too complex)
            if hop_count == 2:
                r1 = exchange_rates[display_path[0]]["sell"] / exchange_rates[display_path[1]]["buy"]
                r2 = exchange_rates[display_path[1]]["sell"] / exchange_rates[display_path[0]]["buy"]
                p1, q1 = _rationalize(r1)  # trade q1 A → get p1 B
                p2, q2 = _rationalize(r2)  # trade q2 B → get p2 A
                a_back = (p1 * p2) // q2
                actual_margin_pct = round((a_back - q1) / q1 * 100.0, 2) if q1 > 0 else 0.0
                min_lot = q1
            else:
                actual_margin_pct = None
                min_lot = None

            opp = {
                "id": cid,
                "type": "direct" if hop_count == 2 else "multihop",
                "path": display_path,
                "base_currency": base_currency,
                "category": category,
                "margin_pct": round(margin_pct, 3),
                "absolute_profit_chaos": round(abs_profit_chaos, 6),
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
                "min_lot": min_lot,
                "actual_margin_pct": actual_margin_pct,
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

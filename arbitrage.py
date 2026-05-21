"""
Arbitrage engine using bid/ask spread model.

Rate graph:
  Nodes = currencies (including Chaos Orb as hub)
  Edge A→B = sell[A] / buy[B]
    sell[A]: Chaos you receive when selling 1 unit of A
    buy[B]:  Chaos you pay to acquire 1 unit of B

A cycle A→B→C→A starting and ending at Chaos Orb:
  step 1: Chaos → A  rate = 1 / buy[A]            (units: A per Chaos)
  step 2: A → B      rate = sell[A] / buy[B]       (units: B per A)
  step 3: B → Chaos  rate = sell[B]                (units: Chaos per B)
  product = sell[A] * sell[B] / (buy[A] * buy[B])

  margin = product - 1.0  (>0 means profitable)
"""
import math
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_seen_opportunities: dict = {}  # canonical_id -> spotted_at ISO string


def _canonical(path: list[str]) -> str:
    """Rotate path to start at lexicographically smallest node."""
    inner = path[:-1]  # drop repeated first node at end
    min_idx = inner.index(min(inner))
    rotated = inner[min_idx:] + inner[:min_idx]
    return "|".join(rotated)


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
    """Build a human-readable rate string for the A→B direction."""
    ra = exchange_rates[name_a]
    rb = exchange_rates[name_b]
    # Effective: for every 1 A you sell, you get sell[A]/buy[B] B
    effective = ra["sell"] / rb["buy"]
    if effective >= 1.0:
        return f"1 {name_a} = {effective:.2f} {name_b}"
    else:
        inv = 1.0 / effective
        return f"{inv:.2f} {name_a} = 1 {name_b}"


def _trade_whisper(path: list[str], exchange_rates: dict, league: str) -> str:
    """
    Build bulk trade whisper for the first leg of the path.
    Format: @whisper Hi, I'd like to buy your X [CurrencyB] for my Y [CurrencyA] in [League].
    """
    if len(path) < 2:
        return ""
    a, b = path[0], path[1]
    if a not in exchange_rates or b not in exchange_rates:
        return ""

    # Effective rate: how many B per A going through Chaos
    effective = exchange_rates[a]["sell"] / exchange_rates[b]["buy"]

    # Express as small integers (ratio)
    if effective >= 1.0:
        # 1 A buys `effective` B → whisper: buy `effective` B for 1 A
        x = round(effective)
        y = 1
        if x == 0:
            x = 1
    else:
        # `1/effective` A buys 1 B → whisper: buy 1 B for `1/effective` A
        x = 1
        y = round(1.0 / effective)
        if y == 0:
            y = 1

    return f"@whisper Hi, I'd like to buy your {x} {b} for my {y} {a} in {league}."


def find_opportunities(
    exchange_rates: dict,
    icons: dict,
    league: str,
    min_margin_pct: float,
    min_absolute_profit: float,
    min_volume: int,
    max_depth: int = 4,
) -> list[dict]:
    """
    exchange_rates: dict of {name: {'sell': float, 'buy': float, 'chaos_eq': float, 'volume': int}}
    Returns list of opportunity dicts, sorted by margin descending.
    """
    if len(exchange_rates) < 2:
        return []

    currencies = list(exchange_rates.keys())

    # DFS cycle finder starting at Chaos Orb
    start = "Chaos Orb"
    if start not in exchange_rates:
        return []

    seen_canonical: set = set()
    opportunities: list = []

    def dfs(path: list[str], product: float):
        current = path[-1]

        # Check if we've returned to start (min length 3: start→X→start)
        if len(path) > 2 and current == start:
            if product > 1.0:
                cid = _canonical(path[:-1])  # exclude trailing start
                if cid not in seen_canonical:
                    seen_canonical.add(cid)
                    margin_pct = (product - 1.0) * 100.0
                    # Absolute profit: starting with 1000c budget
                    # 1000c → product*1000c, gain = (product-1)*1000
                    # But spec says "absolute_profit_chaos" = profit per cycle with 1 chaos input
                    abs_profit = product - 1.0

                    if margin_pct >= min_margin_pct and abs_profit >= min_absolute_profit:
                        min_vol = min(
                            exchange_rates[c]["volume"]
                            for c in path
                            if c in exchange_rates and c != start
                        )
                        if min_vol >= min_volume:
                            hop_count = len(path) - 1
                            opp_id = "|".join(path)
                            opp_canonical = cid
                            spotted = _spotted_at(opp_canonical)

                            buy_r = _human_rate(path[0], path[1], exchange_rates)
                            sell_r = _human_rate(path[-2], path[-1], exchange_rates)

                            path_icons = [icons.get(c, "") for c in path]

                            profit_per_trade = (
                                f"{abs_profit:.4f}c per chaos cycled"
                            )

                            opp = {
                                "id": opp_canonical,
                                "type": "direct" if hop_count == 2 else "multihop",
                                "path": path,
                                "margin_pct": round(margin_pct, 3),
                                "absolute_profit_chaos": round(abs_profit, 6),
                                "buy_rate": buy_r,
                                "sell_rate": sell_r,
                                "profit_per_trade": profit_per_trade,
                                "volume": min_vol,
                                "confidence": _confidence(min_vol, hop_count),
                                "icons": path_icons,
                                "spotted_at": spotted,
                                "trade_whisper": _trade_whisper(path, exchange_rates, league),
                                "urgency": "FAST" if hop_count > 3 else "",
                            }
                            opportunities.append(opp)
            return

        if len(path) > max_depth + 1:
            return

        for nxt in currencies:
            if nxt == current:
                continue
            # Allow returning to start at any time after first hop
            if nxt == start and len(path) < 3:
                continue
            # Don't revisit non-start nodes
            if nxt != start and nxt in path:
                continue

            sell_cur = exchange_rates[current]["sell"]
            buy_nxt = exchange_rates[nxt]["buy"]
            if buy_nxt <= 0:
                continue

            step_rate = sell_cur / buy_nxt
            dfs(path + [nxt], product * step_rate)

    dfs([start], 1.0)

    opportunities.sort(key=lambda x: x["margin_pct"], reverse=True)
    return opportunities

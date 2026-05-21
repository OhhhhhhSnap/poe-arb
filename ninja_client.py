"""
poe.ninja API client.

Rate model:
  For each currency X vs Chaos:
    sell[X] = how much Chaos you GET when selling X (= receive.value for PoE1)
    buy[X]  = how much Chaos you PAY to get X     (= 1/pay.value for PoE1)

  Edge rate A→B in the exchange graph = sell[A] / buy[B]
  This is: sell A for Chaos (get sell[A]), then buy B (spend buy[B] per B).

  For PoE2 we only have a single midpoint price, so we model a small
  implicit spread (~3%) to make the same graph structure work.
"""
import time
import logging
import requests

logger = logging.getLogger(__name__)

POE2_OVERVIEW_URL = "https://poe.ninja/poe2/api/economy/currencyexchange/overview"
POE1_OVERVIEW_URL = "https://poe.ninja/api/data/currencyoverview"
MIN_FETCH_INTERVAL = 30
POE2_IMPLICIT_HALF_SPREAD = 0.015  # ±1.5% around midpoint

_cache: dict = {}
_last_fetch: dict = {}


def _rate_limited(key: str) -> bool:
    last = _last_fetch.get(key, 0)
    return (time.time() - last) < MIN_FETCH_INTERVAL


def fetch_poe2(league: str, force: bool = False) -> dict | None:
    key = f"poe2:{league}"
    if not force and _rate_limited(key) and key in _cache:
        return _cache[key]
    try:
        resp = requests.get(
            POE2_OVERVIEW_URL,
            params={"leagueName": league, "overviewName": "Currency"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        _cache[key] = data
        _last_fetch[key] = time.time()
        return data
    except Exception as e:
        logger.error("poe.ninja PoE2 fetch failed: %s", e)
        return _cache.get(key)


def fetch_poe1(league: str, force: bool = False) -> dict | None:
    key = f"poe1:{league}"
    if not force and _rate_limited(key) and key in _cache:
        return _cache[key]
    try:
        resp = requests.get(
            POE1_OVERVIEW_URL,
            params={"league": league, "type": "Currency"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        _cache[key] = data
        _last_fetch[key] = time.time()
        return data
    except Exception as e:
        logger.error("poe.ninja PoE1 fetch failed: %s", e)
        return _cache.get(key)


def parse_poe2(data: dict) -> tuple[dict, dict, float | None]:
    """
    Returns (exchange_rates, icons, timestamp).

    exchange_rates[name] = {
        'sell': Chaos you get selling 1 unit of this currency,
        'buy':  Chaos you pay to get 1 unit of this currency,
        'chaos_eq': midpoint chaos value,
        'volume': listing count,
    }

    PoE2 only provides a single midpoint price, so we apply a small
    implicit spread of ±POE2_IMPLICIT_HALF_SPREAD around it.
    """
    rates: dict = {}
    icons: dict = {}
    timestamp: float | None = None

    if not data:
        return rates, icons, timestamp

    core = data.get("core", {})
    if "timestamp" in core:
        timestamp = float(core["timestamp"])

    items_by_id: dict = {}
    for item in data.get("items", []):
        items_by_id[item["id"]] = item

    for line in data.get("lines", []):
        item_id = line.get("id")
        pv = line.get("primaryValue")
        if pv is None or item_id is None or pv == 0:
            continue

        mid = pv if pv >= 1.0 else (1.0 / pv)
        item = items_by_id.get(item_id, {})
        name = item.get("name", item_id)
        volume = line.get("volumePrimaryValue", 0)

        rates[name] = {
            "sell": mid * (1.0 + POE2_IMPLICIT_HALF_SPREAD),
            "buy": mid * (1.0 - POE2_IMPLICIT_HALF_SPREAD),
            "chaos_eq": mid,
            "volume": volume,
        }
        if "icon" in item:
            icons[name] = item["icon"]

    # Chaos Orb: spread is zero (it IS the base currency)
    rates["Chaos Orb"] = {"sell": 1.0, "buy": 1.0, "chaos_eq": 1.0, "volume": 9999}

    return rates, icons, timestamp


def parse_poe1(data: dict) -> tuple[dict, dict, float | None]:
    """
    Returns (exchange_rates, icons, timestamp).

    exchange_rates[name] = {
        'sell': receive.value   — Chaos per unit (market BID for this currency)
        'buy':  1/pay.value     — Chaos per unit (market ASK for this currency)
        'chaos_eq': chaosEquivalent,
        'volume': listing count,
    }

    Filters out currencies where only one direction (pay or receive) has data.
    """
    rates: dict = {}
    icons: dict = {}
    timestamp: float | None = None

    if not data:
        return rates, icons, timestamp

    details_by_name: dict = {}
    for d in data.get("currencyDetails", []):
        details_by_name[d.get("name")] = d

    for line in data.get("lines", []):
        name = line.get("currencyTypeName")
        if not name:
            continue

        pay_obj = line.get("pay") or {}
        receive_obj = line.get("receive") or {}
        pay_val = pay_obj.get("value") if pay_obj else None
        receive_val = receive_obj.get("value") if receive_obj else None
        chaos_eq = line.get("chaosEquivalent")

        if pay_val is None or receive_val is None or pay_val == 0:
            continue

        sell_price = float(receive_val)       # Chaos you GET when selling
        buy_price = 1.0 / float(pay_val)       # Chaos you PAY to get 1 unit

        if sell_price <= 0 or buy_price <= 0:
            continue

        volume = (
            (pay_obj.get("count") or 0) + (receive_obj.get("count") or 0)
        )

        rates[name] = {
            "sell": sell_price,
            "buy": buy_price,
            "chaos_eq": float(chaos_eq) if chaos_eq is not None else (sell_price + buy_price) / 2,
            "volume": volume,
        }

        detail = details_by_name.get(name, {})
        if "icon" in detail:
            icons[name] = detail["icon"]

    # Chaos Orb
    rates["Chaos Orb"] = {"sell": 1.0, "buy": 1.0, "chaos_eq": 1.0, "volume": 9999}
    if "Chaos Orb" in details_by_name and "icon" in details_by_name["Chaos Orb"]:
        icons["Chaos Orb"] = details_by_name["Chaos Orb"]["icon"]

    return rates, icons, timestamp


def get_data_age(game_version: str, league: str) -> float | None:
    """Returns age in seconds of cached data, or None if no cache."""
    key = f"{game_version}:{league}"
    last = _last_fetch.get(key)
    if last is None:
        return None
    return time.time() - last

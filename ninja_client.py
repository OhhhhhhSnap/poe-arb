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

  For item categories (Essence, Scarab, etc.) we only have chaosValue,
  so we apply a category-specific half-spread symmetrically:
    sell = chaosValue * (1 + spread)   — what buyers offer (BID above mid)
    buy  = chaosValue * (1 - spread)   — what sellers ask (ASK below mid)
  This means sell > buy, giving positive margins consistent with the
  currency model.
"""
import os
import time
import logging
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)

DEMO_MODE = os.environ.get("DEMO_MODE", "false").lower() == "true"

POE2_OVERVIEW_URL = "https://poe.ninja/poe2/api/economy/currencyexchange/overview"
POE1_OVERVIEW_URL = "https://poe.ninja/api/data/currencyoverview"
POE1_ITEM_OVERVIEW_URL = "https://poe.ninja/api/data/itemoverview"
POE2_ITEM_OVERVIEW_URL = "https://poe.ninja/poe2/api/economy/item/overview"
MIN_FETCH_INTERVAL = 30
POE2_IMPLICIT_HALF_SPREAD = 0.015  # ±1.5% around midpoint

NINJA_HEADERS = {
    "User-Agent": "poe-arb/1.0 (github.com/ohhhhhhsnap/poe-arb)",
    "Accept": "application/json",
}

_cache: dict = {}
_last_fetch: dict = {}

# ---------------------------------------------------------------------------
# Category configuration
# ---------------------------------------------------------------------------

CATEGORY_CONFIG = {
    "Currency":         {"spread": 0.0,   "label": "Currency",     "color": "#c8a84b"},  # real spread from API
    "Fragment":         {"spread": 0.03,  "label": "Fragment",     "color": "#9c6fff"},
    "Scarab":           {"spread": 0.04,  "label": "Scarab",       "color": "#4fc3f7"},
    "Essence":          {"spread": 0.05,  "label": "Essence",      "color": "#ff8f00"},
    "DistilledEmotion": {"spread": 0.05,  "label": "Liquid Emotions", "color": "#e91e8c"},
    "Oil":              {"spread": 0.06,  "label": "Oil",          "color": "#aed581"},
    "Fossil":           {"spread": 0.07,  "label": "Fossil",       "color": "#80cbc4"},
    "Resonator":        {"spread": 0.08,  "label": "Resonator",    "color": "#ce93d8"},
    "Incubator":        {"spread": 0.08,  "label": "Incubator",    "color": "#f48fb1"},
    "DivinationCard":   {"spread": 0.10,  "label": "Div Card",     "color": "#ef9a9a"},
    "Omen":             {"spread": 0.05,  "label": "Omen",         "color": "#80deea"},
    "SoulCore":         {"spread": 0.06,  "label": "Soul Core",    "color": "#a5d6a7"},
    # Phase 2 additions
    "SkillGem":         {"spread": 0.05,  "label": "Skill Gem",    "color": "#69f0ae"},
    "DeliriumOrb":      {"spread": 0.04,  "label": "Delirium Orb", "color": "#b0bec5"},
    "Invitation":       {"spread": 0.05,  "label": "Invitation",   "color": "#ab47bc"},
    "Tattoo":           {"spread": 0.05,  "label": "Tattoo",       "color": "#26c6da"},
    "AllflameEmber":    {"spread": 0.07,  "label": "Allflame",     "color": "#ff7043"},
    "Beast":            {"spread": 0.10,  "label": "Beast",        "color": "#ff5252"},
    "Map":              {"spread": 0.06,  "label": "Map",          "color": "#a1887f"},
    "BlightedMap":      {"spread": 0.08,  "label": "Blt. Map",     "color": "#66bb6a"},
    # PoE2 additions matching poe.ninja left-nav
    "AbyssalBone":      {"spread": 0.06,  "label": "Abyssal Bones","color": "#7e57c2"},
    "UncutGem":         {"spread": 0.05,  "label": "Uncut Gems",   "color": "#26a69a"},
    "LineageGem":       {"spread": 0.08,  "label": "Lineage Gems", "color": "#1565c0"},
    "Idol":             {"spread": 0.07,  "label": "Idols",        "color": "#d4a017"},
    "Rune":             {"spread": 0.06,  "label": "Runes",        "color": "#bf360c"},
    "Expedition":       {"spread": 0.07,  "label": "Expedition",   "color": "#00838f"},
    "Catalyst":         {"spread": 0.05,  "label": "Catalysts",    "color": "#558b2f"},
}

# Item categories to fetch per game version
POE1_ITEM_CATEGORIES = [
    "Essence", "Scarab", "Fragment", "Oil", "Fossil", "Resonator", "Incubator",
    "DivinationCard", "SkillGem", "DeliriumOrb", "Invitation", "Tattoo",
    "AllflameEmber", "Beast", "Map", "BlightedMap",
]
POE2_ITEM_CATEGORIES = [
    "Essence", "Scarab", "Fragment", "DistilledEmotion", "Omen", "SoulCore",
    "DivinationCard", "SkillGem", "Map",
    "AbyssalBone", "UncutGem", "LineageGem", "Idol", "Rune", "Expedition", "Catalyst",
]


# ---------------------------------------------------------------------------
# Rate limiting helpers
# ---------------------------------------------------------------------------

def _rate_limited(key: str) -> bool:
    last = _last_fetch.get(key, 0)
    return (time.time() - last) < MIN_FETCH_INTERVAL


def _get_with_retry(url: str, params: dict, timeout: int = 10, max_retries: int = 3):
    delay = 2.0
    for attempt in range(max_retries):
        resp = requests.get(url, params=params, headers=NINJA_HEADERS, timeout=timeout)
        if resp.status_code == 429 and attempt < max_retries - 1:
            logger.warning("poe.ninja 429, retrying in %.1fs", delay)
            time.sleep(delay)
            delay *= 2
        else:
            resp.raise_for_status()
            return resp
    return resp


# ---------------------------------------------------------------------------
# Raw fetch functions (currency exchange)
# ---------------------------------------------------------------------------

def fetch_poe2(league: str, force: bool = False) -> dict | None:
    key = f"poe2:{league}"
    if not force and _rate_limited(key) and key in _cache:
        return _cache[key]
    try:
        resp = _get_with_retry(
            POE2_OVERVIEW_URL,
            params={"leagueName": league, "overviewName": "Currency"},
        )
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
        resp = _get_with_retry(
            POE1_OVERVIEW_URL,
            params={"league": league, "type": "Currency"},
        )
        data = resp.json()
        _cache[key] = data
        _last_fetch[key] = time.time()
        return data
    except Exception as e:
        logger.error("poe.ninja PoE1 fetch failed: %s", e)
        return _cache.get(key)


# ---------------------------------------------------------------------------
# Raw fetch functions (item overview)
# ---------------------------------------------------------------------------

def fetch_item_overview(game_version: str, league: str, category: str, force: bool = False) -> dict | None:
    """
    Fetch item overview data for a given category.
    Fragment uses the currency overview endpoint for PoE1.
    """
    key = f"{game_version}:{league}:item:{category}"
    if not force and _rate_limited(key) and key in _cache:
        return _cache[key]

    try:
        if game_version == "poe2":
            url = POE2_ITEM_OVERVIEW_URL
            params = {"leagueName": league, "type": category}
        elif category == "Fragment":
            # PoE1 fragments use the currency overview endpoint
            url = POE1_OVERVIEW_URL
            params = {"league": league, "type": "Fragment"}
        else:
            url = POE1_ITEM_OVERVIEW_URL
            params = {"league": league, "type": category}

        resp = _get_with_retry(url, params=params)
        data = resp.json()
        _cache[key] = data
        _last_fetch[key] = time.time()
        return data
    except Exception as e:
        logger.error("poe.ninja item overview fetch failed (%s/%s): %s", game_version, category, e)
        return _cache.get(key)


# ---------------------------------------------------------------------------
# Parse functions (currency exchange — existing)
# ---------------------------------------------------------------------------

def parse_poe2(data: dict) -> tuple[dict, dict, float | None]:
    """
    Returns (exchange_rates, icons, timestamp).

    exchange_rates[name] = {
        'sell': Chaos you get selling 1 unit of this currency,
        'buy':  Chaos you pay to get 1 unit of this currency,
        'chaos_eq': midpoint chaos value,
        'volume': listing count,
        'category': 'Currency',
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
            "category": "Currency",
        }
        if "icon" in item:
            icons[name] = item["icon"]

    # Chaos Orb: spread is zero (it IS the base currency)
    rates["Chaos Orb"] = {"sell": 1.0, "buy": 1.0, "chaos_eq": 1.0, "volume": 9999, "category": "Currency"}

    return rates, icons, timestamp


def parse_poe1(data: dict) -> tuple[dict, dict, float | None]:
    """
    Returns (exchange_rates, icons, timestamp).

    exchange_rates[name] = {
        'sell': receive.value   — Chaos per unit (market BID for this currency)
        'buy':  1/pay.value     — Chaos per unit (market ASK for this currency)
        'chaos_eq': chaosEquivalent,
        'volume': listing count,
        'category': 'Currency',
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
            "category": "Currency",
        }

        detail = details_by_name.get(name, {})
        if "icon" in detail:
            icons[name] = detail["icon"]

    # Chaos Orb
    rates["Chaos Orb"] = {"sell": 1.0, "buy": 1.0, "chaos_eq": 1.0, "volume": 9999, "category": "Currency"}
    if "Chaos Orb" in details_by_name and "icon" in details_by_name["Chaos Orb"]:
        icons["Chaos Orb"] = details_by_name["Chaos Orb"]["icon"]

    return rates, icons, timestamp


# ---------------------------------------------------------------------------
# Parse function (item overview — new)
# ---------------------------------------------------------------------------

def parse_item_overview(
    data: dict,
    category: str,
    config_entry: dict,
    max_items: int = 40,
) -> tuple[dict, dict]:
    """
    Parse poe.ninja item overview response.

    Returns (rates, icons) where:
        rates[name] = {
            'sell': chaosValue * (1 + spread),
            'buy':  chaosValue * (1 - spread),
            'chaos_eq': chaosValue,
            'volume': listingCount,
            'category': category,
        }

    Filters: chaosValue >= 0.5 and listingCount >= 5.
    Sorts by listingCount desc, takes top max_items.

    For Fragment (PoE1 currency overview format), falls back to chaosEquivalent.
    """
    rates: dict = {}
    icons: dict = {}

    if not data:
        return rates, icons

    spread = config_entry.get("spread", 0.05)

    lines = data.get("lines", [])

    # Handle Fragment (currency overview format) — items have currencyTypeName + chaosEquivalent
    is_currency_fmt = bool(lines and "currencyTypeName" in lines[0]) if lines else False

    detail_icons: dict = {}
    if is_currency_fmt:
        detail_icons = {
            d["name"]: d.get("icon")
            for d in data.get("currencyDetails", [])
            if "name" in d
        }

    parsed: list = []
    for line in lines:
        if is_currency_fmt:
            name = line.get("currencyTypeName")
            chaos_val = line.get("chaosEquivalent")
            listing_count = (
                (line.get("pay") or {}).get("count", 0) +
                (line.get("receive") or {}).get("count", 0)
            )
            icon_url = detail_icons.get(name)
        else:
            name = line.get("name")
            chaos_val = line.get("chaosValue")
            listing_count = line.get("listingCount") or line.get("count") or 0
            icon_url = line.get("icon")

        if not name or chaos_val is None:
            continue
        chaos_val = float(chaos_val)
        if chaos_val < 0.5:
            continue
        if listing_count < 5:
            continue
        # SkillGem: skip levelling gems — only level 20+ have stable arb prices
        if category == "SkillGem" and not is_currency_fmt:
            if line.get("gemLevel", 0) < 20:
                continue

        parsed.append((listing_count, name, chaos_val, icon_url))

    # Sort by listing count descending, take top max_items
    parsed.sort(key=lambda x: x[0], reverse=True)
    parsed = parsed[:max_items]

    for listing_count, name, chaos_val, icon_url in parsed:
        rates[name] = {
            "sell": chaos_val * (1.0 + spread),
            "buy": chaos_val * (1.0 - spread),
            "chaos_eq": chaos_val,
            "volume": listing_count,
            "category": category,
        }
        if icon_url:
            icons[name] = icon_url

    return rates, icons


# ---------------------------------------------------------------------------
# Unified fetch_all entry point
# ---------------------------------------------------------------------------

def fetch_all(
    game_version: str,
    league: str,
    force: bool = False,
    max_items_per_cat: int = 40,
    enabled_categories: list | None = None,
    _demo: bool = False,
) -> tuple[dict, dict, float | None]:
    """
    Fetch all currency and item category data in parallel.

    Returns (exchange_rates, icons, timestamp) — same signature as
    parse_poe2 / parse_poe1 but merged across all categories.
    """
    if DEMO_MODE or _demo:
        return _build_demo_rates(game_version)

    # 1. Fetch currency exchange data
    if game_version == "poe2":
        currency_data = fetch_poe2(league, force=force)
        rates, icons, timestamp = parse_poe2(currency_data)
        item_categories = POE2_ITEM_CATEGORIES
    else:
        currency_data = fetch_poe1(league, force=force)
        rates, icons, timestamp = parse_poe1(currency_data)
        item_categories = POE1_ITEM_CATEGORIES

    if enabled_categories is not None:
        item_categories = [c for c in item_categories if c in enabled_categories]

    # 2. Fetch item categories in parallel
    def _fetch_category(category: str) -> tuple[str, dict, dict]:
        data = fetch_item_overview(game_version, league, category, force=force)
        cfg_entry = CATEGORY_CONFIG.get(category, {"spread": 0.05})
        cat_rates, cat_icons = parse_item_overview(data, category, cfg_entry, max_items=max_items_per_cat)
        return category, cat_rates, cat_icons

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {executor.submit(_fetch_category, cat): cat for cat in item_categories}
        for future in as_completed(futures):
            try:
                _category, cat_rates, cat_icons = future.result()
                rates.update(cat_rates)
                icons.update(cat_icons)
            except Exception as e:
                logger.error("Item category fetch/parse error: %s", e)

    return rates, icons, timestamp


# ---------------------------------------------------------------------------
# Cache age helper
# ---------------------------------------------------------------------------

def get_data_age(game_version: str, league: str) -> float | None:
    """Returns age in seconds of cached data, or None if no cache."""
    key = f"{game_version}:{league}"
    last = _last_fetch.get(key)
    if last is None:
        return None
    return time.time() - last


# ---------------------------------------------------------------------------
# Demo mode — compact realistic data (~20 nodes) so DFS completes quickly
# ---------------------------------------------------------------------------
# Keep total nodes < 25 per game version. DFS is O(n^depth), so 20^4 = 160k
# steps — fast. 57^4 = 10M — hangs for seconds in Python.

# 5 nodes → C(4,2)*2 = 12 AW-base + 2 Divine-base = 14 three-hop cycles (fast + clean demo).
# Chaos Orb is always included as base currency.
_DEMO_NODES: dict[str, dict[str, list]] = {
    "poe2": {
        "Currency": [
            # name, mid_price
            ("Divine Orb", 175),
        ],
        "DivinationCard": [
            # name, chaos_val, volume
            ("Abandoned Wealth", 220, 180),
        ],
        "Essence": [
            ("Essence of Anger", 32, 150),
        ],
        "Scarab": [
            ("Scarab of Divinity", 18, 240),
        ],
    },
    "poe1": {
        "Currency": [
            # name, sell, buy, chaos_eq, volume
            ("Divine Orb",       165, 175, 170, 800),
            ("Exalted Orb",      180, 195, 188, 600),
        ],
        "DivinationCard": [
            ("Abandoned Wealth", 200, 200),
        ],
        "Essence": [
            ("Deafening Essence of Loathing", 35, 120),
        ],
        "Oil": [
            ("Golden Oil", 18, 300),
        ],
    },
}


def _build_demo_rates(game_version: str) -> tuple[dict, dict, float]:
    rates: dict = {}
    icons: dict = {}
    rates["Chaos Orb"] = {"sell": 1.0, "buy": 1.0, "chaos_eq": 1.0, "volume": 9999, "category": "Currency"}

    gv = game_version if game_version in _DEMO_NODES else "poe2"
    nodes = _DEMO_NODES[gv]
    for cat, items in nodes.items():
        spread = CATEGORY_CONFIG.get(cat, {"spread": 0.05})["spread"]
        for row in items:
            if cat == "Currency":
                if gv == "poe2":
                    name, mid = row
                    s = POE2_IMPLICIT_HALF_SPREAD
                    rates[name] = {"sell": round(mid*(1+s),4), "buy": round(mid*(1-s),4), "chaos_eq": mid, "volume": 500, "category": cat}
                else:  # poe1
                    name, sell, buy, eq, vol = row
                    rates[name] = {"sell": sell, "buy": buy, "chaos_eq": eq, "volume": vol, "category": cat}
            else:
                name, chaos_val, volume = row
                rates[name] = {
                    "sell": round(chaos_val*(1+spread),4),
                    "buy": round(chaos_val*(1-spread),4),
                    "chaos_eq": chaos_val, "volume": volume, "category": cat,
                }

    logger.info("Demo mode: %d nodes loaded", len(rates))
    return rates, icons, time.time()

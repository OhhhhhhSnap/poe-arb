import logging
import socket
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler

import config as cfg
import ninja_client
import arbitrage
import notifier
import flip_tracker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder="static")
CORS(app)

_state: dict = {
    "opportunities": [],
    "last_refresh": None,
    "error": None,
    "leagues": {"poe1": [], "poe2": []},
    "leagues_fetched_at": None,
}

GGG_LEAGUES_POE1 = "https://api.pathofexile.com/leagues?type=main&realm=pc&compact=1"
GGG_LEAGUES_POE2 = "https://api.pathofexile.com/leagues?type=main&realm=poe2&compact=1"

POE1_FALLBACK = [
    {"id": "Settlers of Kalguur", "name": "Settlers of Kalguur", "start": None, "active": True},
    {"id": "Standard", "name": "Standard", "start": None, "active": True},
    {"id": "Hardcore", "name": "Hardcore", "start": None, "active": True},
]
POE2_FALLBACK = [
    {"id": "Fate of the Vaal", "name": "Fate of the Vaal", "start": None, "active": True},
    {"id": "Standard", "name": "Standard", "start": None, "active": True},
]


def _parse_leagues(raw: list) -> list[dict]:
    import requests as req
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    out = []
    for item in raw:
        if item.get("event"):
            continue
        end = item.get("endAt")
        if end:
            try:
                end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
                if end_dt < now:
                    continue
            except Exception:
                pass
        start = item.get("startAt")
        start_str = None
        if start:
            try:
                start_str = datetime.fromisoformat(start.replace("Z", "+00:00")).date().isoformat()
            except Exception:
                pass
        league_id = item["id"]
        out.append({
            "id": league_id,
            "name": league_id,
            "start": start_str,
            "active": True,
        })
    # Sort: permanent leagues last, others by startAt desc
    permanent = {"Standard", "Hardcore", "HC SSF", "SSF"}
    perm = [x for x in out if x["name"] in permanent]
    challenge = [x for x in out if x["name"] not in permanent]
    challenge.sort(key=lambda x: x["start"] or "0000", reverse=True)
    return challenge + perm


GGG_HEADERS = {
    "User-Agent": "poe-arb/1.0 (currency arbitrage tool; contact: poe-arb@localhost)",
    "Accept": "application/json",
}


def fetch_leagues(force: bool = False):
    now = time.time()
    last = _state.get("leagues_fetched_at") or 0
    if not force and (now - last) < 6 * 3600:
        return
    import requests as req
    try:
        r1 = req.get(GGG_LEAGUES_POE1, headers=GGG_HEADERS, timeout=10)
        r1.raise_for_status()
        poe1 = _parse_leagues(r1.json())
        _state["leagues"]["poe1"] = poe1 if poe1 else POE1_FALLBACK
    except Exception as e:
        logger.warning("Failed to fetch PoE1 leagues: %s", e)
        if not _state["leagues"]["poe1"]:
            _state["leagues"]["poe1"] = POE1_FALLBACK

    try:
        r2 = req.get(GGG_LEAGUES_POE2, headers=GGG_HEADERS, timeout=10)
        r2.raise_for_status()
        poe2 = _parse_leagues(r2.json())
        _state["leagues"]["poe2"] = poe2 if poe2 else POE2_FALLBACK
    except Exception as e:
        logger.warning("Failed to fetch PoE2 leagues: %s", e)
        if not _state["leagues"]["poe2"]:
            _state["leagues"]["poe2"] = POE2_FALLBACK

    _state["leagues_fetched_at"] = now

    _state["leagues_fetched_at"] = now


def _build_demo_opportunities(game_version: str) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    league = cfg.get_config()["league_name"]

    def opp(rank, path, margin, abs_profit, vol, cat, buy_r, sell_r):
        inner = path[:-1]
        conf = "high" if vol >= 100 and len(inner) <= 3 else "medium"
        cid = "|".join(inner)
        whisper_a, whisper_b = path[0], path[1]
        return {
            "id": cid,
            "rank": rank,
            "type": "direct" if len(inner) == 2 else "multihop",
            "path": path,
            "base_currency": path[0],
            "category": cat,
            "margin_pct": margin,
            "absolute_profit_chaos": abs_profit,
            "buy_rate": buy_r,
            "sell_rate": sell_r,
            "profit_per_trade": f"{margin:.3f}% per {path[0]} cycled",
            "volume": vol,
            "confidence": conf,
            "icons": [""] * len(path),
            "spotted_at": now,
            "trade_whisper": f"@whisper Hi, I'd like to buy your 1 {whisper_b} for my 1 {whisper_a} in {league}.",
            "urgency": "FAST" if len(inner) > 3 else "",
        }

    if game_version == "poe2":
        return [
            opp(1,  ["Divine Orb", "Essence of Anger", "Scarab of Divinity", "Divine Orb"],      23.4, 40.9,  150, "Currency",       "1 Divine Orb = 5.84 Essence of Anger",           "5.13 Essence of Anger = 1 Divine Orb"),
            opp(2,  ["Abandoned Wealth", "Essence of Anger", "Divine Orb", "Abandoned Wealth"],   39.2, 86.2,  150, "DivinationCard", "1 Abandoned Wealth = 7.96 Essence of Anger",      "7.03 Essence of Anger = 1 Abandoned Wealth"),
            opp(3,  ["Abandoned Wealth", "Scarab of Divinity", "Divine Orb", "Abandoned Wealth"], 36.4, 80.2,  180, "DivinationCard", "1 Abandoned Wealth = 14.00 Scarab of Divinity",   "12.35 Scarab of Divinity = 1 Abandoned Wealth"),
            opp(4,  ["Divine Orb", "Scarab of Divinity", "Essence of Anger", "Divine Orb"],       23.4, 40.9,  150, "Currency",       "1 Divine Orb = 10.28 Scarab of Divinity",         "9.07 Scarab of Divinity = 1 Divine Orb"),
            opp(5,  ["Abandoned Wealth", "Divine Orb", "Abandoned Wealth",  "Divine Orb"],        25.9, 57.1,  180, "DivinationCard", "1 Abandoned Wealth = 1.40 Divine Orb",            "1.12 Divine Orb = 1 Abandoned Wealth"),
            opp(6,  ["Essence of Anger", "Scarab of Divinity", "Divine Orb", "Essence of Anger"], 19.7,  6.3,  150, "Essence",        "1 Essence of Anger = 1.09 Scarab of Divinity",    "1 Scarab of Divinity = 1.08 Essence of Anger"),
            opp(7,  ["Divine Orb", "Essence of Anger", "Divine Orb",        "Essence of Anger"],  13.9, 24.3,  150, "Currency",       "1 Divine Orb = 5.84 Essence of Anger",            "5.13 Essence of Anger = 1 Divine Orb"),
            opp(8,  ["Abandoned Wealth", "Chaos Orb", "Divine Orb", "Abandoned Wealth"],          25.9, 57.1, 9999, "DivinationCard", "1 Abandoned Wealth = 242.00 Chaos Orb",           "1.12 Divine Orb = 1 Abandoned Wealth"),
            opp(9,  ["Divine Orb", "Scarab of Divinity", "Divine Orb",      "Scarab of Divinity"],11.6, 20.3,  240, "Currency",       "1 Divine Orb = 10.28 Scarab of Divinity",         "9.07 Scarab of Divinity = 1 Divine Orb"),
            opp(10, ["Scarab of Divinity", "Essence of Anger", "Divine Orb", "Scarab of Divinity"],19.7, 3.5, 150, "Scarab",         "1 Scarab of Divinity = 0.92 Essence of Anger",    "1 Essence of Anger = 0.91 Scarab of Divinity"),
            opp(11, ["Abandoned Wealth", "Essence of Anger", "Chaos Orb", "Abandoned Wealth"],    35.1, 77.2,  150, "DivinationCard", "1 Abandoned Wealth = 7.96 Essence of Anger",      "7.03 Essence of Anger = 1 Abandoned Wealth"),
            opp(12, ["Divine Orb", "Chaos Orb", "Essence of Anger", "Divine Orb"],                13.9, 24.3, 9999, "Currency",       "1 Divine Orb = 177.63 Chaos Orb",                "157.00 Chaos Orb = 1 Divine Orb"),
        ]

    # PoE1 demo
    return [
        opp(1,  ["Divine Orb", "Deafening Essence of Loathing", "Exalted Orb", "Divine Orb"],     18.5, 31.5,  120, "Currency",       "1 Divine Orb = 4.71 Deafening Essence",           "4.20 Deafening Essence = 1 Divine Orb"),
        opp(2,  ["Abandoned Wealth", "Divine Orb", "Exalted Orb", "Abandoned Wealth"],            28.3, 56.6,  200, "DivinationCard", "1 Abandoned Wealth = 1.14 Divine Orb",            "1.02 Divine Orb = 1 Abandoned Wealth"),
        opp(3,  ["Divine Orb", "Golden Oil", "Exalted Orb", "Divine Orb"],                        16.2, 27.5,  300, "Currency",       "1 Divine Orb = 9.17 Golden Oil",                  "8.29 Golden Oil = 1 Divine Orb"),
        opp(4,  ["Abandoned Wealth", "Deafening Essence of Loathing", "Divine Orb", "Abandoned Wealth"], 35.0, 70.0, 120, "DivinationCard", "1 Abandoned Wealth = 5.71 Deafening Essence", "5.00 Deafening Essence = 1 Abandoned Wealth"),
        opp(5,  ["Exalted Orb", "Golden Oil", "Divine Orb", "Exalted Orb"],                       14.8, 27.8,  300, "Currency",       "1 Exalted Orb = 10.00 Golden Oil",                "9.17 Golden Oil = 1 Exalted Orb"),
        opp(6,  ["Abandoned Wealth", "Golden Oil", "Divine Orb", "Abandoned Wealth"],             32.3, 64.6,  300, "DivinationCard", "1 Abandoned Wealth = 11.11 Golden Oil",            "9.43 Golden Oil = 1 Abandoned Wealth"),
        opp(7,  ["Divine Orb", "Deafening Essence of Loathing", "Divine Orb", "Exalted Orb"],     12.1, 20.6,  120, "Currency",       "1 Divine Orb = 4.71 Deafening Essence",           "4.20 Deafening Essence = 1 Divine Orb"),
        opp(8,  ["Abandoned Wealth", "Chaos Orb", "Divine Orb", "Abandoned Wealth"],             28.3, 56.6, 9999, "DivinationCard", "1 Abandoned Wealth = 200.00 Chaos Orb",           "1.02 Divine Orb = 1 Abandoned Wealth"),
    ]


def refresh_data(force: bool = False):
    if ninja_client.DEMO_MODE:
        _state["opportunities"] = _build_demo_opportunities(cfg.get_config()["game_version"])
        _state["last_refresh"] = datetime.now(timezone.utc).isoformat()
        _state["error"] = None
        return

    c = cfg.get_config()
    game = c["game_version"]
    league = c["league_name"]
    max_items = c.get("max_items_per_category", 40)
    try:
        rates, icons, ts = ninja_client.fetch_all(
            game, league, force=force, max_items_per_cat=max_items
        )

        if not rates:
            _state["error"] = f"No data returned from poe.ninja for {league}"
            return

        opps = arbitrage.find_opportunities(
            rates, icons, league,
            min_margin_pct=c["min_margin_pct"],
            min_absolute_profit=c["min_absolute_profit_chaos"],
            min_volume=c["min_volume"],
            max_depth=c["max_hop_depth"],
            preferred_base=c.get("preferred_base", ""),
        )

        _state["opportunities"] = opps
        _state["last_refresh"] = datetime.now(timezone.utc).isoformat()
        _state["error"] = None

        if c["notify_on_new_opportunity"] and c["discord_webhook_url"]:
            for opp in opps:
                notifier.notify_opportunity(
                    opp, league, c["discord_webhook_url"], c["notify_min_margin_pct"]
                )
    except Exception as e:
        logger.error("refresh_data error: %s", e)
        _state["error"] = str(e)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/leagues")
def api_leagues():
    fetch_leagues()
    return jsonify(_state["leagues"])


@app.route("/api/opportunities")
def api_opportunities():
    age = ninja_client.get_data_age(
        cfg.get_config()["game_version"],
        cfg.get_config()["league_name"],
    )
    stale = age is not None and age > 300
    return jsonify({
        "opportunities": _state["opportunities"],
        "last_refresh": _state["last_refresh"],
        "error": _state["error"],
        "stale": stale,
        "data_age_seconds": round(age) if age is not None else None,
    })


@app.route("/api/config", methods=["GET"])
def api_config_get():
    return jsonify(cfg.get_config())


@app.route("/api/config", methods=["POST"])
def api_config_post():
    data = request.get_json(force=True)
    cfg.update_config(data)
    refresh_data(force=True)
    return jsonify({"ok": True, "config": cfg.get_config()})


@app.route("/api/refresh")
def api_refresh():
    refresh_data(force=True)
    return jsonify({"ok": True, "last_refresh": _state["last_refresh"], "error": _state["error"]})


@app.route("/api/flips", methods=["GET"])
def api_flips_get():
    return jsonify({
        "flips": flip_tracker.get_flips(),
        "session_total": flip_tracker.get_session_total(),
    })


@app.route("/api/flips", methods=["POST"])
def api_flips_post():
    data = request.get_json(force=True)
    opp_id = data.get("opportunity_id", "")
    expected = float(data.get("expected_profit_chaos", 0))
    actual = float(data.get("actual_profit_chaos", 0))
    path = data.get("path", [])
    flip = flip_tracker.add_flip(opp_id, path, expected, actual)
    return jsonify({"ok": True, "flip": flip, "session_total": flip_tracker.get_session_total()})


@app.route("/api/flips", methods=["DELETE"])
def api_flips_delete():
    flip_tracker.clear_flips()
    return jsonify({"ok": True})


@app.route("/api/categories")
def api_categories():
    return jsonify(ninja_client.CATEGORY_CONFIG)


@app.route("/api/status")
def api_status():
    try:
        lan_ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        lan_ip = "127.0.0.1"
    c = cfg.get_config()
    return jsonify({
        "lan_ip": lan_ip,
        "bind_all": c["bind_all_interfaces"],
        "game_version": c["game_version"],
        "league": c["league_name"],
        "demo_mode": ninja_client.DEMO_MODE,
    })


def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    fetch_leagues(force=True)
    refresh_data(force=True)

    scheduler = BackgroundScheduler()

    def scheduled_refresh():
        refresh_data()

    def scheduled_leagues():
        fetch_leagues(force=True)

    c = cfg.get_config()
    scheduler.add_job(scheduled_refresh, "interval", seconds=c["refresh_interval_seconds"])
    scheduler.add_job(scheduled_leagues, "interval", hours=6)
    scheduler.start()

    host = "0.0.0.0" if c["bind_all_interfaces"] else "127.0.0.1"
    if c["bind_all_interfaces"]:
        lan = get_lan_ip()
        logger.info("LAN sharing enabled — http://%s:5000", lan)

    app.run(host=host, port=5000, debug=False)

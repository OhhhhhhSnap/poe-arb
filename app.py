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


def refresh_data(force: bool = False):
    c = cfg.get_config()
    game = c["game_version"]
    league = c["league_name"]
    try:
        if game == "poe2":
            raw = ninja_client.fetch_poe2(league, force=force)
            rates, icons, ts = ninja_client.parse_poe2(raw)
        else:
            raw = ninja_client.fetch_poe1(league, force=force)
            rates, icons, ts = ninja_client.parse_poe1(raw)

        if not rates:
            _state["error"] = f"No data returned from poe.ninja for {league}"
            return

        opps = arbitrage.find_opportunities(
            rates, icons, league,
            min_margin_pct=c["min_margin_pct"],
            min_absolute_profit=c["min_absolute_profit_chaos"],
            min_volume=c["min_volume"],
            max_depth=c["max_hop_depth"],
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

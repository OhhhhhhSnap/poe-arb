import logging
import requests
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_notified_ids: set = set()


def reset():
    _notified_ids.clear()


def notify_opportunity(opp: dict, league: str, webhook_url: str, min_margin_pct: float):
    if not webhook_url:
        return
    opp_id = opp.get("id", "")
    margin = opp.get("margin_pct", 0)
    if margin < min_margin_pct:
        return
    if opp_id in _notified_ids:
        return
    _notified_ids.add(opp_id)

    color = 0x00FF88 if margin >= 5.0 else 0xFFCC00
    path_str = " → ".join(opp.get("path", []))
    spotted = opp.get("spotted_at", "")
    try:
        spotted_dt = datetime.fromisoformat(spotted)
        age_s = int((datetime.now(timezone.utc) - spotted_dt).total_seconds())
        age_str = f"{age_s}s ago"
    except Exception:
        age_str = "just now"

    embed = {
        "title": f"Arbitrage Alert — {league}",
        "color": color,
        "fields": [
            {"name": "Path", "value": path_str, "inline": False},
            {"name": "Margin", "value": f"{margin:.2f}%", "inline": True},
            {"name": "Profit per cycle", "value": opp.get("profit_per_trade", ""), "inline": True},
            {"name": "Confidence", "value": opp.get("confidence", ""), "inline": True},
        ],
        "footer": {"text": f"Spotted {age_str} · poe-arb"},
    }

    payload = {"embeds": [embed]}
    try:
        resp = requests.post(webhook_url, json=payload, timeout=5)
        resp.raise_for_status()
    except Exception as e:
        logger.error("Discord notify failed: %s", e)

import os

GAME_VERSION = os.environ.get("GAME_VERSION", "poe2")
LEAGUE_NAME = os.environ.get("LEAGUE_NAME", "Fate of the Vaal")
REFRESH_INTERVAL_SECONDS = int(os.environ.get("REFRESH_INTERVAL_SECONDS", 60))
MIN_MARGIN_PCT = float(os.environ.get("MIN_MARGIN_PCT", 3.0))
MIN_ABSOLUTE_PROFIT_CHAOS = float(os.environ.get("MIN_ABSOLUTE_PROFIT_CHAOS", 0.5))
MIN_VOLUME = int(os.environ.get("MIN_VOLUME", 10))
MAX_HOP_DEPTH = int(os.environ.get("MAX_HOP_DEPTH", 4))
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "")
NOTIFY_ON_NEW_OPPORTUNITY = os.environ.get("NOTIFY_ON_NEW_OPPORTUNITY", "true").lower() == "true"
NOTIFY_MIN_MARGIN_PCT = float(os.environ.get("NOTIFY_MIN_MARGIN_PCT", 5.0))
BIND_ALL_INTERFACES = os.environ.get("BIND_ALL_INTERFACES", "false").lower() == "true"
SOUND_ALERTS = os.environ.get("SOUND_ALERTS", "true").lower() == "true"
PREFERRED_BASE = os.environ.get("PREFERRED_BASE", "")  # "" = show all starts

_config = {
    "game_version": GAME_VERSION,
    "league_name": LEAGUE_NAME,
    "refresh_interval_seconds": REFRESH_INTERVAL_SECONDS,
    "min_margin_pct": MIN_MARGIN_PCT,
    "min_absolute_profit_chaos": MIN_ABSOLUTE_PROFIT_CHAOS,
    "min_volume": MIN_VOLUME,
    "max_hop_depth": MAX_HOP_DEPTH,
    "discord_webhook_url": DISCORD_WEBHOOK_URL,
    "notify_on_new_opportunity": NOTIFY_ON_NEW_OPPORTUNITY,
    "notify_min_margin_pct": NOTIFY_MIN_MARGIN_PCT,
    "bind_all_interfaces": BIND_ALL_INTERFACES,
    "sound_alerts": SOUND_ALERTS,
    "preferred_base": PREFERRED_BASE,
    "enabled_categories": [
        "Currency", "Fragment", "Scarab", "Essence", "DistilledEmotion",
        "Oil", "Fossil", "Resonator", "Incubator", "DivinationCard", "Omen", "SoulCore",
        # Phase 2 — liquid/stackable additions (Map/BlightedMap off by default — large, thin margins)
        "SkillGem", "DeliriumOrb", "Invitation", "Tattoo", "AllflameEmber", "Beast",
    ],
    "max_items_per_category": 40,
}


def get_config():
    return dict(_config)


def update_config(updates: dict):
    allowed = {
        "game_version", "league_name", "refresh_interval_seconds",
        "min_margin_pct", "min_absolute_profit_chaos", "min_volume",
        "max_hop_depth", "discord_webhook_url", "notify_on_new_opportunity",
        "notify_min_margin_pct", "bind_all_interfaces", "sound_alerts",
        "preferred_base", "enabled_categories", "max_items_per_category",
    }
    for k, v in updates.items():
        if k in allowed:
            _config[k] = v

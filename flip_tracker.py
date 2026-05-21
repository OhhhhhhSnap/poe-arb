from datetime import datetime, timezone

_flips: list = []


def add_flip(opportunity_id: str, path: list, expected_profit: float, actual_profit: float) -> dict:
    flip = {
        "id": len(_flips),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "opportunity_id": opportunity_id,
        "path": path,
        "expected_profit": expected_profit,
        "actual_profit": actual_profit,
        "delta": round(actual_profit - expected_profit, 4),
    }
    _flips.append(flip)
    return flip


def get_flips() -> list:
    return list(_flips)


def get_session_total() -> float:
    return round(sum(f["actual_profit"] for f in _flips), 4)


def clear_flips():
    _flips.clear()

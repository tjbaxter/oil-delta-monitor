from __future__ import annotations

from typing import Any


# Keep this easy to edit: market slugs can age out quickly.
DEFAULT_MARKET_SLUG: str = "cl-above-90-jun-2026"
DEFAULT_STRIKE: float = 90.0
DEFAULT_SPREAD_WIDTH: float = 1.0
DEFAULT_IV: float = 0.90
DEFAULT_RISK_FREE_RATE: float = 0.04
DEFAULT_ROLLING_WINDOW: int = 20
DEFAULT_FAIR_GAP_THRESHOLD: float = 0.02
DEFAULT_DELTA_GAP_THRESHOLD: float = 0.01
DEFAULT_POLLING_INTERVAL_SECONDS: int = 15
DEFAULT_APP_TITLE: str = "CL Delta Scope"

COLOR_POLY: str = "#27D3C3"
COLOR_THEO: str = "#FF8B3D"
COLOR_CRUDE: str = "#B9A26A"
COLOR_POSITIVE: str = "#2EC27E"
COLOR_NEGATIVE: str = "#F66151"
COLOR_NEUTRAL: str = "#8A9199"
COLOR_BG: str = "#05080F"
COLOR_CARD_BG: str = "#0A1320"
COLOR_BORDER: str = "#1A2B3D"


def streamlit_page_config() -> dict[str, Any]:
    return {"layout": "wide", "page_title": DEFAULT_APP_TITLE}

from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Any

import numpy as np
import pandas as pd
import requests
import yfinance as yf


POLY_GAMMA_BASE_URL = "https://gamma-api.polymarket.com"
REQUEST_TIMEOUT_SECONDS = 8
CORE_OIL_KEYWORDS = {"crude", "oil", "wti", "cl"}


def utc_now() -> datetime:
    """Return timezone-aware UTC now."""
    return datetime.now(timezone.utc)


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
    elif isinstance(value, str):
        text = value.strip().strip('"').strip("'").replace("%", "")
        if not text:
            return None
        if text.startswith("[") and text.endswith("]"):
            return None
        try:
            numeric = float(text)
        except ValueError:
            return None
    else:
        return None

    if np.isfinite(numeric):
        return numeric
    return None


def _normalize_probability(value: float) -> float:
    if value > 1.0:
        value = value / 100.0
    return max(0.0, min(1.0, value))


def _request_json(path: str, params: dict[str, Any] | None = None) -> Any:
    url = f"{POLY_GAMMA_BASE_URL}{path}"
    try:
        response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
    except requests.RequestException as exc:
        raise RuntimeError(f"Polymarket request failed: {exc}") from exc

    if response.status_code >= 500:
        raise RuntimeError(f"Polymarket server error ({response.status_code}) for {path}.")
    if response.status_code == 404:
        return None
    if response.status_code >= 400:
        raise RuntimeError(f"Polymarket request error ({response.status_code}) for {path}.")

    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError(f"Polymarket response was not valid JSON for {path}.") from exc


def _market_text_blob(market: dict[str, Any]) -> str:
    fields = (
        market.get("question", ""),
        market.get("title", ""),
        market.get("name", ""),
        market.get("slug", ""),
        market.get("eventTitle", ""),
    )
    return " ".join(str(value) for value in fields if value is not None).lower()


def _market_tokens(market: dict[str, Any]) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", _market_text_blob(market)))


def _is_oil_relevant(market: dict[str, Any]) -> bool:
    tokens = _market_tokens(market)
    core_hits = tokens.intersection(CORE_OIL_KEYWORDS)
    if core_hits:
        return True
    # "Brent" as a standalone token is often a person name, not Brent crude.
    return "brent" in tokens and ("crude" in tokens or "oil" in tokens or "wti" in tokens or "cl" in tokens)


def _event_markets_to_list(events_payload: Any) -> list[dict[str, Any]]:
    if not isinstance(events_payload, list):
        return []

    markets: list[dict[str, Any]] = []
    for event in events_payload:
        if not isinstance(event, dict):
            continue
        event_title = str(event.get("title") or event.get("question") or "").strip()
        event_markets = event.get("markets")
        if not isinstance(event_markets, list):
            continue
        for market in event_markets:
            if not isinstance(market, dict):
                continue
            market_copy = dict(market)
            if event_title and not market_copy.get("eventTitle"):
                market_copy["eventTitle"] = event_title
            markets.append(market_copy)
    return markets


def _relevance_score(market: dict[str, Any], query_tokens: list[str]) -> tuple[float, float, int, float, float]:
    tokens = _market_tokens(market)
    if not tokens:
        return (0.0, 0.0, 0, 0.0, 0.0)

    query_hits = len([token for token in query_tokens if token in tokens])
    oil_hits = len(tokens.intersection(CORE_OIL_KEYWORDS)) + (
        1 if ("brent" in tokens and ("crude" in tokens or "oil" in tokens or "wti" in tokens or "cl" in tokens)) else 0
    )
    active_open = int(market.get("active") is True and market.get("closed") is False)
    volume = _safe_float(market.get("volume")) or 0.0
    liquidity = _safe_float(market.get("liquidity")) or 0.0
    return (float(query_hits), float(oil_hits), active_open, volume, liquidity)


def fetch_polymarket_market_by_slug(slug: str) -> dict[str, Any]:
    """Fetch a market using the documented slug endpoint."""
    clean_slug = slug.strip()
    if not clean_slug:
        raise ValueError("Market slug is empty.")

    payload = _request_json(f"/markets/slug/{clean_slug}")
    if payload is None or not isinstance(payload, dict):
        raise ValueError(f"No market found for slug '{clean_slug}'.")

    returned_slug = str(payload.get("slug", "")).strip()
    if not returned_slug:
        raise ValueError(f"No market found for slug '{clean_slug}'.")
    if returned_slug != clean_slug:
        raise ValueError(f"Slug mismatch for '{clean_slug}' (got '{returned_slug}').")
    return payload


def fetch_polymarket_markets_search(query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Manual search fallback with strict oil keyword filtering."""
    clean_query = query.strip()
    if not clean_query:
        return []

    safe_limit = max(1, min(100, int(limit)))
    query_tokens = [token for token in re.findall(r"[a-z0-9]+", clean_query.lower()) if len(token) > 1]

    merged: list[dict[str, Any]] = []
    seen_slugs: set[str] = set()

    # Broad endpoint from docs. We treat it as a discovery source only and filter aggressively.
    search_payload = _request_json("/public-search", params={"q": clean_query})
    if isinstance(search_payload, dict) and isinstance(search_payload.get("events"), list):
        for market in _event_markets_to_list(search_payload["events"]):
            slug = str(market.get("slug", "")).strip()
            if slug and slug not in seen_slugs:
                seen_slugs.add(slug)
                merged.append(market)

    # Active events endpoint keeps a live pool of currently tradable markets.
    active_events = _request_json("/events", params={"active": "true", "closed": "false", "limit": 1000})
    for market in _event_markets_to_list(active_events):
        slug = str(market.get("slug", "")).strip()
        if slug and slug not in seen_slugs:
            seen_slugs.add(slug)
            merged.append(market)

    if not merged:
        return []

    oil_relevant = [market for market in merged if _is_oil_relevant(market)]
    if not oil_relevant:
        return []

    active_open = [m for m in oil_relevant if m.get("active") is True and m.get("closed") is False]
    candidate_pool = active_open if active_open else oil_relevant

    scored = [(_relevance_score(market, query_tokens), market) for market in candidate_pool]
    scored.sort(key=lambda row: row[0], reverse=True)
    return [market for _, market in scored[:safe_limit]]


def parse_market_title(market_json: dict[str, Any]) -> str:
    """Extract a readable market title from a market payload."""
    for key in ("question", "title", "name"):
        value = market_json.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "Unknown Polymarket market"


def parse_yes_probability(market_json: dict[str, Any]) -> float:
    """Parse current YES probability as a 0-1 float from a market payload."""
    direct_keys = ("yesPrice", "yes_price", "yesProbability", "probability", "lastTradePrice")
    for key in direct_keys:
        numeric = _safe_float(market_json.get(key))
        if numeric is not None:
            return _normalize_probability(numeric)

    tokens = market_json.get("tokens")
    if isinstance(tokens, list):
        for token in tokens:
            if not isinstance(token, dict):
                continue
            outcome = str(token.get("outcome", "")).strip().lower()
            if outcome != "yes":
                continue
            for key in ("price", "lastPrice", "probability"):
                numeric = _safe_float(token.get(key))
                if numeric is not None:
                    return _normalize_probability(numeric)

    outcomes = market_json.get("outcomes")
    outcome_prices = market_json.get("outcomePrices")
    if isinstance(outcomes, list):
        prices_list: list[Any] | None = None
        if isinstance(outcome_prices, list):
            prices_list = outcome_prices
        elif isinstance(outcome_prices, str):
            stripped = outcome_prices.strip().strip("[]")
            prices_list = [part.strip() for part in stripped.split(",")] if stripped else []

        if prices_list:
            for idx, outcome in enumerate(outcomes):
                if str(outcome).strip().lower() != "yes":
                    continue
                if idx < len(prices_list):
                    numeric = _safe_float(prices_list[idx])
                    if numeric is not None:
                        return _normalize_probability(numeric)

    raise ValueError("Could not parse YES probability from Polymarket response.")


def parse_market_status(market_json: dict[str, Any]) -> str:
    """Return a compact status string for display."""
    for key in ("status", "state"):
        value = market_json.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    active = market_json.get("active")
    closed = market_json.get("closed")
    if active is True and closed is False:
        return "active"
    if closed is True:
        return "closed"
    return "unknown"


def extract_expiry_from_market(market_json: dict[str, Any]) -> datetime | None:
    """Try to extract an expiry-like datetime from known market fields."""
    candidate_fields = (
        "endDate",
        "end_date",
        "endTime",
        "closeTime",
        "expirationDate",
        "resolveDate",
        "resolutionDate",
    )
    for key in candidate_fields:
        raw = market_json.get(key)
        if raw in (None, ""):
            continue
        parsed = pd.to_datetime(raw, utc=True, errors="coerce")
        if pd.notna(parsed):
            return parsed.to_pydatetime()
    return None


def get_crude_price() -> float:
    """Fetch front-month crude proxy (CL=F) using yfinance."""
    ticker = yf.Ticker("CL=F")

    try:
        intraday = ticker.history(period="1d", interval="1m", auto_adjust=False)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Failed to fetch CL=F intraday history: {exc}") from exc

    if intraday is not None and not intraday.empty:
        close_series = intraday.get("Close")
        if close_series is not None and not close_series.dropna().empty:
            return float(close_series.dropna().iloc[-1])

    try:
        daily = ticker.history(period="5d", interval="1d", auto_adjust=False)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Failed to fetch CL=F daily history: {exc}") from exc

    if daily is None or daily.empty:
        raise RuntimeError("CL=F returned no data.")

    close_series = daily.get("Close")
    if close_series is None or close_series.dropna().empty:
        raise RuntimeError("CL=F close prices were empty.")

    return float(close_series.dropna().iloc[-1])

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
import re
from typing import Any

import requests

from kalshi_auth import KalshiAuth
from state import parse_timestamp_ms, safe_float

NUMBER_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")


def parse_kalshi_datetime(value: Any) -> datetime | None:
    timestamp_ms = parse_timestamp_ms(value)
    if timestamp_ms is None:
        return None
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC)


def best_yes_bid(market: dict[str, Any]) -> float | None:
    bid = safe_float(market.get("yes_bid_dollars"))
    if bid is not None:
        return bid
    no_ask = safe_float(market.get("no_ask_dollars"))
    if no_ask is None:
        return None
    return max(0.0, 1.0 - no_ask)


def best_yes_ask(market: dict[str, Any]) -> float | None:
    ask = safe_float(market.get("yes_ask_dollars"))
    if ask is not None:
        return ask
    no_bid = safe_float(market.get("no_bid_dollars"))
    if no_bid is None:
        return None
    return min(1.0, max(0.0, 1.0 - no_bid))


def _top_orderbook_price(levels: Any) -> float | None:
    if not isinstance(levels, list) or not levels:
        return None
    last_level = levels[-1]
    if not isinstance(last_level, list) or not last_level:
        return None
    return safe_float(last_level[0])


def best_yes_bid_from_orderbook(orderbook: dict[str, Any]) -> float | None:
    return _top_orderbook_price(orderbook.get("yes_dollars"))


def best_yes_ask_from_orderbook(orderbook: dict[str, Any]) -> float | None:
    best_no_bid = _top_orderbook_price(orderbook.get("no_dollars"))
    if best_no_bid is None:
        return None
    return min(1.0, max(0.0, 1.0 - best_no_bid))


def midpoint_from_market(market: dict[str, Any]) -> float | None:
    bid = best_yes_bid(market)
    ask = best_yes_ask(market)
    if bid is not None and ask is not None:
        return (bid + ask) / 2.0
    return safe_float(market.get("last_price_dollars"))


def spread_from_market(market: dict[str, Any]) -> float | None:
    bid = best_yes_bid(market)
    ask = best_yes_ask(market)
    if bid is None or ask is None:
        return None
    return ask - bid


def extract_contract_strike(market: dict[str, Any]) -> float | None:
    for field_name in ("subtitle", "yes_sub_title", "title"):
        text = market.get(field_name)
        if not isinstance(text, str):
            continue
        match = NUMBER_RE.search(text.replace(",", ""))
        if match:
            try:
                return float(match.group(0))
            except ValueError:
                continue

    strike_type = str(market.get("strike_type") or "").lower()
    floor_strike = safe_float(market.get("floor_strike"))
    if strike_type == "greater" and floor_strike is not None:
        return round(floor_strike + 0.01, 2)

    cap_strike = safe_float(market.get("cap_strike"))
    if strike_type == "less" and cap_strike is not None:
        return cap_strike

    return floor_strike or cap_strike


def quote_from_market(market: dict[str, Any]) -> dict[str, Any]:
    updated_ts = (
        parse_timestamp_ms(market.get("updated_time"))
        or parse_timestamp_ms(market.get("created_time"))
        or parse_timestamp_ms(market.get("close_time"))
    )
    return {
        "bestBid": best_yes_bid(market),
        "bestAsk": best_yes_ask(market),
        "midpoint": midpoint_from_market(market),
        "spread": spread_from_market(market),
        "lastTrade": safe_float(market.get("last_price_dollars")),
        "timestamp": updated_ts,
        "volume": market.get("volume_fp"),
        "openInterest": market.get("open_interest_fp"),
    }


def quote_from_orderbook(
    orderbook: dict[str, Any],
    *,
    market: dict[str, Any] | None = None,
) -> dict[str, Any]:
    market_payload = market or {}
    best_bid = best_yes_bid_from_orderbook(orderbook)
    best_ask = best_yes_ask_from_orderbook(orderbook)
    midpoint = (
        (best_bid + best_ask) / 2.0
        if best_bid is not None and best_ask is not None
        else safe_float(market_payload.get("last_price_dollars"))
    )
    spread = (
        best_ask - best_bid
        if best_bid is not None and best_ask is not None
        else None
    )
    updated_ts = (
        parse_timestamp_ms(market_payload.get("updated_time"))
        or parse_timestamp_ms(market_payload.get("created_time"))
        or parse_timestamp_ms(market_payload.get("close_time"))
    )
    return {
        "bestBid": best_bid,
        "bestAsk": best_ask,
        "midpoint": midpoint,
        "spread": spread,
        "lastTrade": safe_float(market_payload.get("last_price_dollars")),
        "timestamp": updated_ts,
        "volume": market_payload.get("volume_fp"),
        "openInterest": market_payload.get("open_interest_fp"),
    }


class KalshiRestClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout: float,
        auth: KalshiAuth | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.auth = auth
        self._session = requests.Session()
        self._session.trust_env = False

    def _get(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        signed: bool = False,
    ) -> dict[str, Any]:
        headers = self.auth.headers("GET", path) if signed and self.auth else {}
        response = self._session.get(
            f"{self.base_url}{path}",
            params=params,
            headers=headers,
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError(f"Unexpected Kalshi response for {path}.")
        return payload

    def get_series(self, series_ticker: str) -> dict[str, Any]:
        payload = self._get(f"/series/{series_ticker}")
        return payload.get("series") or {}

    def get_event(self, event_ticker: str) -> dict[str, Any]:
        payload = self._get(f"/events/{event_ticker}")
        return payload.get("event") or {}

    def get_market(self, market_ticker: str) -> dict[str, Any]:
        payload = self._get(f"/markets/{market_ticker}")
        return payload.get("market") or {}

    def get_orderbook(self, market_ticker: str) -> dict[str, Any]:
        payload = self._get(f"/markets/{market_ticker}/orderbook")
        return payload.get("orderbook_fp") or {}

    def list_markets(
        self,
        *,
        series_ticker: str | None = None,
        status: str | None = "open",
        limit: int = 200,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        params: dict[str, Any] = {"limit": limit}
        if series_ticker:
            params["series_ticker"] = series_ticker
        if status:
            params["status"] = status
        if cursor:
            params["cursor"] = cursor
        payload = self._get("/markets", params=params)
        rows = payload.get("markets")
        cursor_value = payload.get("cursor")
        return (
            [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else [],
            str(cursor_value) if cursor_value else None,
        )

    def get_markets(self, series_ticker: str, status: str = "open") -> list[dict[str, Any]]:
        markets: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            batch, cursor = self.list_markets(
                series_ticker=series_ticker,
                status=status,
                limit=200,
                cursor=cursor,
            )
            markets.extend(batch)
            if not cursor:
                break
        return markets

    def get_trades(
        self,
        market_ticker: str,
        *,
        limit: int = 200,
        cursor: str | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        params: dict[str, Any] = {"ticker": market_ticker, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        payload = self._get("/markets/trades", params=params)
        rows = payload.get("trades")
        cursor_value = payload.get("cursor")
        return (
            [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else [],
            str(cursor_value) if cursor_value else None,
        )

    def get_recent_trades(
        self,
        market_ticker: str,
        *,
        max_pages: int = 5,
        page_size: int = 200,
    ) -> list[dict[str, Any]]:
        trades: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(max_pages):
            batch, cursor = self.get_trades(
                market_ticker,
                limit=page_size,
                cursor=cursor,
            )
            if not batch:
                break
            trades.extend(batch)
            if not cursor:
                break
        return trades

    def discover_series_by_keyword(
        self,
        *,
        keywords: tuple[str, ...] = ("wti", "oil"),
        max_pages: int = 10,
    ) -> str | None:
        series_scores: dict[str, int] = defaultdict(int)
        cursor: str | None = None
        for _ in range(max_pages):
            batch, cursor = self.list_markets(status="open", limit=200, cursor=cursor)
            for market in batch:
                blob = " ".join(
                    str(market.get(field) or "")
                    for field in ("title", "subtitle", "ticker", "event_ticker", "series_ticker")
                ).lower()
                if not any(keyword in blob for keyword in keywords):
                    continue
                series_ticker = str(market.get("series_ticker") or "").upper()
                if series_ticker:
                    series_scores[series_ticker] += 1
            if not cursor:
                break
        if not series_scores:
            return None
        return max(series_scores.items(), key=lambda item: item[1])[0]

    def discover_best_market(
        self,
        *,
        series_ticker: str,
        target_event_ticker: str | None = None,
        target_market_ticker: str | None = None,
        target_strike: float | None = None,
        max_event_days: int = 7,
    ) -> dict[str, Any] | None:
        if target_market_ticker:
            market = self.get_market(target_market_ticker)
            return market or None

        markets = self.get_markets(series_ticker)
        if not markets:
            return None

        if target_event_ticker:
            candidates = [
                market
                for market in markets
                if str(market.get("event_ticker") or "").upper()
                == target_event_ticker.upper()
            ]
        else:
            candidates = self._select_nearest_event_markets(
                markets,
                max_event_days=max_event_days,
            )

        if not candidates:
            return None

        preferred_direction = [
            market
            for market in candidates
            if str(market.get("strike_type") or "").lower() == "greater"
        ]
        if preferred_direction:
            candidates = preferred_direction

        if target_strike is not None:
            candidates = sorted(
                candidates,
                key=lambda market: (
                    abs((extract_contract_strike(market) or target_strike) - target_strike),
                    abs((midpoint_from_market(market) or 0.5) - 0.5),
                    -(safe_float(market.get("volume_fp")) or 0.0),
                ),
            )
            return candidates[0]

        return min(
            candidates,
            key=lambda market: (
                abs((midpoint_from_market(market) or 0.5) - 0.5),
                spread_from_market(market) or 1.0,
                -(safe_float(market.get("volume_fp")) or 0.0),
            ),
        )

    def _select_nearest_event_markets(
        self,
        markets: list[dict[str, Any]],
        *,
        max_event_days: int,
    ) -> list[dict[str, Any]]:
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for market in markets:
            event_ticker = str(market.get("event_ticker") or "")
            if event_ticker:
                grouped[event_ticker].append(market)

        now = datetime.now(UTC)
        deadline = now + timedelta(days=max_event_days)
        ranked_events: list[tuple[datetime, str, list[dict[str, Any]]]] = []
        fallback_events: list[tuple[datetime, str, list[dict[str, Any]]]] = []

        for event_ticker, event_markets in grouped.items():
            close_candidates = [
                parse_kalshi_datetime(market.get("close_time"))
                for market in event_markets
            ]
            close_times = [value for value in close_candidates if value is not None]
            if not close_times:
                continue
            event_close = min(close_times)
            if event_close >= now and event_close <= deadline:
                ranked_events.append((event_close, event_ticker, event_markets))
            elif event_close >= now:
                fallback_events.append((event_close, event_ticker, event_markets))

        active_pool = ranked_events or fallback_events
        if not active_pool:
            return markets

        active_pool.sort(key=lambda item: item[0])
        return active_pool[0][2]

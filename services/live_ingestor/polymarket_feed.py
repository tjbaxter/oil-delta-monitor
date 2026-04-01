from __future__ import annotations

import json
from threading import Thread
import time
from typing import Any

import requests
from websocket import WebSocketApp

from config import IngestorConfig
from state import LiveState, parse_timestamp_ms, safe_float, utc_now_ms


def _request_json(
    method: str,
    url: str,
    *,
    timeout: float,
    params: dict[str, Any] | None = None,
    json_body: Any = None,
) -> Any:
    session = requests.Session()
    session.trust_env = False
    response = session.request(
        method,
        url,
        params=params,
        json=json_body,
        timeout=timeout,
    )
    response.raise_for_status()
    return response.json()


def _listify(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _resolve_market_by_slug(config: IngestorConfig) -> dict[str, Any]:
    url = f"{config.polymarket_gamma_base_url}/markets/slug/{config.market_slug}"
    payload = _request_json("GET", url, timeout=config.request_timeout_seconds)
    if isinstance(payload, list):
        if not payload:
            raise ValueError(f"No Polymarket market found for slug {config.market_slug}.")
        return payload[0]
    if isinstance(payload, dict):
        return payload
    raise ValueError("Unexpected Polymarket slug response.")


def _select_yes_token(market: dict[str, Any]) -> tuple[str, str | None]:
    clob_token_ids = [str(token) for token in _listify(market.get("clobTokenIds"))]
    outcomes = [str(outcome).strip().lower() for outcome in _listify(market.get("outcomes"))]
    if outcomes and clob_token_ids and len(outcomes) == len(clob_token_ids):
        for index, outcome in enumerate(outcomes):
            if outcome == "yes":
                return clob_token_ids[index], clob_token_ids[1 - index] if len(clob_token_ids) > 1 else None
    if clob_token_ids:
        return clob_token_ids[0], clob_token_ids[1] if len(clob_token_ids) > 1 else None
    raise ValueError("Unable to resolve YES token id for Polymarket market.")


def _build_market_metadata(market: dict[str, Any]) -> dict[str, Any]:
    yes_token_id, no_token_id = _select_yes_token(market)
    outcome_prices = [safe_float(price) for price in _listify(market.get("outcomePrices"))]
    return {
        "title": str(market.get("question") or market.get("title") or "Unknown market"),
        "question": str(market.get("question") or market.get("title") or "Unknown market"),
        "slug": str(market.get("slug") or ""),
        "endDate": market.get("endDate")
        or market.get("end_date_iso")
        or market.get("end_date")
        or market.get("endDatetime"),
        "active": bool(market.get("active", True)),
        "closed": bool(market.get("closed", False)),
        "conditionId": market.get("conditionId"),
        "clobTokenIds": [str(token) for token in _listify(market.get("clobTokenIds"))],
        "yesTokenId": yes_token_id,
        "noTokenId": no_token_id,
        "marketPrice": outcome_prices[0] if outcome_prices else None,
        "historySource": "seed_trade_history_plus_live_recorder",
    }


def _fetch_trade_history(
    config: IngestorConfig, yes_token_id: str
) -> list[dict[str, Any]]:
    end_ms = utc_now_ms()
    start_ms = end_ms - config.seed_lookback_hours * 60 * 60 * 1000
    payload = _request_json(
        "GET",
        f"{config.polymarket_clob_base_url}/prices-history",
        timeout=config.request_timeout_seconds,
        params={
            "market": yes_token_id,
            "interval": "1m",
            "fidelity": "10",
            "startTs": str(start_ms // 1000),
            "endTs": str(end_ms // 1000),
        },
    )
    history = payload.get("history") if isinstance(payload, dict) else []
    points: list[dict[str, Any]] = []
    for point in history or []:
        timestamp_ms = parse_timestamp_ms(point.get("t"))
        price = safe_float(point.get("p"))
        if timestamp_ms is None or price is None:
            continue
        points.append(
            {
                "timestamp": timestamp_ms,
                "price": price,
                "displaySource": "tradeHistory",
                "seededFrom": "clob_prices_history",
            }
        )
    return sorted(points, key=lambda point: point["timestamp"])


def _top_price(levels: Any, *, side: str) -> float | None:
    if not isinstance(levels, list) or not levels:
        return None
    prices = [
        safe_float(level.get("price"))
        for level in levels
        if isinstance(level, dict)
    ]
    filtered = [price for price in prices if price is not None]
    if not filtered:
        return None
    if side == "bid":
        return max(filtered)
    return min(filtered)


def _fetch_current_quote(
    config: IngestorConfig, yes_token_id: str
) -> dict[str, Any]:
    book = _request_json(
        "GET",
        f"{config.polymarket_clob_base_url}/book",
        timeout=config.request_timeout_seconds,
        params={"token_id": yes_token_id},
    )
    midpoint = _request_json(
        "GET",
        f"{config.polymarket_clob_base_url}/midpoint",
        timeout=config.request_timeout_seconds,
        params={"token_id": yes_token_id},
    )
    spreads = _request_json(
        "POST",
        f"{config.polymarket_clob_base_url}/spreads",
        timeout=config.request_timeout_seconds,
        json_body=[{"token_id": yes_token_id}],
    )
    last_trades = _request_json(
        "POST",
        f"{config.polymarket_clob_base_url}/last-trades-prices",
        timeout=config.request_timeout_seconds,
        json_body=[{"token_id": yes_token_id}],
    )

    last_trade_row = (
        last_trades[0]
        if isinstance(last_trades, list) and last_trades
        else {}
    )
    spread_value = (
        safe_float(spreads.get(yes_token_id))
        if isinstance(spreads, dict)
        else None
    )
    return {
        "bestBid": _top_price(book.get("bids"), side="bid"),
        "bestAsk": _top_price(book.get("asks"), side="ask"),
        "midpoint": safe_float(midpoint.get("mid_price") or midpoint.get("mid")),
        "spread": spread_value,
        "lastTrade": safe_float(last_trade_row.get("price")),
        "timestamp": parse_timestamp_ms(book.get("timestamp")) or utc_now_ms(),
    }


def bootstrap_polymarket_state(config: IngestorConfig, state: LiveState) -> None:
    try:
        market = _resolve_market_by_slug(config)
        metadata = _build_market_metadata(market)
        state.set_market_metadata(metadata)

        history = _fetch_trade_history(config, metadata["yesTokenId"])
        if history:
            state.seed_poly_history(history)
        else:
            state.add_warning("Polymarket history warning: prices-history returned no rows.")

        quote = _fetch_current_quote(config, metadata["yesTokenId"])
        state.update_poly_quote(
            best_bid=quote.get("bestBid"),
            best_ask=quote.get("bestAsk"),
            midpoint=quote.get("midpoint"),
            spread=quote.get("spread"),
            last_trade=quote.get("lastTrade"),
            market_price=metadata.get("marketPrice"),
            event_ts=quote.get("timestamp"),
            history_source="seed_trade_history_plus_live_recorder",
        )
        state.set_feed_status(
            "polymarket",
            "warming",
            detail="REST seed ready; waiting for websocket",
            event_ts=quote.get("timestamp"),
            error=None,
        )
        state.clear_warning("Polymarket bootstrap error")
    except Exception as exc:  # pragma: no cover - network/runtime dependent
        state.add_warning(f"Polymarket bootstrap error: {exc}")
        state.set_feed_status(
            "polymarket",
            "disconnected",
            detail="REST seed failed",
            error=str(exc),
        )


class PolymarketFeed(Thread):
    def __init__(self, config: IngestorConfig, state: LiveState):
        super().__init__(daemon=True)
        self.config = config
        self.state = state

    @property
    def yes_token_id(self) -> str:
        return self.state.market.yes_token_id

    def run(self) -> None:  # pragma: no cover - long-running integration code
        backoff_seconds = 1.0
        while True:
            try:
                self.state.set_feed_status(
                    "polymarket",
                    "reconnecting",
                    detail="Connecting market websocket",
                    error=None,
                )
                app = WebSocketApp(
                    self.config.polymarket_ws_url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                app.run_forever(
                    ping_interval=10,
                    ping_timeout=5,
                    http_proxy_host=None,
                    http_proxy_port=None,
                )
            except Exception as exc:
                self.state.add_warning(f"Polymarket websocket error: {exc}")
                self.state.set_feed_status(
                    "polymarket",
                    "reconnecting",
                    detail="Market websocket retrying",
                    error=str(exc),
                    increment_reconnect=True,
                )
            time.sleep(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, 30.0)

    def _on_open(self, ws: WebSocketApp) -> None:
        if not self.yes_token_id:
            return
        ws.send(
            json.dumps(
                {
                    "assets_ids": [self.yes_token_id],
                    "type": "market",
                    "custom_feature_enabled": True,
                }
            )
        )
        self.state.set_feed_status(
            "polymarket",
            "connected",
            detail="market websocket",
            error=None,
        )

    def _on_message(self, _ws: WebSocketApp, message: str) -> None:
        if not message or message in {"PING", "PONG"}:
            return
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            return
        if isinstance(payload, list):
            for event in payload:
                self._handle_event(event)
            return
        self._handle_event(payload)

    def _handle_event(self, event: Any) -> None:
        if not isinstance(event, dict):
            return
        event_type = str(event.get("event_type") or "")
        timestamp_ms = parse_timestamp_ms(event.get("timestamp")) or utc_now_ms()

        if event_type == "book":
            if str(event.get("asset_id") or "") != self.yes_token_id:
                return
            self.state.update_poly_quote(
                best_bid=_top_price(event.get("bids"), side="bid"),
                best_ask=_top_price(event.get("asks"), side="ask"),
                event_ts=timestamp_ms,
            )
        elif event_type == "best_bid_ask":
            if str(event.get("asset_id") or "") != self.yes_token_id:
                return
            self.state.update_poly_quote(
                best_bid=safe_float(event.get("best_bid")),
                best_ask=safe_float(event.get("best_ask")),
                spread=safe_float(event.get("spread")),
                event_ts=timestamp_ms,
            )
        elif event_type == "price_change":
            for change in event.get("price_changes") or []:
                if str(change.get("asset_id") or "") != self.yes_token_id:
                    continue
                self.state.update_poly_quote(
                    best_bid=safe_float(change.get("best_bid")),
                    best_ask=safe_float(change.get("best_ask")),
                    event_ts=timestamp_ms,
                )
        elif event_type == "last_trade_price":
            if str(event.get("asset_id") or "") != self.yes_token_id:
                return
            self.state.update_poly_quote(
                last_trade=safe_float(event.get("price")),
                event_ts=timestamp_ms,
            )
        elif event_type == "market_resolved":
            self.state.add_warning("Polymarket market resolved.")
            self.state.set_market_metadata({"closed": True})
        else:
            return

        self.state.set_feed_status(
            "polymarket",
            "connected",
            detail="market websocket",
            event_ts=timestamp_ms,
            error=None,
        )

    def _on_error(self, _ws: WebSocketApp, error: Any) -> None:
        self.state.add_warning(f"Polymarket websocket error: {error}")
        self.state.set_feed_status(
            "polymarket",
            "reconnecting",
            detail="Market websocket error",
            error=str(error),
        )

    def _on_close(
        self, _ws: WebSocketApp, _status_code: int | None, message: str | None
    ) -> None:
        detail = "Market websocket closed"
        if message:
            detail = f"{detail}: {message}"
        self.state.set_feed_status(
            "polymarket",
            "reconnecting",
            detail=detail,
            increment_reconnect=True,
        )

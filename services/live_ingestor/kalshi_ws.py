from __future__ import annotations

import json
import logging
from typing import Any, Callable

import websockets

from kalshi_auth import KalshiAuth
from state import parse_timestamp_ms

logger = logging.getLogger(__name__)


class KalshiWebSocketClient:
    def __init__(
        self,
        *,
        auth: KalshiAuth,
        ws_url: str,
        market_ticker: str,
        on_ticker: Callable[[dict[str, Any]], None],
        on_trade: Callable[[dict[str, Any]], None],
        on_status_change: Callable[[str], None] | None = None,
    ):
        self.auth = auth
        self.ws_url = ws_url
        self.market_ticker = market_ticker
        self.on_ticker = on_ticker
        self.on_trade = on_trade
        self.on_status_change = on_status_change
        self._message_id = 1
        self._ws: Any = None

    async def connect(self) -> None:
        headers = self.auth.ws_headers()
        self._ws = await websockets.connect(
            self.ws_url,
            additional_headers=headers,
            ping_interval=20,
            ping_timeout=20,
        )
        await self._subscribe("ticker", [self.market_ticker])
        await self._subscribe("trade", [self.market_ticker])
        if self.on_status_change:
            self.on_status_change("connected")

    async def _subscribe(self, channel: str, market_tickers: list[str]) -> None:
        if not self._ws:
            raise RuntimeError("Kalshi websocket is not connected.")
        payload = {
            "id": self._message_id,
            "cmd": "subscribe",
            "params": {
                "channels": [channel],
                "market_tickers": market_tickers,
            },
        }
        await self._ws.send(json.dumps(payload))
        self._message_id += 1

    async def listen(self) -> None:
        if not self._ws:
            raise RuntimeError("Kalshi websocket is not connected.")
        try:
            async for raw_message in self._ws:
                self._handle_message(raw_message)
        except websockets.exceptions.ConnectionClosed as exc:
            logger.warning("Kalshi websocket closed: %s", exc)
            if self.on_status_change:
                self.on_status_change("disconnected")
            raise

    def _handle_message(self, raw_message: Any) -> None:
        if isinstance(raw_message, bytes):
            raw_message = raw_message.decode("utf-8", errors="ignore")
        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.warning("Skipping non-JSON Kalshi websocket message.")
            return

        if not isinstance(payload, dict):
            return

        message_type = str(payload.get("type") or "")
        body = payload.get("msg") if isinstance(payload.get("msg"), dict) else {}
        if message_type == "ticker":
            self.on_ticker(self._normalize_ticker(body))
        elif message_type == "trade":
            self.on_trade(self._normalize_trade(body))
        elif message_type == "error":
            logger.error("Kalshi websocket error: %s", body)
            if self.on_status_change:
                self.on_status_change("error")

    def _normalize_ticker(self, message: dict[str, Any]) -> dict[str, Any]:
        timestamp_ms = parse_timestamp_ms(message.get("time"))
        if timestamp_ms is None:
            ts_seconds = message.get("ts")
            if isinstance(ts_seconds, (int, float)):
                timestamp_ms = int(float(ts_seconds) * 1000)

        best_bid = _to_float(message.get("yes_bid_dollars"))
        best_ask = _to_float(message.get("yes_ask_dollars"))
        midpoint = (best_bid + best_ask) / 2.0 if best_bid is not None and best_ask is not None else None
        spread = best_ask - best_bid if best_bid is not None and best_ask is not None else None

        return {
            "timestamp": timestamp_ms,
            "marketTicker": message.get("market_ticker"),
            "bestBid": best_bid,
            "bestAsk": best_ask,
            "midpoint": midpoint,
            "spread": spread,
            "lastTrade": _to_float(message.get("price_dollars")),
            "volume": message.get("volume_fp"),
            "openInterest": message.get("open_interest_fp"),
        }

    def _normalize_trade(self, message: dict[str, Any]) -> dict[str, Any]:
        timestamp_ms = None
        ts_seconds = message.get("ts")
        if isinstance(ts_seconds, (int, float)):
            timestamp_ms = int(float(ts_seconds) * 1000)
        return {
            "timestamp": timestamp_ms,
            "marketTicker": message.get("market_ticker"),
            "price": _to_float(message.get("yes_price_dollars")),
            "count": message.get("count_fp"),
            "takerSide": message.get("taker_side"),
            "tradeId": message.get("trade_id"),
        }

    async def close(self) -> None:
        if self._ws:
            await self._ws.close()


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None

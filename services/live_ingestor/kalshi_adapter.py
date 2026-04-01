from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from threading import Thread
import time
from typing import Any

from config import IngestorConfig
from kalshi_auth import KalshiAuth
from kalshi_rest import (
    KalshiRestClient,
    extract_contract_strike,
    midpoint_from_market,
    quote_from_orderbook,
    quote_from_market,
)
from kalshi_ws import KalshiWebSocketClient
from state import LiveState, parse_timestamp_ms, safe_float, utc_now_ms

KALSHI_HISTORY_SOURCE = "kalshi_trade_history_plus_live_recorder"


def _build_market_metadata(
    *,
    config: IngestorConfig,
    series: dict[str, Any],
    event: dict[str, Any],
    market: dict[str, Any],
) -> dict[str, Any]:
    market_ticker = str(market.get("ticker") or "")
    series_ticker = str(
        market.get("series_ticker") or series.get("ticker") or config.kalshi_series_ticker
    )
    title = str(
        market.get("title")
        or event.get("title")
        or event.get("event_ticker")
        or market_ticker
        or "Kalshi WTI market"
    )
    subtitle = str(market.get("subtitle") or market.get("yes_sub_title") or "").strip()
    contract_strike = extract_contract_strike(market)
    market_url = (
        f"{config.kalshi_web_market_base_url.rstrip('/')}/{series_ticker.lower()}"
        if series_ticker
        else config.kalshi_web_market_base_url
    )

    return {
        "title": title,
        "question": title,
        "slug": market_ticker,
        "marketTicker": market_ticker,
        "subtitle": subtitle or None,
        "venue": "kalshi",
        "endDate": market.get("close_time")
        or market.get("expected_expiration_time")
        or market.get("expiration_time"),
        "active": str(market.get("status") or "").lower() not in {"closed", "settled"},
        "closed": str(market.get("status") or "").lower() in {"closed", "settled"},
        "conditionId": None,
        "clobTokenIds": [],
        "yesTokenId": None,
        "noTokenId": None,
        "marketPrice": safe_float(market.get("last_price_dollars")),
        "historySource": KALSHI_HISTORY_SOURCE,
        "kalshiSeriesTicker": series_ticker or None,
        "kalshiEventTicker": str(
            market.get("event_ticker") or event.get("ticker") or ""
        )
        or None,
        "kalshiMarketTitle": title,
        "kalshiMarketUrl": market_url,
        "contractStrike": contract_strike,
        "strikeType": market.get("strike_type"),
    }


def seed_from_kalshi_trades(
    trades: list[dict[str, Any]],
    *,
    not_before_ms: int | None = None,
) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for trade in trades:
        timestamp_ms = parse_timestamp_ms(trade.get("created_time"))
        price = safe_float(trade.get("yes_price_dollars"))
        if timestamp_ms is None or price is None:
            continue
        if not_before_ms is not None and timestamp_ms < not_before_ms:
            continue
        points.append(
            {
                "timestamp": timestamp_ms,
                "price": price,
                "displaySource": "tradeHistory",
                "seededFrom": "kalshi_trade_history",
            }
        )
    return sorted(points, key=lambda point: point["timestamp"])


def bootstrap_kalshi_state(
    config: IngestorConfig,
    state: LiveState,
    rest_client: KalshiRestClient,
) -> dict[str, Any] | None:
    try:
        series_ticker = config.kalshi_series_ticker or rest_client.discover_series_by_keyword()
        if not series_ticker:
            raise ValueError("Unable to discover a Kalshi WTI series ticker.")

        series = rest_client.get_series(series_ticker)
        market = rest_client.discover_best_market(
            series_ticker=series_ticker,
            target_event_ticker=config.kalshi_target_event_ticker,
            target_market_ticker=config.kalshi_target_market_ticker,
            target_strike=config.kalshi_target_strike,
            max_event_days=config.kalshi_market_lookahead_days,
        )
        if not market:
            raise ValueError(f"No open Kalshi markets found for series {series_ticker}.")

        market_ticker = str(market.get("ticker") or "")
        detailed_market = rest_client.get_market(market_ticker) or market
        if "series_ticker" not in detailed_market and series_ticker:
            detailed_market["series_ticker"] = series_ticker

        event_ticker = str(detailed_market.get("event_ticker") or "")
        event = rest_client.get_event(event_ticker) if event_ticker else {}
        metadata = _build_market_metadata(
            config=config,
            series=series,
            event=event,
            market=detailed_market,
        )

        if metadata.get("contractStrike") is not None:
            config.pricing_defaults["strike"] = metadata["contractStrike"]

        state.set_market_metadata(metadata)

        seed_start = datetime.now(UTC) - timedelta(hours=config.seed_lookback_hours)
        trades = rest_client.get_recent_trades(market_ticker, max_pages=8, page_size=200)
        history = seed_from_kalshi_trades(
            trades,
            not_before_ms=int(seed_start.timestamp() * 1000),
        )
        if history:
            state.seed_poly_history(history)
        else:
            state.add_warning(f"Kalshi history warning: no recent trades for {market_ticker}.")

        quote = quote_from_market(detailed_market)
        state.update_poly_quote(
            best_bid=quote.get("bestBid"),
            best_ask=quote.get("bestAsk"),
            midpoint=quote.get("midpoint"),
            spread=quote.get("spread"),
            last_trade=quote.get("lastTrade"),
            market_price=quote.get("lastTrade"),
            event_ts=quote.get("timestamp"),
            history_source=KALSHI_HISTORY_SOURCE,
        )
        state.set_feed_status(
            "kalshi",
            "warming",
            detail=f"{market_ticker} REST seed ready; waiting for websocket",
            event_ts=quote.get("timestamp"),
            error=None,
        )
        state.clear_warning("Kalshi bootstrap error")
        return metadata
    except Exception as exc:
        state.add_warning(f"Kalshi bootstrap error: {exc}")
        state.set_feed_status(
            "kalshi",
            "disconnected",
            detail="Kalshi REST seed failed",
            error=str(exc),
        )
        return None


class KalshiAdapter(Thread):
    def __init__(self, config: IngestorConfig, state: LiveState):
        super().__init__(daemon=True)
        self.config = config
        self.state = state
        self._auth: KalshiAuth | None = None
        self._rest_client = KalshiRestClient(
            base_url=config.kalshi_rest_base_url,
            timeout=config.request_timeout_seconds,
        )

    def run(self) -> None:  # pragma: no cover - long-running integration code
        backoff_seconds = 1.0
        while True:
            try:
                metadata = bootstrap_kalshi_state(self.config, self.state, self._rest_client)
                market_ticker = (
                    str(metadata.get("marketTicker") or "")
                    if isinstance(metadata, dict)
                    else self.state.market.market_ticker
                )
                if not market_ticker:
                    raise ValueError("Kalshi bootstrap returned no market ticker.")

                if self.config.kalshi_use_rest_polling:
                    self._run_rest_polling(market_ticker)
                else:
                    auth = self._get_auth()
                    if auth is None:
                        self.state.set_feed_status(
                            "kalshi",
                            "disconnected",
                            detail="Kalshi REST seed only; missing API credentials for websocket",
                            error="Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH",
                        )
                        time.sleep(30.0)
                        backoff_seconds = 1.0
                        continue

                    self.state.set_feed_status(
                        "kalshi",
                        "reconnecting",
                        detail=f"Connecting websocket for {market_ticker}",
                        error=None,
                    )
                    asyncio.run(self._run_websocket(auth, market_ticker))
                backoff_seconds = 1.0
            except Exception as exc:
                transport_label = (
                    "REST polling" if self.config.kalshi_use_rest_polling else "websocket"
                )
                self.state.add_warning(f"Kalshi {transport_label} error: {exc}")
                self.state.set_feed_status(
                    "kalshi",
                    "reconnecting",
                    detail=f"Kalshi {transport_label} retrying",
                    error=str(exc),
                    increment_reconnect=True,
                )
                time.sleep(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2.0, 30.0)

    def _get_auth(self) -> KalshiAuth | None:
        if self._auth is not None:
            return self._auth
        if not self.config.kalshi_api_key_id or not self.config.kalshi_private_key_path:
            return None
        self._auth = KalshiAuth(
            self.config.kalshi_api_key_id,
            self.config.kalshi_private_key_path,
        )
        self._rest_client.auth = self._auth
        return self._auth

    async def _run_websocket(self, auth: KalshiAuth, market_ticker: str) -> None:
        client = KalshiWebSocketClient(
            auth=auth,
            ws_url=self.config.kalshi_ws_url,
            market_ticker=market_ticker,
            on_ticker=self._on_ticker,
            on_trade=self._on_trade,
            on_status_change=self._on_status_change,
        )
        try:
            await client.connect()
            await client.listen()
        finally:
            await client.close()

    def _run_rest_polling(self, market_ticker: str) -> None:
        poll_interval_seconds = max(self.config.kalshi_poll_interval_seconds, 0.25)
        refresh_interval_seconds = max(
            self.config.kalshi_market_refresh_seconds,
            poll_interval_seconds,
        )
        next_refresh_at = time.monotonic() + refresh_interval_seconds

        while True:
            market = self._rest_client.get_market(market_ticker)
            if not market:
                raise ValueError(f"Kalshi market lookup returned no data for {market_ticker}.")
            orderbook = self._rest_client.get_orderbook(market_ticker)
            poll_timestamp_ms = utc_now_ms()
            payload = {
                **quote_from_orderbook(orderbook, market=market),
                "marketTicker": market_ticker,
            }
            poll_label = (
                f"{market_ticker} REST poll every {poll_interval_seconds:.1f}s"
            )
            self._apply_polled_market_quote(
                payload,
                detail=poll_label,
                poll_timestamp_ms=poll_timestamp_ms,
            )
            self.state.clear_warning("Kalshi REST polling error")

            market_status = str(market.get("status") or "").lower()
            close_ts = parse_timestamp_ms(market.get("close_time"))
            if market_status in {"closed", "settled"} or (
                close_ts is not None and close_ts <= utc_now_ms()
            ):
                self.state.add_warning(
                    f"Kalshi market rollover triggered for {market_ticker}."
                )
                return

            if time.monotonic() >= next_refresh_at:
                candidate = self._discover_target_market()
                if candidate:
                    roll, reason = self._evaluate_roll(market_ticker, candidate)
                    if roll:
                        self.state.add_warning(
                            f"Kalshi {reason}: {market_ticker} → {candidate.get('ticker')}."
                        )
                        return
                next_refresh_at = time.monotonic() + refresh_interval_seconds

            time.sleep(poll_interval_seconds)

    def _discover_target_market(self) -> dict | None:
        """Returns the full market dict for the best available market, or None."""
        market = self._rest_client.discover_best_market(
            series_ticker=self.config.kalshi_series_ticker,
            target_event_ticker=self.config.kalshi_target_event_ticker,
            target_market_ticker=self.config.kalshi_target_market_ticker,
            target_strike=self.config.kalshi_target_strike,
            max_event_days=self.config.kalshi_market_lookahead_days,
        )
        if not isinstance(market, dict):
            return None
        return market if str(market.get("ticker") or "") else None

    def _evaluate_roll(
        self, market_ticker: str, candidate: dict
    ) -> tuple[bool, str]:
        """Decide whether to roll to the candidate market.

        Returns (should_roll, reason_label).

        Roll logic:
        - Different Kalshi event (day change) → always roll.
        - Same event, current mid still in [drift_low, drift_high] → stay.
        - Same event, current mid drifted out of band, AND candidate is at least
          min_strike_improvement closer to 50¢ → roll (intraday re-centre).
        """
        next_ticker = str(candidate.get("ticker") or "")
        if not next_ticker or next_ticker == market_ticker:
            return False, ""

        next_event = str(candidate.get("event_ticker") or "")
        current_event = self.state.market.kalshi_event_ticker or ""

        # Day roll: genuinely different event → always switch.
        if current_event and next_event and current_event != next_event:
            return True, "day roll"
        if not current_event or not next_event:
            return True, "market roll candidate detected"

        # Same event, different strike → hysteresis check.
        current_mid = self.state.market.midpoint
        if current_mid is None:
            current_mid = self.state.market.market_price
        if current_mid is None:
            return False, ""

        lo = self.config.kalshi_drift_threshold_low
        hi = self.config.kalshi_drift_threshold_high
        if lo <= current_mid <= hi:
            # Still tradeable — stay on current contract.
            return False, ""

        # Drifted outside the band.  Switch only if improvement is meaningful.
        next_mid = midpoint_from_market(candidate)
        if next_mid is None:
            return False, ""

        current_distance = abs(current_mid - 0.5)
        next_distance = abs(next_mid - 0.5)
        improvement = current_distance - next_distance

        if improvement >= self.config.kalshi_min_strike_improvement:
            logger.info(
                "Intraday re-centre: %s (mid=%.2f) → %s (mid=%.2f), improvement %.2f",
                market_ticker, current_mid, next_ticker, next_mid, improvement,
            )
            return True, (
                f"intraday re-centre: drifted to {current_mid:.2f}"
                f", switching to {next_ticker} (mid={next_mid:.2f})"
            )

        return False, ""

    def _apply_market_quote(
        self,
        payload: dict[str, Any],
        *,
        detail: str,
        history_source: str = "kalshi_live",
    ) -> None:
        event_ts = parse_timestamp_ms(payload.get("timestamp"))
        self.state.update_poly_quote(
            best_bid=safe_float(payload.get("bestBid")),
            best_ask=safe_float(payload.get("bestAsk")),
            midpoint=safe_float(payload.get("midpoint")),
            spread=safe_float(payload.get("spread")),
            last_trade=safe_float(payload.get("lastTrade")),
            market_price=safe_float(payload.get("lastTrade")),
            event_ts=event_ts,
            history_source=history_source,
        )
        self.state.set_feed_status(
            "kalshi",
            "connected",
            detail=detail,
            event_ts=event_ts,
            error=None,
        )
        self.state.clear_warning("Kalshi websocket error")
        self.state.clear_warning("Kalshi REST polling error")

    def _apply_polled_market_quote(
        self,
        payload: dict[str, Any],
        *,
        detail: str,
        poll_timestamp_ms: int,
    ) -> None:
        best_bid = safe_float(payload.get("bestBid"))
        best_ask = safe_float(payload.get("bestAsk"))
        midpoint = safe_float(payload.get("midpoint"))
        spread = safe_float(payload.get("spread"))
        last_trade = safe_float(payload.get("lastTrade"))
        with self.state.lock:
            market = self.state.market
            quote_changed = any(
                not _same_number_or_none(previous, current)
                for previous, current in (
                    (market.best_bid, best_bid),
                    (market.best_ask, best_ask),
                    (market.midpoint, midpoint),
                    (market.spread, spread),
                    (market.last_trade, last_trade),
                    (market.market_price, last_trade),
                )
            )
        if quote_changed:
            self.state.update_poly_quote(
                best_bid=best_bid,
                best_ask=best_ask,
                midpoint=midpoint,
                spread=spread,
                last_trade=last_trade,
                market_price=last_trade,
                event_ts=poll_timestamp_ms,
                history_source="kalshi_live",
            )
        self.state.set_feed_status(
            "kalshi",
            "connected",
            detail=detail,
            event_ts=poll_timestamp_ms,
            error=None,
        )
        self.state.clear_warning("Kalshi websocket error")
        self.state.clear_warning("Kalshi REST polling error")

    def _on_ticker(self, payload: dict[str, Any]) -> None:
        self._apply_market_quote(
            payload,
            detail=f"{payload.get('marketTicker') or self.state.market.market_ticker} ticker",
        )

    def _on_trade(self, payload: dict[str, Any]) -> None:
        event_ts = parse_timestamp_ms(payload.get("timestamp"))
        self.state.update_poly_quote(
            last_trade=safe_float(payload.get("price")),
            market_price=safe_float(payload.get("price")),
            event_ts=event_ts,
            history_source="kalshi_live",
        )
        self.state.set_feed_status(
            "kalshi",
            "connected",
            detail=f"{payload.get('marketTicker') or self.state.market.market_ticker} trade",
            event_ts=event_ts,
            error=None,
        )

    def _on_status_change(self, status: str) -> None:
        if status == "connected":
            self.state.set_feed_status(
                "kalshi",
                "connected",
                detail=f"{self.state.market.market_ticker} websocket",
                error=None,
            )
        elif status == "disconnected":
            self.state.set_feed_status(
                "kalshi",
                "reconnecting",
                detail="Kalshi websocket disconnected",
                increment_reconnect=True,
            )
        elif status == "error":
            self.state.set_feed_status(
                "kalshi",
                "reconnecting",
                detail="Kalshi websocket error",
                increment_reconnect=True,
            )


def _same_number_or_none(
    left: float | None, right: float | None, tolerance: float = 1e-9
) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return abs(left - right) <= tolerance

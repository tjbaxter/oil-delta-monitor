from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from math import erf, exp, log, sqrt, isfinite
from statistics import stdev
from threading import RLock
from typing import Any

EPSILON = 1e-12
EPSILON_S = 1e-9
EPSILON_T = 1 / (365 * 24 * 60)


def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_ms() -> int:
    return int(utc_now().timestamp() * 1000)


def to_iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def safe_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
        return number if number == number else None
    return None


def normalize_price(value: Any) -> float | None:
    parsed = safe_float(value)
    if parsed is None:
        return None
    return parsed / 1_000_000_000 if abs(parsed) >= 1_000_000 else parsed


def parse_timestamp_ms(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        raw = float(value)
        if raw > 1e18:
            return int(raw / 1_000_000)
        if raw > 1e15:
            return int(raw / 1_000)
        if raw > 1e12:
            return int(raw)
        return int(raw * 1000)
    if isinstance(value, str):
        clean = value.strip()
        if not clean:
            return None
        if clean.isdigit():
            try:
                return parse_timestamp_ms(int(clean))
            except ValueError:
                return None
        normalized = clean.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
        return int(parsed.astimezone(UTC).timestamp() * 1000)
    return None


def parse_expiry(expiry: str | None) -> datetime | None:
    if not expiry:
        return None
    text = expiry.strip()
    if not text:
        return None
    if len(text) == 10:
        try:
            parsed_date = date.fromisoformat(text)
        except ValueError:
            return None
        return datetime(
            parsed_date.year,
            parsed_date.month,
            parsed_date.day,
            23,
            59,
            59,
            tzinfo=UTC,
        )
    normalized = text.replace("Z", "+00:00")
    try:
        parsed_dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed_dt.astimezone(UTC)


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def bs_call_price(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if S <= 0 or K <= 0:
        raise ValueError("Underlying and strike must be positive.")
    variance_horizon = max(T, EPSILON_T)
    volatility = max(sigma, 1e-8)
    sqrt_T = sqrt(variance_horizon)
    d1 = (log(S / K) + (r + 0.5 * volatility * volatility) * variance_horizon) / (
        volatility * sqrt_T
    )
    d2 = d1 - volatility * sqrt_T
    return S * norm_cdf(d1) - K * exp(-r * variance_horizon) * norm_cdf(d2)


def tight_call_spread_fair_probability(
    S: float,
    strike: float,
    width: float,
    T: float,
    r: float,
    sigma: float,
) -> float:
    if width <= 0:
        raise ValueError("Spread width must be positive.")
    half_width = width / 2.0
    lower_strike = strike - half_width
    upper_strike = strike + half_width
    spread_value = bs_call_price(S, lower_strike, T, r, sigma) - bs_call_price(
        S, upper_strike, T, r, sigma
    )
    return min(1.0, max(0.0, spread_value / width))


def call_spread_delta(
    S: float,
    strike: float,
    width: float,
    T: float,
    r: float,
    sigma: float,
    h: float = 0.01,
) -> float:
    bump = max(abs(h), 1e-4)
    up_underlying = max(S + bump, EPSILON_S)
    down_underlying = max(S - bump, EPSILON_S)
    fair_up = tight_call_spread_fair_probability(
        up_underlying, strike, width, T, r, sigma
    )
    fair_down = tight_call_spread_fair_probability(
        down_underlying, strike, width, T, r, sigma
    )
    return (fair_up - fair_down) / (up_underlying - down_underlying)


def year_fraction_to_expiry(expiry: str | None, timestamp_ms: int) -> float:
    parsed_expiry = parse_expiry(expiry)
    if parsed_expiry is None:
        return EPSILON_T
    now_dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC)
    remaining_seconds = max((parsed_expiry - now_dt).total_seconds(), EPSILON_T * 365 * 24 * 60 * 60)
    return remaining_seconds / (365.0 * 24.0 * 60.0 * 60.0)


def instantaneous_delta(
    prev_prob: float | None,
    prev_price: float | None,
    curr_prob: float | None,
    curr_price: float | None,
) -> float | None:
    if (
        prev_prob is None
        or prev_price is None
        or curr_prob is None
        or curr_price is None
    ):
        return None
    d_price = curr_price - prev_price
    if abs(d_price) < EPSILON:
        return None
    return (curr_prob - prev_prob) / d_price


def rolling_regression_slope(
    x_values: list[float | None], y_values: list[float | None]
) -> float | None:
    points = [
        (x, y)
        for x, y in zip(x_values, y_values, strict=False)
        if x is not None and y is not None
    ]
    if len(points) < 2:
        return None
    x_mean = sum(x for x, _ in points) / len(points)
    y_mean = sum(y for _, y in points) / len(points)
    numerator = 0.0
    denominator = 0.0
    for x_value, y_value in points:
        x_diff = x_value - x_mean
        numerator += x_diff * (y_value - y_mean)
        denominator += x_diff * x_diff
    if abs(denominator) < EPSILON:
        return None
    return numerator / denominator


def classify_signal(
    fair_gap: float | None,
    delta_gap: float | None,
    fair_gap_threshold: float,
    delta_gap_threshold: float,
) -> str:
    if fair_gap is None or delta_gap is None:
        return "Neutral"
    if fair_gap > fair_gap_threshold and delta_gap > delta_gap_threshold:
        return "Market rich"
    if fair_gap < -fair_gap_threshold and delta_gap < -delta_gap_threshold:
        return "Market cheap"
    return "Neutral"



def _dedupe_points(points: list[dict[str, Any]], max_points: int) -> list[dict[str, Any]]:
    sorted_points = sorted(points, key=lambda point: point["timestamp"])
    deduped: list[dict[str, Any]] = []
    for point in sorted_points:
        if not deduped:
            deduped.append(point)
            continue
        last = deduped[-1]
        if (
            abs(last["timestamp"] - point["timestamp"]) < 1_000
            and last.get("price") == point.get("price")
            and last.get("displaySource") == point.get("displaySource")
            and last.get("markSource") == point.get("markSource")
        ):
            deduped[-1] = point
            continue
        deduped.append(point)
    return deduped[-max_points:]


def _nearest_crude_point_at_or_before(
    timestamp: int, crude_history: list[dict[str, Any]]
) -> dict[str, Any] | None:
    candidate: dict[str, Any] | None = None
    for point in crude_history:
        if point["timestamp"] <= timestamp:
            candidate = point
        else:
            break
    if candidate is not None:
        return candidate
    # No CL point at or before this timestamp.  Kalshi trade history is seeded
    # many hours back, but Databento replay only covers a short window.  Use
    # the earliest available CL price so those historical Kalshi ticks still
    # get a fair-value computation and the orange line spans the full chart.
    return crude_history[0] if crude_history else None


def build_observations(
    *,
    market_ticker: str,
    market_slug: str | None,
    yes_token_id: str | None,
    poly_history: list[dict[str, Any]],
    crude_history: list[dict[str, Any]],
    strike: float,
    spread_width: float,
    implied_vol: float,
    risk_free_rate: float,
    rolling_window: int,
    fair_gap_threshold: float,
    delta_gap_threshold: float,
    expiry: str | None,
    max_points: int,
) -> list[dict[str, Any]]:
    seeded: list[dict[str, Any]] = []
    for point in poly_history:
        crude_point = _nearest_crude_point_at_or_before(point["timestamp"], crude_history)
        crude_price = safe_float(crude_point["price"]) if crude_point else None
        observation = {
            "timestamp": point["timestamp"],
            "marketTicker": market_ticker,
            "marketSlug": market_slug or market_ticker,
            "yesTokenId": yes_token_id,
            "crudePrice": crude_price,
            "polyProb": safe_float(point.get("price")),
            "polyDisplaySource": point.get("displaySource") or "tradeHistory",
            "fairProb": None,
            "fairValueGap": None,
            "empiricalDeltaInst": None,
            "empiricalDeltaRoll": None,
            "theoreticalDelta": None,
            "deltaGap": None,
            "signal": "Neutral",
        }
        if (
            crude_price is not None
            and crude_price > 0
            and strike > 0
            and spread_width > 0
        ):
            try:
                horizon = year_fraction_to_expiry(expiry, point["timestamp"])
                observation["fairProb"] = tight_call_spread_fair_probability(
                    crude_price,
                    strike,
                    spread_width,
                    horizon,
                    risk_free_rate,
                    implied_vol,
                )
                observation["theoreticalDelta"] = call_spread_delta(
                    crude_price,
                    strike,
                    spread_width,
                    horizon,
                    risk_free_rate,
                    implied_vol,
                )
            except Exception:
                observation["fairProb"] = None
                observation["theoreticalDelta"] = None
        seeded.append(observation)

    sorted_observations = _dedupe_points(seeded, max_points)
    recomputed: list[dict[str, Any]] = []
    for index, observation in enumerate(sorted_observations):
        previous = recomputed[index - 1] if index > 0 else None
        empirical_delta_inst = (
            instantaneous_delta(
                previous.get("polyProb"),
                previous.get("crudePrice"),
                observation.get("polyProb"),
                observation.get("crudePrice"),
            )
            if previous
            else None
        )
        window_start = max(0, index - rolling_window + 1)
        window = sorted_observations[window_start : index + 1]
        empirical_delta_roll = rolling_regression_slope(
            [point.get("crudePrice") for point in window],
            [point.get("polyProb") for point in window],
        )
        fair_gap = (
            None
            if observation.get("polyProb") is None or observation.get("fairProb") is None
            else observation["polyProb"] - observation["fairProb"]
        )
        delta_gap = (
            None
            if empirical_delta_roll is None or observation.get("theoreticalDelta") is None
            else empirical_delta_roll - observation["theoreticalDelta"]
        )
        recomputed.append(
            {
                **observation,
                "fairValueGap": fair_gap,
                "empiricalDeltaInst": empirical_delta_inst,
                "empiricalDeltaRoll": empirical_delta_roll,
                "deltaGap": delta_gap,
                "signal": classify_signal(
                    fair_gap,
                    delta_gap,
                    fair_gap_threshold,
                    delta_gap_threshold,
                ),
            }
        )
    return recomputed[-max_points:]


_FIVE_MIN_MS = 5 * 60 * 1_000
_MEANINGFUL_CHANGE_CENTS = 0.5  # 0.5¢ = 0.005 in dollar terms
_LOW_HYSTERESIS_MS = 3 * 60 * 1_000   # conditions must be clear for 3 full minutes before banner drops


class KalshiLiquidityMonitor:
    """
    Tracks Kalshi orderbook liquidity over a 5-minute rolling window.

    Status values:
      "closed"  – no active contract (market.closed or market.active==False)
      "low"     – contract open but at least two of three thinness signals fire
      "normal"  – healthy order flow
    """

    def __init__(self) -> None:
        # Deque of (timestamp_ms, mid_dollars) for unique mid changes
        self._mid_window: deque[tuple[int, float]] = deque()
        # Current spread in dollars (updated on every poll)
        self._latest_spread_dollars: float | None = None
        # Last mid that counted as a "meaningful move"
        self._last_meaningful_mid: float | None = None
        self._last_meaningful_ts_ms: int | None = None
        # Hysteresis tracking
        self._status: str = "normal"
        self._status_since_ms: int = 0
        # Timestamp of the last poll where is_thin evaluated True.
        # The low→normal transition requires this to be _LOW_HYSTERESIS_MS
        # in the past — i.e., conditions have been *continuously* clear.
        self._last_thin_ts_ms: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record(
        self,
        *,
        mid: float | None,
        spread_dollars: float | None,
        now_ms: int,
        market_closed: bool,
        market_active: bool,
    ) -> None:
        """Call on every Kalshi poll cycle."""
        if market_closed or not market_active:
            self._status = "closed"
            self._status_since_ms = now_ms
            return

        # Prune stale window entries
        cutoff = now_ms - _FIVE_MIN_MS
        while self._mid_window and self._mid_window[0][0] < cutoff:
            self._mid_window.popleft()

        # Record mid if it changed
        if mid is not None and isfinite(mid):
            last = self._mid_window[-1][1] if self._mid_window else None
            if last is None or abs(mid - last) > 1e-9:
                self._mid_window.append((now_ms, mid))
            # Meaningful movement threshold
            if self._last_meaningful_mid is None or abs(mid - self._last_meaningful_mid) >= (_MEANINGFUL_CHANGE_CENTS / 100.0):
                self._last_meaningful_mid = mid
                self._last_meaningful_ts_ms = now_ms

        if spread_dollars is not None and isfinite(spread_dollars):
            self._latest_spread_dollars = spread_dollars

        # Evaluate two-of-three conditions
        mids = [m for _, m in self._mid_window]
        tick_count = len(mids)
        spread_cents = (self._latest_spread_dollars * 100) if self._latest_spread_dollars is not None else None

        c1 = tick_count < 5
        c2 = (spread_cents is None) or (spread_cents > 5)
        # Threshold raised to 0.01 (1¢): a line oscillating 0.5–1¢ still counts as flat.
        c3 = (len(mids) < 2) or (stdev(mids) < 0.01)

        is_thin = sum([c1, c2, c3]) >= 2
        desired = "low" if is_thin else "normal"
        # Track the last moment conditions evaluated as thin so the continuous-clear
        # requirement in _apply_hysteresis can use the right reference point.
        if is_thin:
            self._last_thin_ts_ms = now_ms
        self._apply_hysteresis(desired, now_ms)

    def as_dict(self) -> dict[str, Any]:
        mids = [m for _, m in self._mid_window]
        spread_cents = (
            round(self._latest_spread_dollars * 100, 2)
            if self._latest_spread_dollars is not None
            else None
        )
        last_change_iso: str | None = None
        if self._last_meaningful_ts_ms is not None:
            last_change_iso = to_iso_z(
                datetime.fromtimestamp(self._last_meaningful_ts_ms / 1000, tz=UTC)
            )
        return {
            "status": self._status,
            "reason": self._status_reason(),
            "lastMeaningfulChangeUtc": last_change_iso,
            "tickCount5m": len(mids),
            "spreadCents": spread_cents,
            "midStdev5m": round(stdev(mids), 6) if len(mids) >= 2 else None,
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _apply_hysteresis(self, desired: str, now_ms: int) -> None:
        if desired == self._status:
            return
        if self._status == "low" and desired == "normal":
            # Only clear the banner when conditions have been *continuously* clear
            # for the full hysteresis window.  _last_thin_ts_ms is updated every
            # cycle that is_thin is True, so any thin blip resets this countdown.
            if now_ms - self._last_thin_ts_ms < _LOW_HYSTERESIS_MS:
                return
        # normal → low: no hysteresis — the banner must appear immediately when
        # conditions are met.  Delaying it was the primary cause of the missing banner.
        self._status = desired
        self._status_since_ms = now_ms

    def _status_reason(self) -> str:
        if self._status == "closed":
            return "No active Kalshi WTI contract"
        if self._status == "low":
            return "Thin orderbook: low tick activity, wide spread, or flat price"
        return "Normal"


@dataclass
class FeedHealth:
    state: str = "warming"
    last_event_ts: int | None = None
    last_error: str | None = None
    detail: str | None = None
    reconnect_count: int = 0
    last_transport_ts: int | None = None
    transport_alive: bool = False
    quote_fresh: bool = False
    replay_pending: bool = False
    replay_completed_ts: int | None = None
    awaiting_live_quote: bool = False
    last_gap_start_ts: int | None = None
    last_gap_end_ts: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "lastEventTs": self.last_event_ts,
            "lastError": self.last_error,
            "detail": self.detail,
            "reconnectCount": self.reconnect_count,
            "lastTransportTs": self.last_transport_ts,
            "transportAlive": self.transport_alive,
            "quoteFresh": self.quote_fresh,
            "replayPending": self.replay_pending,
            "replayCompletedTs": self.replay_completed_ts,
            "awaitingLiveQuote": self.awaiting_live_quote,
            "lastGapStartTs": self.last_gap_start_ts,
            "lastGapEndTs": self.last_gap_end_ts,
        }


@dataclass
class MarketState:
    title: str = "Kalshi WTI dislocation monitor"
    question: str = "Will WTI settle above the selected strike?"
    slug: str = ""
    market_ticker: str = ""
    subtitle: str | None = None
    venue: str | None = None
    end_date: str | None = None
    active: bool = True
    closed: bool = False
    condition_id: str | None = None
    clob_token_ids: list[str] = field(default_factory=list)
    yes_token_id: str | None = None
    no_token_id: str | None = None
    kalshi_series_ticker: str | None = None
    kalshi_event_ticker: str | None = None
    kalshi_market_title: str | None = None
    kalshi_market_url: str | None = None
    contract_strike: float | None = None
    strike_type: str | None = None
    best_bid: float | None = None
    best_ask: float | None = None
    market_price: float | None = None
    midpoint: float | None = None
    spread: float | None = None
    last_trade: float | None = None
    display_prob: float | None = None
    display_source: str | None = None
    last_updated_ts: int | None = None
    history_source: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "question": self.question,
            "slug": self.slug or self.market_ticker,
            "marketTicker": self.market_ticker or self.slug,
            "subtitle": self.subtitle,
            "venue": self.venue,
            "endDate": self.end_date,
            "active": self.active,
            "closed": self.closed,
            "conditionId": self.condition_id,
            "clobTokenIds": self.clob_token_ids,
            "yesTokenId": self.yes_token_id,
            "noTokenId": self.no_token_id,
            "kalshiSeriesTicker": self.kalshi_series_ticker,
            "kalshiEventTicker": self.kalshi_event_ticker,
            "kalshiMarketTitle": self.kalshi_market_title,
            "kalshiMarketUrl": self.kalshi_market_url,
            "contractStrike": self.contract_strike,
            "strikeType": self.strike_type,
            "bestBid": self.best_bid,
            "bestAsk": self.best_ask,
            "marketPrice": self.market_price,
            "midpoint": self.midpoint,
            "spread": self.spread,
            "lastTrade": self.last_trade,
            "displayProb": self.display_prob,
            "displaySource": self.display_source,
            "lastUpdatedTs": self.last_updated_ts,
            "historySource": self.history_source,
        }


@dataclass
class CrudeState:
    label: str = "CME CL.c.0 (Databento Live)"
    sub_label: str = "Live MBP-1 top-of-book"
    current_price: float | None = None
    best_bid: float | None = None
    best_ask: float | None = None
    midpoint: float | None = None
    last_trade: float | None = None
    mark_source: str | None = None
    last_updated_ts: int | None = None


class LiveState:
    def __init__(self, config: Any):
        self.config = config
        self.lock = RLock()
        initial_market_ticker = getattr(config, "kalshi_target_market_ticker", "") or ""
        self.market = MarketState(
            slug=initial_market_ticker,
            market_ticker=initial_market_ticker,
            venue="kalshi",
            kalshi_series_ticker=getattr(config, "kalshi_series_ticker", None),
        )
        self.crude = CrudeState()
        self.poly_history: deque[dict[str, Any]] = deque(maxlen=config.live_history_limit)
        self.crude_history: deque[dict[str, Any]] = deque(maxlen=config.live_history_limit)
        self.warnings: list[str] = []
        self.databento_status = FeedHealth(detail=f"{config.databento_live_schema} {config.databento_symbol}")
        self.kalshi_status = FeedHealth(detail=f"series {config.kalshi_series_ticker}")
        self.snapshot_written_at: datetime | None = None
        self.loaded_previous_snapshot = False
        self.kalshi_liquidity = KalshiLiquidityMonitor()

    def _reset_market_state_locked(self, market_ticker: str | None = None) -> None:
        market_ticker = market_ticker or ""
        self.market = MarketState(
            slug=market_ticker,
            market_ticker=market_ticker,
            venue="kalshi",
            kalshi_series_ticker=self.market.kalshi_series_ticker
            or getattr(self.config, "kalshi_series_ticker", None),
        )
        self.poly_history = deque(maxlen=self.config.live_history_limit)

    def add_warning(self, message: str) -> None:
        if not message:
            return
        with self.lock:
            if message not in self.warnings:
                self.warnings.append(message)

    def clear_warning(self, text_fragment: str) -> None:
        if not text_fragment:
            return
        with self.lock:
            self.warnings = [
                warning for warning in self.warnings if text_fragment not in warning
            ]

    def set_market_metadata(self, metadata: dict[str, Any]) -> None:
        with self.lock:
            incoming_market_ticker = (
                metadata.get("marketTicker") or metadata.get("slug") or self.market.market_ticker
            )
            if (
                incoming_market_ticker
                and self.market.market_ticker
                and incoming_market_ticker != self.market.market_ticker
            ):
                previous_market_ticker = self.market.market_ticker
                current_series_ticker = self.market.kalshi_series_ticker
                self._reset_market_state_locked(str(incoming_market_ticker))
                if current_series_ticker is not None:
                    self.market.kalshi_series_ticker = current_series_ticker
                roll_warning = (
                    f"Kalshi market roll: {previous_market_ticker} -> {incoming_market_ticker}."
                )
                if roll_warning not in self.warnings:
                    self.warnings.append(roll_warning)

            self.market.title = metadata.get("title") or self.market.title
            self.market.question = metadata.get("question") or self.market.question
            self.market.market_ticker = incoming_market_ticker or self.market.market_ticker
            self.market.slug = metadata.get("slug") or self.market.market_ticker or self.market.slug
            self.market.subtitle = metadata.get("subtitle") or self.market.subtitle
            self.market.venue = metadata.get("venue") or self.market.venue
            self.market.end_date = metadata.get("endDate")
            self.market.active = bool(metadata.get("active", True))
            self.market.closed = bool(metadata.get("closed", False))
            self.market.condition_id = metadata.get("conditionId")
            self.market.clob_token_ids = list(metadata.get("clobTokenIds") or [])
            self.market.yes_token_id = (
                metadata.get("yesTokenId")
                if "yesTokenId" in metadata
                else self.market.yes_token_id
            )
            self.market.no_token_id = metadata.get("noTokenId")
            self.market.kalshi_series_ticker = (
                metadata.get("kalshiSeriesTicker") or self.market.kalshi_series_ticker
            )
            self.market.kalshi_event_ticker = (
                metadata.get("kalshiEventTicker") or self.market.kalshi_event_ticker
            )
            self.market.kalshi_market_title = (
                metadata.get("kalshiMarketTitle")
                or self.market.kalshi_market_title
                or self.market.title
            )
            self.market.kalshi_market_url = (
                metadata.get("kalshiMarketUrl") or self.market.kalshi_market_url
            )
            contract_strike = safe_float(metadata.get("contractStrike"))
            if contract_strike is not None:
                self.market.contract_strike = contract_strike
            self.market.strike_type = metadata.get("strikeType") or self.market.strike_type
            self.market.market_price = safe_float(metadata.get("marketPrice"))
            self.market.history_source = metadata.get("historySource") or self.market.history_source
            if self.market.market_price is not None and self.market.display_prob is None:
                self.market.display_prob = self.market.market_price
                self.market.display_source = "marketPrice"

    def set_feed_status(
        self,
        feed_name: str,
        state: str,
        *,
        detail: str | None = None,
        error: str | None = None,
        event_ts: int | None = None,
        increment_reconnect: bool = False,
    ) -> None:
        target = self.databento_status if feed_name == "databento" else self.kalshi_status
        with self.lock:
            target.state = state
            if detail is not None:
                target.detail = detail
            target.last_error = error
            if event_ts is not None:
                target.last_event_ts = event_ts
            if increment_reconnect:
                target.reconnect_count += 1
            if feed_name == "databento" and state in {"reconnecting", "disconnected"}:
                target.replay_pending = False
                target.awaiting_live_quote = False

    def note_databento_transport(
        self, event_ts: int | None = None, *, detail: str | None = None
    ) -> None:
        timestamp_ms = event_ts or utc_now_ms()
        with self.lock:
            self.databento_status.last_transport_ts = timestamp_ms
            self.databento_status.transport_alive = True
            if detail is not None:
                self.databento_status.detail = detail

    def note_databento_quote(self, event_ts: int | None = None) -> None:
        timestamp_ms = event_ts or utc_now_ms()
        with self.lock:
            self.databento_status.last_event_ts = timestamp_ms
            self.databento_status.last_transport_ts = max(
                self.databento_status.last_transport_ts or 0,
                timestamp_ms,
            )
            self.databento_status.transport_alive = True
            self.databento_status.quote_fresh = True

            if self.databento_status.replay_pending:
                return

            if self.databento_status.awaiting_live_quote:
                replay_completed_ts = self.databento_status.replay_completed_ts
                if replay_completed_ts is None or timestamp_ms <= replay_completed_ts:
                    return
                self.databento_status.awaiting_live_quote = False

            if self.databento_status.state != "disconnected":
                self.databento_status.state = "connected"
                self.databento_status.detail = (
                    f"{self.config.databento_live_schema} {self.config.databento_symbol}"
                )
                self.databento_status.last_error = None

    def note_databento_replay_started(
        self, replay_start_ts: int | None = None, *, detail: str | None = None
    ) -> None:
        with self.lock:
            self.databento_status.replay_pending = True
            self.databento_status.awaiting_live_quote = False
            self.databento_status.replay_completed_ts = None
            self.databento_status.last_gap_start_ts = replay_start_ts
            if self.databento_status.state != "disconnected":
                self.databento_status.state = "warming"
            if detail is not None:
                self.databento_status.detail = detail

    def note_databento_replay_completed(
        self, event_ts: int | None = None, *, detail: str | None = None
    ) -> None:
        timestamp_ms = event_ts or utc_now_ms()
        with self.lock:
            self.databento_status.replay_pending = False
            self.databento_status.awaiting_live_quote = True
            self.databento_status.replay_completed_ts = timestamp_ms
            self.databento_status.last_transport_ts = max(
                self.databento_status.last_transport_ts or 0,
                timestamp_ms,
            )
            self.databento_status.transport_alive = True
            if self.databento_status.state != "disconnected":
                self.databento_status.state = "stale"
            if detail is not None:
                self.databento_status.detail = detail

    def note_databento_gap(
        self,
        *,
        gap_start_ts: int | None = None,
        gap_end_ts: int | None = None,
    ) -> None:
        with self.lock:
            self.databento_status.last_gap_start_ts = gap_start_ts
            self.databento_status.last_gap_end_ts = gap_end_ts

    def get_databento_resume_start_ts(self) -> int | None:
        with self.lock:
            return self.databento_status.last_event_ts or self.crude.last_updated_ts

    def get_databento_last_transport_ts(self) -> int | None:
        with self.lock:
            return self.databento_status.last_transport_ts

    def tick_liquidity_monitor(self, now_ms: int | None = None) -> None:
        """Tick the KalshiLiquidityMonitor on every recorder loop iteration.

        update_poly_quote() (which normally calls record()) is skipped when the
        Kalshi quote is unchanged.  Without this call, the monitor's 5-minute
        window is never pruned during flat markets, so stale pre-flatness ticks
        keep c1 and c3 False and the banner never fires.
        """
        current_ms = now_ms or utc_now_ms()
        with self.lock:
            self.kalshi_liquidity.record(
                mid=self.market.midpoint,
                spread_dollars=self.market.spread,
                now_ms=current_ms,
                market_closed=self.market.closed,
                market_active=self.market.active,
            )

    def mark_snapshot_written(self, when: datetime | None = None) -> None:
        with self.lock:
            self.snapshot_written_at = when or utc_now()

    def mark_staleness(self, now_ms: int | None = None) -> None:
        current_ms = now_ms or utc_now_ms()
        with self.lock:
            self._mark_databento_stale(now_ms=current_ms)
            self._mark_feed_stale(
                self.kalshi_status,
                threshold_ms=self.config.market_stale_after_ms,
                now_ms=current_ms,
            )

    def _mark_databento_stale(self, *, now_ms: int) -> None:
        feed = self.databento_status
        feed.transport_alive = bool(
            feed.last_transport_ts is not None
            and now_ms - feed.last_transport_ts <= self.config.databento_transport_stale_after_ms
        )
        feed.quote_fresh = bool(
            feed.last_event_ts is not None
            and now_ms - feed.last_event_ts <= self.config.crude_stale_after_ms
        )

        if feed.state in {"reconnecting", "disconnected"}:
            return

        if feed.state == "warming" and feed.last_transport_ts is None:
            return

        if feed.replay_pending:
            feed.state = "stale"
            if not feed.last_error and not feed.detail:
                feed.detail = "Replaying recent CL gap"
            return

        if feed.awaiting_live_quote:
            feed.state = "stale"
            if not feed.last_error and not feed.detail:
                feed.detail = "Replay caught up; waiting for fresh live CL quote"
            return

        if feed.quote_fresh:
            feed.state = "connected"
            if not feed.last_error:
                feed.detail = f"{self.config.databento_live_schema} {self.config.databento_symbol}"
            return

        feed.state = "stale"
        if feed.last_error:
            return
        feed.detail = (
            "Databento session alive; awaiting fresh CL quote"
            if feed.transport_alive
            else "No recent Databento transport activity"
        )

    def _mark_feed_stale(
        self, feed: FeedHealth, *, threshold_ms: int, now_ms: int
    ) -> None:
        if feed.last_event_ts is None:
            return
        if feed.state not in {"connected", "stale"}:
            return
        age_ms = now_ms - feed.last_event_ts
        feed.state = "stale" if age_ms > threshold_ms else "connected"

    def _append_poly_point(self, point: dict[str, Any]) -> None:
        points = _dedupe_points([*self.poly_history, point], self.config.live_history_limit)
        self.poly_history = deque(points, maxlen=self.config.live_history_limit)

    def _append_crude_point(self, point: dict[str, Any]) -> None:
        points = _dedupe_points([*self.crude_history, point], self.config.live_history_limit)
        self.crude_history = deque(points, maxlen=self.config.live_history_limit)

    def seed_poly_history(self, history: list[dict[str, Any]]) -> None:
        if not history:
            return
        with self.lock:
            points = _dedupe_points([*self.poly_history, *history], self.config.live_history_limit)
            self.poly_history = deque(points, maxlen=self.config.live_history_limit)
            self.market.history_source = "kalshi_trade_history_plus_live_recorder"
            if self.poly_history:
                latest = self.poly_history[-1]
                self.market.last_updated_ts = latest.get("timestamp")
                self.market.display_prob = latest.get("price")
                self.market.display_source = latest.get("displaySource") or self.market.display_source

    def seed_crude_history(self, history: list[dict[str, Any]]) -> None:
        if not history:
            return
        with self.lock:
            points = _dedupe_points([*self.crude_history, *history], self.config.live_history_limit)
            self.crude_history = deque(points, maxlen=self.config.live_history_limit)
            if self.crude_history:
                latest = self.crude_history[-1]
                self.crude.current_price = safe_float(latest.get("price"))
                self.crude.best_bid = safe_float(latest.get("bid"))
                self.crude.best_ask = safe_float(latest.get("ask"))
                self.crude.midpoint = safe_float(latest.get("midpoint"))
                self.crude.last_trade = safe_float(latest.get("lastTrade"))
                self.crude.mark_source = latest.get("markSource") or "close"
                self.crude.last_updated_ts = latest.get("timestamp")

    def update_poly_quote(
        self,
        *,
        best_bid: float | None = None,
        best_ask: float | None = None,
        midpoint: float | None = None,
        spread: float | None = None,
        last_trade: float | None = None,
        market_price: float | None = None,
        event_ts: int | None = None,
        history_source: str = "live_recorder",
    ) -> None:
        with self.lock:
            if best_bid is not None:
                self.market.best_bid = best_bid
            if best_ask is not None:
                self.market.best_ask = best_ask
            if last_trade is not None:
                self.market.last_trade = last_trade
            if market_price is not None:
                self.market.market_price = market_price

            if midpoint is None and self.market.best_bid is not None and self.market.best_ask is not None:
                midpoint = (self.market.best_bid + self.market.best_ask) / 2.0
            if spread is None and self.market.best_bid is not None and self.market.best_ask is not None:
                spread = self.market.best_ask - self.market.best_bid

            self.market.midpoint = midpoint if midpoint is not None else self.market.midpoint
            self.market.spread = spread if spread is not None else self.market.spread

            if (
                self.market.midpoint is not None
                and self.market.spread is not None
                and self.market.spread <= 0.10
            ):
                display_prob = self.market.midpoint
                display_source = "midpoint"
            elif self.market.last_trade is not None:
                display_prob = self.market.last_trade
                display_source = "lastTrade"
            else:
                display_prob = self.market.market_price
                display_source = "marketPrice" if display_prob is not None else None

            timestamp_ms = event_ts or utc_now_ms()
            self.market.display_prob = display_prob
            self.market.display_source = display_source
            self.market.last_updated_ts = timestamp_ms
            self.market.history_source = history_source

            if display_prob is not None:
                self._append_poly_point(
                    {
                        "timestamp": timestamp_ms,
                        "price": display_prob,
                        "bestBid": self.market.best_bid,
                        "bestAsk": self.market.best_ask,
                        "midpoint": self.market.midpoint,
                        "spread": self.market.spread,
                        "lastTrade": self.market.last_trade,
                        "displaySource": display_source,
                        "seededFrom": "live_recorder",
                    }
                )

            self.kalshi_liquidity.record(
                mid=self.market.midpoint,
                spread_dollars=self.market.spread,
                now_ms=timestamp_ms,
                market_closed=self.market.closed,
                market_active=self.market.active,
            )

    def update_crude_quote(
        self,
        *,
        best_bid: float | None = None,
        best_ask: float | None = None,
        midpoint: float | None = None,
        last_trade: float | None = None,
        event_ts: int | None = None,
        history_source: str = "live_stream",
    ) -> None:
        with self.lock:
            if best_bid is not None:
                self.crude.best_bid = best_bid
            if best_ask is not None:
                self.crude.best_ask = best_ask
            if last_trade is not None:
                self.crude.last_trade = last_trade

            derived_midpoint = midpoint
            if (
                derived_midpoint is None
                and self.crude.best_bid is not None
                and self.crude.best_ask is not None
            ):
                derived_midpoint = (self.crude.best_bid + self.crude.best_ask) / 2.0
            if derived_midpoint is not None:
                current_price = derived_midpoint
                mark_source = "midpoint"
            else:
                current_price = self.crude.last_trade
                mark_source = "lastTrade" if current_price is not None else self.crude.mark_source

            timestamp_ms = event_ts or utc_now_ms()
            self.crude.midpoint = derived_midpoint
            self.crude.current_price = current_price
            self.crude.mark_source = mark_source
            self.crude.last_updated_ts = timestamp_ms

            if current_price is not None:
                self._append_crude_point(
                    {
                        "timestamp": timestamp_ms,
                        "price": current_price,
                        "bid": self.crude.best_bid,
                        "ask": self.crude.best_ask,
                        "midpoint": self.crude.midpoint,
                        "lastTrade": self.crude.last_trade,
                        "markSource": self.crude.mark_source,
                        "seededFrom": history_source,
                    }
                )

    def current_record_line(self) -> dict[str, Any] | None:
        with self.lock:
            if self.market.display_prob is None and self.crude.current_price is None:
                return None
            return {
                "recordedAt": utc_now_ms(),
                "marketTicker": self.market.market_ticker or self.market.slug,
                "marketSlug": self.market.slug or self.market.market_ticker,
                "kalshiSeriesTicker": self.market.kalshi_series_ticker,
                "kalshiEventTicker": self.market.kalshi_event_ticker,
                "yesTokenId": self.market.yes_token_id,
                "polyBestBid": self.market.best_bid,
                "polyBestAsk": self.market.best_ask,
                "polyMidpoint": self.market.midpoint,
                "polySpread": self.market.spread,
                "polyLastTrade": self.market.last_trade,
                "polyDisplayMark": self.market.display_prob,
                "polyDisplaySource": self.market.display_source,
                "crudePrice": self.crude.current_price,
                "crudeBestBid": self.crude.best_bid,
                "crudeBestAsk": self.crude.best_ask,
                "crudeMidpoint": self.crude.midpoint,
                "crudeLastTrade": self.crude.last_trade,
                "crudeMarkSource": self.crude.mark_source,
            }

    def load_previous_snapshot(self, snapshot: dict[str, Any]) -> bool:
        if snapshot.get("mode") != "live":
            return False
        market = snapshot.get("market") or {}
        if not isinstance(market, dict):
            return False
        if not (
            market.get("venue") == "kalshi"
            or market.get("kalshiSeriesTicker")
            or market.get("marketTicker")
        ):
            return False
        snapshot_market_ticker = str(market.get("marketTicker") or market.get("slug") or "")
        target_market_ticker = getattr(self.config, "kalshi_target_market_ticker", None)
        if (
            target_market_ticker
            and snapshot_market_ticker
            and snapshot_market_ticker.upper() != target_market_ticker.upper()
        ):
            return False
        snapshot_series_ticker = str(market.get("kalshiSeriesTicker") or "")
        config_series_ticker = str(getattr(self.config, "kalshi_series_ticker", "") or "")
        if (
            not target_market_ticker
            and snapshot_series_ticker
            and config_series_ticker
            and snapshot_series_ticker.upper() != config_series_ticker.upper()
        ):
            return False
        with self.lock:
            self.loaded_previous_snapshot = True
            self.market = MarketState(
                title=market.get("title") or self.market.title,
                question=market.get("question") or self.market.question,
                slug=market.get("slug") or snapshot_market_ticker,
                market_ticker=snapshot_market_ticker,
                subtitle=market.get("subtitle"),
                venue=market.get("venue") or "kalshi",
                end_date=market.get("endDate"),
                active=bool(market.get("active", True)),
                closed=bool(market.get("closed", False)),
                condition_id=market.get("conditionId"),
                clob_token_ids=list(market.get("clobTokenIds") or []),
                yes_token_id=market.get("yesTokenId"),
                no_token_id=market.get("noTokenId"),
                kalshi_series_ticker=market.get("kalshiSeriesTicker"),
                kalshi_event_ticker=market.get("kalshiEventTicker"),
                kalshi_market_title=market.get("kalshiMarketTitle") or market.get("title"),
                kalshi_market_url=market.get("kalshiMarketUrl"),
                contract_strike=safe_float(market.get("contractStrike")),
                strike_type=market.get("strikeType"),
                best_bid=safe_float(market.get("bestBid")),
                best_ask=safe_float(market.get("bestAsk")),
                market_price=safe_float(market.get("marketPrice")),
                midpoint=safe_float(market.get("midpoint")),
                spread=safe_float(market.get("spread")),
                last_trade=safe_float(market.get("lastTrade")),
                display_prob=safe_float(market.get("displayProb")),
                display_source=market.get("displaySource"),
                last_updated_ts=parse_timestamp_ms(market.get("lastUpdatedTs")),
                history_source=market.get("historySource"),
            )
            crude_history = list(snapshot.get("crudeHistory") or [])
            poly_history = list(snapshot.get("polyHistory") or [])
            self.crude_history = deque(
                _dedupe_points(crude_history, self.config.live_history_limit),
                maxlen=self.config.live_history_limit,
            )
            self.poly_history = deque(
                _dedupe_points(poly_history, self.config.live_history_limit),
                maxlen=self.config.live_history_limit,
            )
            if self.crude_history:
                latest_crude = self.crude_history[-1]
                self.crude.current_price = safe_float(latest_crude.get("price"))
                self.crude.best_bid = safe_float(latest_crude.get("bid"))
                self.crude.best_ask = safe_float(latest_crude.get("ask"))
                self.crude.midpoint = safe_float(latest_crude.get("midpoint"))
                self.crude.last_trade = safe_float(latest_crude.get("lastTrade"))
                self.crude.mark_source = latest_crude.get("markSource")
                self.crude.last_updated_ts = parse_timestamp_ms(latest_crude.get("timestamp"))
            for warning in snapshot.get("warnings") or []:
                if warning not in self.warnings:
                    self.warnings.append(warning)
            source_status = snapshot.get("sourceStatus") or {}
            if isinstance(source_status, dict):
                databento_status = source_status.get("databento") or {}
                if isinstance(databento_status, dict):
                    self.databento_status = FeedHealth(
                        state=str(databento_status.get("state") or self.databento_status.state),
                        last_event_ts=parse_timestamp_ms(databento_status.get("lastEventTs")),
                        last_error=databento_status.get("lastError"),
                        detail=databento_status.get("detail"),
                        reconnect_count=int(
                            safe_float(databento_status.get("reconnectCount")) or 0
                        ),
                        last_transport_ts=parse_timestamp_ms(
                            databento_status.get("lastTransportTs")
                        ),
                        transport_alive=bool(databento_status.get("transportAlive", False)),
                        quote_fresh=bool(databento_status.get("quoteFresh", False)),
                        replay_pending=bool(databento_status.get("replayPending", False)),
                        replay_completed_ts=parse_timestamp_ms(
                            databento_status.get("replayCompletedTs")
                        ),
                        awaiting_live_quote=bool(
                            databento_status.get("awaitingLiveQuote", False)
                        ),
                        last_gap_start_ts=parse_timestamp_ms(
                            databento_status.get("lastGapStartTs")
                        ),
                        last_gap_end_ts=parse_timestamp_ms(
                            databento_status.get("lastGapEndTs")
                        ),
                    )
                market_status = source_status.get("kalshi") or source_status.get("polymarket") or {}
                if isinstance(market_status, dict):
                    self.kalshi_status = FeedHealth(
                        state=str(market_status.get("state") or self.kalshi_status.state),
                        last_event_ts=parse_timestamp_ms(market_status.get("lastEventTs")),
                        last_error=market_status.get("lastError"),
                        detail=market_status.get("detail"),
                        reconnect_count=int(safe_float(market_status.get("reconnectCount")) or 0),
                    )
                snapshot_written_ts = parse_timestamp_ms(source_status.get("snapshotWrittenAt"))
                if snapshot_written_ts is not None:
                    self.snapshot_written_at = datetime.fromtimestamp(
                        snapshot_written_ts / 1000,
                        tz=UTC,
                    )
        return True

    def build_snapshot(self) -> dict[str, Any]:
        self.mark_staleness()
        with self.lock:
            market = self.market.as_dict()
            crude_history = list(self.crude_history)
            poly_history = list(self.poly_history)
            warnings = list(self.warnings)

        # Trim both raw histories to the presentation window, then decimate
        # the crude history for the serialized snapshot.  The chart is ~1200px
        # wide so 600 points is the maximum useful resolution; 4000+ tick-level
        # MBP-1 records per 25-minute window add ~600KB for zero visual gain.
        now_ms = utc_now_ms()
        window_cutoff_ms = now_ms - self.config.presentation_window_ms
        crude_history = [p for p in crude_history if p["timestamp"] >= window_cutoff_ms]
        poly_history = [p for p in poly_history if p["timestamp"] >= window_cutoff_ms]

        with self.lock:
            databento_status = self.databento_status.as_dict()
            kalshi_status = self.kalshi_status.as_dict()
            snapshot_written_at = to_iso_z(self.snapshot_written_at)
            crude_current_price = self.crude.current_price
            crude_label = self.crude.label
            crude_sub_label = self.crude.sub_label
            kalshi_liquidity_dict = self.kalshi_liquidity.as_dict()
        market_ticker = market.get("marketTicker") or market.get("slug") or ""
        market_strike = safe_float(market.get("contractStrike")) or safe_float(
            self.config.pricing_defaults["strike"]
        )
        observations = build_observations(
            market_ticker=str(market_ticker),
            market_slug=market.get("slug"),
            yes_token_id=market.get("yesTokenId"),
            poly_history=poly_history,
            crude_history=crude_history,
            strike=market_strike or 0.0,
            spread_width=self.config.pricing_defaults["spreadWidth"],
            implied_vol=self.config.pricing_defaults["impliedVol"],
            risk_free_rate=self.config.pricing_defaults["riskFreeRate"],
            rolling_window=self.config.pricing_defaults["rollingWindow"],
            fair_gap_threshold=self.config.pricing_defaults["fairGapThreshold"],
            delta_gap_threshold=self.config.pricing_defaults["deltaGapThreshold"],
            expiry=self.config.pricing_defaults["expiryOverride"] or market.get("endDate"),
            max_points=self.config.snapshot_observation_limit,
        )
        window_start_ts = min(
            [point["timestamp"] for point in [*poly_history, *crude_history]]
        ) if poly_history or crude_history else None
        window_end_ts = max(
            [point["timestamp"] for point in [*poly_history, *crude_history]]
        ) if poly_history or crude_history else None
        return {
            "ok": True,
            "mode": "live",
            "kalshiLiquidity": kalshi_liquidity_dict,
            "market": market,
            "providerMode": "databento_live_mbp1",
            "crudeLabel": crude_label,
            "crudeSubLabel": crude_sub_label,
            "crudeIsProxy": False,
            "crudeCurrentPrice": crude_current_price,
            "crudeHistory": crude_history,
            "polyHistory": poly_history,
            "windowStartTs": window_start_ts,
            "windowEndTs": window_end_ts,
            "observations": observations,
            "warnings": warnings,
            "generatedAt": to_iso_z(utc_now()),
            "sourceStatus": {
                "sessionId": self.config.session_id,
                "sessionStartedAt": self.config.session_started_at,
                "snapshotWrittenAt": snapshot_written_at,
                "marketTicker": market_ticker or None,
                "seriesTicker": market.get("kalshiSeriesTicker"),
                "eventTicker": market.get("kalshiEventTicker"),
                "marketUrl": market.get("kalshiMarketUrl"),
                "marketTransport": (
                    "rest_polling"
                    if self.config.kalshi_use_rest_polling
                    else "websocket"
                ),
                "marketPollIntervalSeconds": self.config.kalshi_poll_interval_seconds,
                "tokenId": market.get("yesTokenId") or None,
                "presentationWindowMs": self.config.presentation_window_ms,
                "marketHistorySource": market.get("historySource")
                or "kalshi_trade_history_plus_live_recorder",
                "polyHistorySource": market.get("historySource")
                or "kalshi_trade_history_plus_live_recorder",
                "crudeHistorySource": "historical_seed_plus_live_stream",
                "databento": databento_status,
                "kalshi": kalshi_status,
                "polymarket": kalshi_status,
            },
        }

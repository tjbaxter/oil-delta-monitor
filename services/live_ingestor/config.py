from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
import os


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_optional_float(name: str) -> float | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


@dataclass(frozen=True)
class IngestorPaths:
    repo_root: Path
    data_dir: Path
    live_snapshot_path: Path
    live_observations_path: Path
    sessions_dir: Path
    session_dir: Path
    session_snapshot_path: Path
    session_observations_path: Path
    session_metadata_path: Path


@dataclass(frozen=True)
class IngestorConfig:
    databento_api_key: str | None
    databento_dataset: str
    databento_symbol: str
    databento_live_schema: str
    databento_historical_schema: str
    databento_stype_in: str
    databento_metadata_url: str
    databento_historical_url: str
    databento_heartbeat_interval_seconds: int
    databento_transport_stale_after_ms: int
    databento_initial_message_timeout_ms: int
    databento_reconnect_delay_seconds: float
    databento_replay_overlap_ms: int
    databento_min_replay_window_ms: int
    databento_max_replay_window_ms: int
    kalshi_api_key_id: str | None
    kalshi_private_key_path: str | None
    kalshi_rest_base_url: str
    kalshi_ws_url: str
    kalshi_series_ticker: str
    kalshi_target_event_ticker: str | None
    kalshi_target_market_ticker: str | None
    kalshi_target_strike: float | None
    kalshi_market_lookahead_days: int
    kalshi_web_market_base_url: str
    kalshi_use_rest_polling: bool
    kalshi_poll_interval_seconds: float
    kalshi_market_refresh_seconds: float
    kalshi_drift_threshold_high: float
    kalshi_drift_threshold_low: float
    kalshi_min_strike_improvement: float
    session_id: str
    session_started_at: str
    seed_lookback_hours: int
    live_history_limit: int
    snapshot_observation_limit: int
    observation_emit_interval_ms: int
    snapshot_write_interval_ms: int
    market_stale_after_ms: int
    crude_stale_after_ms: int
    presentation_window_ms: int
    request_timeout_seconds: float
    pricing_defaults: dict[str, float | int | str | None]
    paths: IngestorPaths


def load_config() -> IngestorConfig:
    repo_root = Path(__file__).resolve().parents[2]
    data_dir = repo_root / "data"
    sessions_dir = data_dir / "sessions"
    session_started_at = datetime.now(UTC)
    session_id = session_started_at.strftime("%Y%m%d_%H%M%S")
    session_dir = sessions_dir / session_id

    paths = IngestorPaths(
        repo_root=repo_root,
        data_dir=data_dir,
        live_snapshot_path=data_dir / "live_snapshot.json",
        live_observations_path=data_dir / "live_observations.jsonl",
        sessions_dir=sessions_dir,
        session_dir=session_dir,
        session_snapshot_path=session_dir / "snapshot.json",
        session_observations_path=session_dir / "observations.jsonl",
        session_metadata_path=session_dir / "metadata.json",
    )

    paths.data_dir.mkdir(parents=True, exist_ok=True)
    paths.sessions_dir.mkdir(parents=True, exist_ok=True)
    paths.session_dir.mkdir(parents=True, exist_ok=True)

    use_demo = _env_bool("KALSHI_USE_DEMO", False)
    default_rest_base_url = (
        "https://demo-api.kalshi.co/trade-api/v2"
        if use_demo
        else "https://api.elections.kalshi.com/trade-api/v2"
    )
    default_ws_url = (
        "wss://demo-api.kalshi.co/trade-api/ws/v2"
        if use_demo
        else "wss://api.elections.kalshi.com/trade-api/ws/v2"
    )
    databento_heartbeat_interval_seconds = _env_int("DATABENTO_HEARTBEAT_INTERVAL_S", 10)
    databento_transport_stale_after_ms = _env_int(
        "DATABENTO_TRANSPORT_STALE_AFTER_MS",
        databento_heartbeat_interval_seconds * 1000 + 2_000,
    )
    databento_initial_message_timeout_ms = _env_int(
        "DATABENTO_INITIAL_MESSAGE_TIMEOUT_MS",
        max(databento_transport_stale_after_ms, 60_000),
    )

    return IngestorConfig(
        databento_api_key=os.getenv("DATABENTO_API_KEY"),
        databento_dataset=os.getenv("DATABENTO_DATASET", "GLBX.MDP3"),
        databento_symbol=os.getenv("DATABENTO_SYMBOL", "CL.c.0"),
        databento_live_schema=os.getenv("DATABENTO_LIVE_SCHEMA", "mbp-1"),
        databento_historical_schema=os.getenv("DATABENTO_HISTORICAL_SCHEMA", "ohlcv-1m"),
        databento_stype_in=os.getenv("DATABENTO_STYPE_IN", "continuous"),
        databento_metadata_url=os.getenv(
            "DATABENTO_METADATA_URL",
            "https://hist.databento.com/v0/metadata.get_dataset_range",
        ),
        databento_historical_url=os.getenv(
            "DATABENTO_HISTORICAL_URL",
            "https://hist.databento.com/v0/timeseries.get_range",
        ),
        databento_heartbeat_interval_seconds=databento_heartbeat_interval_seconds,
        databento_transport_stale_after_ms=databento_transport_stale_after_ms,
        databento_initial_message_timeout_ms=databento_initial_message_timeout_ms,
        databento_reconnect_delay_seconds=_env_float(
            "DATABENTO_RECONNECT_DELAY_SECONDS", 1.5
        ),
        databento_replay_overlap_ms=_env_int("DATABENTO_REPLAY_OVERLAP_MS", 0),
        databento_min_replay_window_ms=_env_int(
            "DATABENTO_MIN_REPLAY_WINDOW_MS", 5 * 60 * 1000
        ),
        databento_max_replay_window_ms=_env_int(
            "DATABENTO_MAX_REPLAY_WINDOW_MS", 30 * 60 * 1000
        ),
        kalshi_api_key_id=os.getenv("KALSHI_API_KEY_ID"),
        kalshi_private_key_path=os.getenv("KALSHI_PRIVATE_KEY_PATH"),
        kalshi_rest_base_url=os.getenv("KALSHI_REST_BASE_URL", default_rest_base_url),
        kalshi_ws_url=os.getenv("KALSHI_WS_URL", default_ws_url),
        kalshi_series_ticker=os.getenv("KALSHI_SERIES_TICKER", "KXWTI").strip().upper(),
        kalshi_target_event_ticker=(
            os.getenv("KALSHI_TARGET_EVENT_TICKER") or os.getenv("KALSHI_TARGET_EVENT")
        ),
        kalshi_target_market_ticker=os.getenv("KALSHI_TARGET_MARKET_TICKER"),
        kalshi_target_strike=_env_optional_float("KALSHI_TARGET_STRIKE"),
        kalshi_market_lookahead_days=_env_int("KALSHI_MARKET_LOOKAHEAD_DAYS", 7),
        kalshi_web_market_base_url=os.getenv(
            "KALSHI_WEB_MARKET_BASE_URL", "https://kalshi.com/markets"
        ),
        kalshi_use_rest_polling=_env_bool("KALSHI_USE_REST_POLLING", True),
        kalshi_poll_interval_seconds=_env_float("KALSHI_POLL_INTERVAL_SECONDS", 2.0),
        kalshi_market_refresh_seconds=_env_float("KALSHI_MARKET_REFRESH_SECONDS", 60.0),
        kalshi_drift_threshold_high=_env_float("KALSHI_DRIFT_THRESHOLD_HIGH", 0.75),
        kalshi_drift_threshold_low=_env_float("KALSHI_DRIFT_THRESHOLD_LOW", 0.25),
        kalshi_min_strike_improvement=_env_float("KALSHI_MIN_STRIKE_IMPROVEMENT", 0.10),
        session_id=session_id,
        session_started_at=session_started_at.isoformat().replace("+00:00", "Z"),
        seed_lookback_hours=_env_int("LIVE_SEED_LOOKBACK_HOURS", 6),
        live_history_limit=_env_int("LIVE_HISTORY_LIMIT", 4_000),
        snapshot_observation_limit=_env_int("LIVE_SNAPSHOT_OBSERVATION_LIMIT", 4_000),
        observation_emit_interval_ms=_env_int("LIVE_OBSERVATION_INTERVAL_MS", 1_000),
        snapshot_write_interval_ms=_env_int("LIVE_SNAPSHOT_WRITE_INTERVAL_MS", 1_000),
        market_stale_after_ms=_env_int(
            "LIVE_MARKET_STALE_AFTER_MS",
            _env_int("LIVE_POLY_STALE_AFTER_MS", 15_000),
        ),
        crude_stale_after_ms=_env_int("LIVE_CRUDE_STALE_AFTER_MS", 8_000),
        presentation_window_ms=_env_int("LIVE_PRESENTATION_WINDOW_MS", 25 * 60 * 1000),
        request_timeout_seconds=_env_float("LIVE_REQUEST_TIMEOUT_SECONDS", 15.0),
        pricing_defaults={
            "strike": _env_float("LIVE_STRIKE", 100.0),
            "spreadWidth": _env_float("LIVE_SPREAD_WIDTH", 1.0),
            "impliedVol": _env_float("LIVE_IMPLIED_VOL", 0.90),
            "riskFreeRate": _env_float("LIVE_RISK_FREE_RATE", 0.04),
            "rollingWindow": _env_int("LIVE_ROLLING_WINDOW", 20),
            "fairGapThreshold": _env_float("LIVE_FAIR_GAP_THRESHOLD", 0.02),
            "deltaGapThreshold": _env_float("LIVE_DELTA_GAP_THRESHOLD", 0.01),
            "expiryOverride": os.getenv("LIVE_EXPIRY_OVERRIDE"),
        },
        paths=paths,
    )

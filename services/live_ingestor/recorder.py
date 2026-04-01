from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile
import time
from typing import Any

from config import IngestorConfig
from state import LiveState, safe_float, utc_now_ms


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
    ) as handle:
        json.dump(payload, handle)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, separators=(",", ":")))
        handle.write("\n")


class Recorder:
    def __init__(self, config: IngestorConfig, state: LiveState):
        self.config = config
        self.state = state
        self.last_snapshot_write_ms = 0
        self.last_observation_write_ms = 0
        self.last_observation_fingerprint: tuple[Any, ...] | None = None

    def write_session_metadata(self) -> None:
        metadata = {
            "sessionId": self.config.session_id,
            "sessionStartedAt": self.config.session_started_at,
            "marketTicker": self.config.kalshi_target_market_ticker,
            "kalshiSeriesTicker": self.config.kalshi_series_ticker,
            "kalshiTargetEventTicker": self.config.kalshi_target_event_ticker,
            "kalshiTargetStrike": self.config.kalshi_target_strike,
            "pricingDefaults": self.config.pricing_defaults,
            "paths": {
                "liveSnapshot": str(self.config.paths.live_snapshot_path),
                "liveObservations": str(self.config.paths.live_observations_path),
                "sessionSnapshot": str(self.config.paths.session_snapshot_path),
                "sessionObservations": str(self.config.paths.session_observations_path),
            },
            "databento": {
                "dataset": self.config.databento_dataset,
                "symbol": self.config.databento_symbol,
                "liveSchema": self.config.databento_live_schema,
                "historicalSchema": self.config.databento_historical_schema,
                "stypeIn": self.config.databento_stype_in,
            },
            "kalshi": {
                "restBaseUrl": self.config.kalshi_rest_base_url,
                "wsUrl": self.config.kalshi_ws_url,
                "seriesTicker": self.config.kalshi_series_ticker,
                "targetEventTicker": self.config.kalshi_target_event_ticker,
                "targetMarketTicker": self.config.kalshi_target_market_ticker,
                "transport": (
                    "rest_polling" if self.config.kalshi_use_rest_polling else "websocket"
                ),
                "pollIntervalSeconds": self.config.kalshi_poll_interval_seconds,
                "marketRefreshSeconds": self.config.kalshi_market_refresh_seconds,
            },
        }
        atomic_write_json(self.config.paths.session_metadata_path, metadata)

    def _record_fingerprint(self, record: dict[str, Any]) -> tuple[Any, ...]:
        return (
            round(safe_float(record.get("polyBestBid")) or -1.0, 6),
            round(safe_float(record.get("polyBestAsk")) or -1.0, 6),
            round(safe_float(record.get("polyMidpoint")) or -1.0, 6),
            round(safe_float(record.get("polySpread")) or -1.0, 6),
            round(safe_float(record.get("polyLastTrade")) or -1.0, 6),
            round(safe_float(record.get("polyDisplayMark")) or -1.0, 6),
            record.get("polyDisplaySource"),
            round(safe_float(record.get("crudePrice")) or -1.0, 6),
            round(safe_float(record.get("crudeBestBid")) or -1.0, 6),
            round(safe_float(record.get("crudeBestAsk")) or -1.0, 6),
            round(safe_float(record.get("crudeMidpoint")) or -1.0, 6),
            round(safe_float(record.get("crudeLastTrade")) or -1.0, 6),
            record.get("crudeMarkSource"),
        )

    def maybe_append_observation(self, force: bool = False) -> bool:
        record = self.state.current_record_line()
        if record is None:
            return False

        now_ms = utc_now_ms()
        fingerprint = self._record_fingerprint(record)
        if not force:
            if now_ms - self.last_observation_write_ms < self.config.observation_emit_interval_ms:
                return False
            if fingerprint == self.last_observation_fingerprint:
                return False

        append_jsonl(self.config.paths.live_observations_path, record)
        append_jsonl(self.config.paths.session_observations_path, record)
        self.last_observation_write_ms = now_ms
        self.last_observation_fingerprint = fingerprint
        return True

    def write_snapshot(self, force: bool = False) -> dict[str, Any] | None:
        now_ms = utc_now_ms()
        if (
            not force
            and now_ms - self.last_snapshot_write_ms < self.config.snapshot_write_interval_ms
        ):
            return None

        self.state.mark_snapshot_written(datetime.now(UTC))
        snapshot = self.state.build_snapshot()
        atomic_write_json(self.config.paths.live_snapshot_path, snapshot)
        atomic_write_json(self.config.paths.session_snapshot_path, snapshot)
        self.last_snapshot_write_ms = now_ms
        return snapshot

    def _rotate_observations_file(self, path: Path, max_age_ms: int) -> None:
        """Drop lines from the JSONL file that are older than max_age_ms."""
        if not path.exists():
            return
        cutoff = utc_now_ms() - max_age_ms
        kept: list[str] = []
        try:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        rec = json.loads(stripped)
                        ts = rec.get("recordedAt") or rec.get("timestamp") or 0
                        if int(ts) >= cutoff:
                            kept.append(stripped)
                    except Exception:
                        kept.append(stripped)
        except OSError:
            return
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as tmp:
            for line in kept:
                tmp.write(line + "\n")
            tmp_path = Path(tmp.name)
        tmp_path.replace(path)

    def run_forever(self) -> None:
        sleep_seconds = max(self.config.snapshot_write_interval_ms / 4000.0, 0.25)
        _three_days_ms = 3 * 24 * 60 * 60 * 1000
        _rotation_interval_s = 6 * 60 * 60  # rotate obs file every 6 hours
        _last_rotation = 0.0
        while True:
            self.state.mark_staleness()
            appended = self.maybe_append_observation()
            self.write_snapshot(force=appended)
            now = time.monotonic()
            if now - _last_rotation >= _rotation_interval_s:
                self._rotate_observations_file(
                    self.config.paths.live_observations_path, _three_days_ms
                )
                _last_rotation = now
            time.sleep(sleep_seconds)

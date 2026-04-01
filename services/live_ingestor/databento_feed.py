from __future__ import annotations

from datetime import UTC, datetime
import json
import logging
from threading import Event, Thread
import time
from typing import Any

import databento as db
import requests

from config import IngestorConfig
from state import LiveState, normalize_price, parse_timestamp_ms, utc_now_ms

logger = logging.getLogger(__name__)


def _is_fatal_live_error(message: str) -> bool:
    lower = message.lower()
    return "license is required" in lower or "permission denied" in lower


def _build_headers(api_key: str) -> dict[str, str]:
    import base64

    encoded = base64.b64encode(f"{api_key}:".encode("utf-8")).decode("utf-8")
    return {
        "Authorization": f"Basic {encoded}",
        "Accept": "application/json",
    }


def _request(
    method: str,
    url: str,
    *,
    timeout: float,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> requests.Response:
    session = requests.Session()
    session.trust_env = False
    return session.request(
        method,
        url,
        params=params,
        headers=headers,
        timeout=timeout,
    )


def _extract_json_like_rows(payload: Any, depth: int = 0) -> list[dict[str, Any]]:
    if depth > 4:
        return []
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if not isinstance(payload, dict):
        return []
    if ("ts_event" in payload or isinstance(payload.get("hd"), dict)) and "close" in payload:
        return [payload]
    for key in ("data", "records", "result", "results", "items"):
        rows = _extract_json_like_rows(payload.get(key), depth + 1)
        if rows:
            return rows
    return []


def _parse_jsonl_rows(raw_text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in raw_text.splitlines():
        clean = line.strip()
        if not clean:
            continue
        try:
            parsed = json.loads(clean)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            rows.append(parsed)
    return rows


def _normalize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for row in rows:
        header = row.get("hd") if isinstance(row.get("hd"), dict) else {}
        timestamp_ms = parse_timestamp_ms(header.get("ts_event") or row.get("ts_event"))
        price = normalize_price(row.get("close"))
        if timestamp_ms is None or price is None:
            continue
        points.append(
            {
                "timestamp": timestamp_ms,
                "price": price,
                "bid": None,
                "ask": None,
                "midpoint": None,
                "lastTrade": None,
                "markSource": "close",
                "seededFrom": "historical_seed",
            }
        )
    return sorted(points, key=lambda point: point["timestamp"])


def _extract_available_end(text: str) -> int | None:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail") if isinstance(payload.get("detail"), dict) else {}
        nested = detail.get("payload") if isinstance(detail.get("payload"), dict) else {}
        explicit = nested.get("available_end") or detail.get("available_end")
        parsed = parse_timestamp_ms(explicit)
        if parsed is not None:
            return parsed
    for fragment in ("available up to '", "before "):
        if fragment not in text:
            continue
        start = text.find(fragment) + len(fragment)
        end = text.find("'", start) if fragment.endswith("'") else len(text)
        candidate = text[start:end]
        parsed = parse_timestamp_ms(candidate)
        if parsed is not None:
            return parsed
    return None


def _extract_range_from_metadata(
    payload: Any, *, schema: str, lookback_hours: int
) -> tuple[int | None, int | None]:
    if not isinstance(payload, dict):
        return None, None
    schema_record = payload.get("schema") if isinstance(payload.get("schema"), dict) else {}
    schema_range = (
        schema_record.get(schema)
        if isinstance(schema_record.get(schema), dict)
        else {}
    )
    dataset_start = parse_timestamp_ms(schema_range.get("start") or payload.get("start"))
    dataset_end = parse_timestamp_ms(schema_range.get("end") or payload.get("end"))
    if dataset_end is None:
        return None, None
    lookback_start = dataset_end - lookback_hours * 60 * 60 * 1000
    if dataset_start is None:
        return lookback_start, dataset_end
    return max(dataset_start, lookback_start), dataset_end


def _fetch_entitled_range(config: IngestorConfig) -> tuple[int | None, int | None]:
    if not config.databento_api_key:
        return None, None
    response = _request(
        "GET",
        config.databento_metadata_url,
        params={"dataset": config.databento_dataset},
        headers=_build_headers(config.databento_api_key),
        timeout=config.request_timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    return _extract_range_from_metadata(
        payload,
        schema=config.databento_historical_schema,
        lookback_hours=config.seed_lookback_hours,
    )


def _build_timeseries_params(
    config: IngestorConfig, start_ms: int, end_ms: int
) -> dict[str, str]:
    return {
        "dataset": config.databento_dataset,
        "symbols": config.databento_symbol,
        "stype_in": config.databento_stype_in,
        "schema": config.databento_historical_schema,
        "start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_ms / 1000)),
        "end": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end_ms / 1000)),
        "encoding": "json",
    }


def fetch_historical_seed(config: IngestorConfig) -> dict[str, Any]:
    if not config.databento_api_key:
        return {
            "history": [],
            "windowStartTs": None,
            "windowEndTs": None,
            "warnings": ["Databento live disabled: add DATABENTO_API_KEY for the crude feed."],
        }

    try:
        start_ms, end_ms = _fetch_entitled_range(config)
    except requests.RequestException as exc:
        return {
            "history": [],
            "windowStartTs": None,
            "windowEndTs": None,
            "warnings": [f"Databento metadata error: {exc}"],
        }

    if start_ms is None or end_ms is None:
        return {
            "history": [],
            "windowStartTs": None,
            "windowEndTs": None,
            "warnings": ["Databento metadata error: unable to determine entitled seed range."],
        }

    active_start = start_ms
    active_end = end_ms
    try:
        response = _request(
            "GET",
            config.databento_historical_url,
            params=_build_timeseries_params(config, active_start, active_end),
            headers=_build_headers(config.databento_api_key),
            timeout=config.request_timeout_seconds,
        )
    except requests.RequestException as exc:
        return {
            "history": [],
            "windowStartTs": active_start,
            "windowEndTs": active_end,
            "warnings": [f"Databento historical seed error: {exc}"],
        }

    if response.status_code == 422:
        available_end = _extract_available_end(response.text)
        if available_end is not None:
            active_end = available_end
            active_start = available_end - config.seed_lookback_hours * 60 * 60 * 1000
            try:
                response = _request(
                    "GET",
                    config.databento_historical_url,
                    params=_build_timeseries_params(config, active_start, active_end),
                    headers=_build_headers(config.databento_api_key),
                    timeout=config.request_timeout_seconds,
                )
            except requests.RequestException as exc:
                return {
                    "history": [],
                    "windowStartTs": active_start,
                    "windowEndTs": active_end,
                    "warnings": [f"Databento historical seed error: {exc}"],
                }

    if not response.ok:
        return {
            "history": [],
            "windowStartTs": active_start,
            "windowEndTs": active_end,
            "warnings": [
                f"Databento historical seed failed with HTTP {response.status_code}."
            ],
        }

    content_type = (response.headers.get("content-type") or "").lower()
    if "jsonl" in content_type or "ndjson" in content_type:
        rows = _parse_jsonl_rows(response.text)
    else:
        try:
            payload = response.json()
        except json.JSONDecodeError:
            payload = None
        rows = _extract_json_like_rows(payload)
    history = _normalize_rows(rows)
    if not history:
        return {
            "history": [],
            "windowStartTs": active_start,
            "windowEndTs": active_end,
            "warnings": ["Databento historical seed returned no CL.c.0 bars."],
        }
    return {
        "history": history,
        "windowStartTs": active_start,
        "windowEndTs": active_end,
        "warnings": [],
    }


def bootstrap_crude_state(config: IngestorConfig, state: LiveState) -> None:
    try:
        seed = fetch_historical_seed(config)
        for warning in seed["warnings"]:
            state.add_warning(warning)
        history = seed["history"]
        if history:
            state.seed_crude_history(history)
            state.set_feed_status(
                "databento",
                "warming",
                detail="Historical seed ready; waiting for live feed",
                event_ts=history[-1]["timestamp"],
                error=None,
            )
        elif seed["warnings"]:
            state.set_feed_status(
                "databento",
                "stale",
                detail="Historical seed unavailable; keeping recorder alive",
                error=seed["warnings"][-1],
            )
        else:
            state.add_warning("Databento historical seed returned no rows.")
    except Exception as exc:  # pragma: no cover - defensive guard
        state.add_warning(f"Databento bootstrap error: {exc}")
        state.set_feed_status(
            "databento",
            "stale",
            detail="Historical seed crashed; keeping recorder alive",
            error=str(exc),
        )


class DatabentoFeed(Thread):
    def __init__(self, config: IngestorConfig, state: LiveState):
        super().__init__(daemon=True)
        self.config = config
        self.state = state
        self.fatal_error: str | None = None
        self.session_error: str | None = None
        self.replay_requested = False

    def _supports_snapshot(self) -> bool:
        return self.config.databento_live_schema not in {"mbp-1"}

    def _format_replay_start(self, timestamp_ms: int) -> str:
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).isoformat().replace(
            "+00:00", "Z"
        )

    def _build_replay_start(self) -> tuple[int | None, datetime | None]:
        last_quote_ts = self.state.get_databento_resume_start_ts()
        if last_quote_ts is None:
            return None, None

        replay_start_ts = max(last_quote_ts - self.config.databento_replay_overlap_ms, 0)
        replay_floor_ts = utc_now_ms() - 23 * 60 * 60 * 1000
        if replay_start_ts < replay_floor_ts:
            self.state.add_warning(
                "Databento replay start exceeded the intraday window; reconnecting live-only."
            )
            return None, None

        gap_duration_ms = utc_now_ms() - replay_start_ts
        min_window_ms = self.config.databento_min_replay_window_ms
        max_window_ms = self.config.databento_max_replay_window_ms
        if gap_duration_ms < min_window_ms:
            logger.info(
                "Gap of %ds is under min replay window of %ds; connecting live-only",
                gap_duration_ms // 1000,
                min_window_ms // 1000,
            )
            return None, None
        if gap_duration_ms > max_window_ms:
            logger.info(
                "Gap of %ds exceeds max replay window of %ds; connecting live-only",
                gap_duration_ms // 1000,
                max_window_ms // 1000,
            )
            self.state.add_warning(
                f"Databento gap too large for replay ({gap_duration_ms // 1000}s); "
                "connecting live-only."
            )
            return None, None

        return replay_start_ts, datetime.fromtimestamp(replay_start_ts / 1000, tz=UTC)

    def _watch_transport(
        self,
        client: db.Live,
        session_started_ms: int,
        stop_event: Event,
        watchdog_reason: dict[str, str | None],
    ) -> None:
        threshold_ms = self.config.databento_transport_stale_after_ms
        startup_timeout_ms = self.config.databento_initial_message_timeout_ms
        replay_patience_ms = max(threshold_ms, 300_000)  # 5 min patience during replay
        while not stop_event.wait(1.0):
            if self.fatal_error or self.session_error:
                return
            if watchdog_reason.get("reason"):
                return

            now_ms = utc_now_ms()
            last_transport_ts = self.state.get_databento_last_transport_ts()
            if last_transport_ts is None or last_transport_ts < session_started_ms:
                # During replay sessions, Databento may take longer to begin streaming.
                # Use replay_patience_ms so we don't abort a valid replay prematurely.
                effective_startup_timeout = (
                    replay_patience_ms if self.replay_requested else startup_timeout_ms
                )
                if now_ms - session_started_ms <= effective_startup_timeout:
                    continue
                watchdog_reason["reason"] = (
                    "Databento transport never started for this session; reconnecting"
                )
                logger.warning(
                    "Databento transport never produced a message within %sms; terminating session",
                    effective_startup_timeout,
                )
                try:
                    client.terminate()
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning("Unable to terminate Databento session cleanly: %s", exc)
                return

            effective_threshold = (
                replay_patience_ms
                if self.state.databento_status.replay_pending
                else threshold_ms
            )
            if now_ms - last_transport_ts <= effective_threshold:
                continue
            watchdog_reason["reason"] = "Databento transport silent; reconnecting"
            logger.warning(
                "Databento transport exceeded %sms without any message; terminating session",
                effective_threshold,
            )
            try:
                client.terminate()
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("Unable to terminate Databento session cleanly: %s", exc)
            return

    def run(self) -> None:  # pragma: no cover - long-running integration code
        if not self.config.databento_api_key:
            self.state.set_feed_status(
                "databento",
                "disconnected",
                detail="No DATABENTO_API_KEY",
                error="Add DATABENTO_API_KEY to enable live CME CL data.",
            )
            return

        reconnect_floor = max(self.config.databento_reconnect_delay_seconds, 1.0)
        backoff_seconds = reconnect_floor
        while True:
            if self.fatal_error:
                self.state.set_feed_status(
                    "databento",
                    "disconnected",
                    detail="Live entitlement missing",
                    error=self.fatal_error,
                )
                return

            watchdog_stop = Event()
            watchdog_reason: dict[str, str | None] = {"reason": None}
            watchdog_thread: Thread | None = None
            client: db.Live | None = None
            session_started_ms = utc_now_ms()
            replay_start_ts, replay_start = self._build_replay_start()
            self.session_error = None
            self.replay_requested = replay_start is not None
            try:
                self.state.set_feed_status(
                    "databento",
                    "reconnecting",
                    detail=f"Connecting {self.config.databento_live_schema}",
                    error=None,
                )
                client = db.Live(
                    key=self.config.databento_api_key,
                    heartbeat_interval_s=self.config.databento_heartbeat_interval_seconds,
                )
                client.subscribe(
                    dataset=self.config.databento_dataset,
                    schema=self.config.databento_live_schema,
                    symbols=[self.config.databento_symbol],
                    stype_in=self.config.databento_stype_in,
                    start=replay_start,
                    snapshot=self._supports_snapshot() and replay_start is None,
                )
                if replay_start_ts is not None:
                    self.state.note_databento_gap(
                        gap_start_ts=replay_start_ts,
                        gap_end_ts=session_started_ms,
                    )
                    self.state.note_databento_replay_started(
                        replay_start_ts=replay_start_ts,
                        detail=f"Replaying CL from {self._format_replay_start(replay_start_ts)}",
                    )
                    logger.info(
                        "Replaying Databento %s from %s",
                        self.config.databento_symbol,
                        self._format_replay_start(replay_start_ts),
                    )
                else:
                    self.state.set_feed_status(
                        "databento",
                        "warming",
                        detail="Waiting for fresh live CL quote",
                        error=None,
                    )
                watchdog_thread = Thread(
                    target=self._watch_transport,
                    args=(client, session_started_ms, watchdog_stop, watchdog_reason),
                    daemon=True,
                )
                watchdog_thread.start()
                for record in client:
                    self._handle_record(record)
                    backoff_seconds = reconnect_floor
                    if self.fatal_error or self.session_error:
                        try:
                            client.stop()
                        except Exception:  # pragma: no cover - defensive
                            pass
                        break
                if self.fatal_error:
                    self.state.set_feed_status(
                        "databento",
                        "disconnected",
                        detail="Live entitlement missing",
                        error=self.fatal_error,
                    )
                    return
                if self.session_error:
                    self.state.set_feed_status(
                        "databento",
                        "disconnected",
                        detail="Databento live error",
                        error=self.session_error,
                    )
                    return
                self.state.set_feed_status(
                    "databento",
                    "reconnecting",
                    detail=watchdog_reason["reason"]
                    or "Databento stream closed; reconnecting",
                    error=None,
                    increment_reconnect=True,
                )
            except db.BentoError as exc:
                message = str(exc)
                if watchdog_reason["reason"]:
                    self.state.set_feed_status(
                        "databento",
                        "reconnecting",
                        detail=watchdog_reason["reason"],
                        error=None,
                        increment_reconnect=True,
                    )
                elif _is_fatal_live_error(message):
                    self.fatal_error = message
                    self.state.add_warning(f"Databento live error: {message}")
                    self.state.set_feed_status(
                        "databento",
                        "disconnected",
                        detail="Live entitlement missing",
                        error=message,
                    )
                    return
                else:
                    self.state.add_warning(f"Databento live error: {exc}")
                    self.state.set_feed_status(
                        "databento",
                        "reconnecting",
                        detail="Databento live retrying",
                        error=message,
                        increment_reconnect=True,
                    )
            except Exception as exc:
                message = str(exc)
                if _is_fatal_live_error(message):
                    self.fatal_error = message
                    self.state.add_warning(f"Databento live error: {message}")
                    self.state.set_feed_status(
                        "databento",
                        "disconnected",
                        detail="Live entitlement missing",
                        error=message,
                    )
                    return
                if watchdog_reason["reason"]:
                    self.state.set_feed_status(
                        "databento",
                        "reconnecting",
                        detail=watchdog_reason["reason"],
                        error=None,
                        increment_reconnect=True,
                    )
                else:
                    self.state.add_warning(f"Databento live error: {exc}")
                    self.state.set_feed_status(
                        "databento",
                        "reconnecting",
                        detail="Databento live retrying",
                        error=str(exc),
                        increment_reconnect=True,
                    )
            finally:
                watchdog_stop.set()
                if watchdog_thread is not None:
                    watchdog_thread.join(timeout=1.0)
            time.sleep(backoff_seconds)
            backoff_seconds = min(max(backoff_seconds * 2, reconnect_floor), 30.0)

    def _extract_price(self, source: Any, *attribute_names: str) -> float | None:
        for attribute_name in attribute_names:
            value = getattr(source, attribute_name, None)
            if callable(value):
                try:
                    value = value()
                except TypeError:
                    continue
            parsed = normalize_price(value)
            if parsed is not None:
                return parsed
        return None

    def _record_timestamp_ms(self, record: Any) -> int:
        return (
            parse_timestamp_ms(getattr(record, "ts_event", None))
            or parse_timestamp_ms(getattr(record, "ts_recv", None))
            or utc_now_ms()
        )

    def _handle_record(self, record: Any) -> None:
        timestamp_ms = self._record_timestamp_ms(record)
        self.state.note_databento_transport(timestamp_ms)

        if isinstance(record, db.SystemMsg):
            if record.is_heartbeat():
                return

            if getattr(record, "code", None) == db.SystemCode.REPLAY_COMPLETED:
                self.replay_requested = False
                logger.info("Databento replay completed for %s", self.config.databento_symbol)
                self.state.note_databento_replay_completed(
                    event_ts=timestamp_ms,
                    detail="Replay caught up; waiting for fresh live CL quote",
                )
                return

            if getattr(record, "code", None) == db.SystemCode.SLOW_READER_WARNING:
                warning_text = str(
                    getattr(record, "msg", "Databento slow reader warning")
                ).strip()
                logger.warning("Databento slow reader warning: %s", warning_text)
                self.state.add_warning(f"Databento slow reader warning: {warning_text}")
                return

            logger.info(
                "Databento system message code=%s msg=%s",
                getattr(record, "code", None),
                getattr(record, "msg", ""),
            )
            return

        if isinstance(record, db.SymbolMappingMsg):
            return

        if isinstance(record, db.ErrorMsg):
            error_text = str(getattr(record, "err", "Databento live error"))
            logger.error(
                "Databento ErrorMsg code=%s err=%s",
                getattr(record, "code", None),
                error_text,
            )
            self.state.add_warning(f"Databento live error: {error_text}")
            if _is_fatal_live_error(error_text):
                self.fatal_error = error_text
                self.state.set_feed_status(
                    "databento",
                    "disconnected",
                    detail="Live entitlement missing",
                    error=error_text,
                )
                return
            self.session_error = error_text
            self.state.set_feed_status(
                "databento",
                "disconnected",
                detail="Databento live error",
                error=error_text,
            )
            return

        if hasattr(record, "levels"):
            levels = getattr(record, "levels", [])
            best_level = levels[0] if levels else None
            best_bid = (
                self._extract_price(best_level, "pretty_bid_px", "bid_px")
                if best_level is not None
                else None
            )
            best_ask = (
                self._extract_price(best_level, "pretty_ask_px", "ask_px")
                if best_level is not None
                else None
            )
            last_trade = self._extract_price(record, "pretty_price", "price")
            self.state.update_crude_quote(
                best_bid=best_bid,
                best_ask=best_ask,
                last_trade=last_trade,
                event_ts=timestamp_ms,
            )
        elif hasattr(record, "close"):
            close_price = self._extract_price(record, "pretty_close", "close")
            self.state.update_crude_quote(
                last_trade=close_price,
                event_ts=timestamp_ms,
            )
        else:
            trade_price = self._extract_price(record, "pretty_price", "price")
            if trade_price is None:
                return
            self.state.update_crude_quote(
                last_trade=trade_price,
                event_ts=timestamp_ms,
            )

        self.state.note_databento_quote(timestamp_ms)

    def _handle_exception(self, error: BaseException) -> None:
        self.state.add_warning(f"Databento callback error: {error}")
        self.state.set_feed_status(
            "databento",
            "reconnecting",
            detail="Databento callback error",
            error=str(error),
        )

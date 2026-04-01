from __future__ import annotations

import json

from config import load_config
from databento_feed import DatabentoFeed, bootstrap_crude_state
from kalshi_adapter import KalshiAdapter, bootstrap_kalshi_state
from kalshi_rest import KalshiRestClient
from recorder import Recorder
from state import LiveState


def _load_existing_snapshot(path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def main() -> None:  # pragma: no cover - long-running integration entrypoint
    config = load_config()
    state = LiveState(config)
    recorder = Recorder(config, state)
    recorder.write_session_metadata()

    previous_snapshot = _load_existing_snapshot(config.paths.live_snapshot_path)
    if previous_snapshot:
        state.load_previous_snapshot(previous_snapshot)

    # Publish a local snapshot immediately so the Next.js app can render from
    # last-good state while the feeds warm up.
    recorder.write_snapshot(force=True)

    kalshi_rest_client = KalshiRestClient(
        base_url=config.kalshi_rest_base_url,
        timeout=config.request_timeout_seconds,
    )
    bootstrap_kalshi_state(config, state, kalshi_rest_client)
    bootstrap_crude_state(config, state)
    recorder.maybe_append_observation(force=True)
    recorder.write_snapshot(force=True)

    market_feed = KalshiAdapter(config, state)
    databento_feed = DatabentoFeed(config, state)
    market_feed.start()
    databento_feed.start()

    recorder.run_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

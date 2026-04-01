import type { ProviderMode } from "@/lib/types";

export const DEFAULT_MONITOR_MODE =
  process.env.NEXT_PUBLIC_MONITOR_MODE === "delayed" ? "delayed" : "live";

export const DEFAULT_MARKET_SLUG =
  process.env.NEXT_PUBLIC_DEFAULT_MARKET_SLUG || "cl-above-90-jun-2026";

export const DEFAULT_CRUDE_PROVIDER: ProviderMode = "databento_cl_c_0_1m";
export const LIVE_CRUDE_PROVIDER: ProviderMode = "databento_live_mbp1";

export const DEFAULT_STRIKE = 90;
export const DEFAULT_SPREAD_WIDTH = 1;
export const DEFAULT_IMPLIED_VOL = 0.9;
export const DEFAULT_RISK_FREE_RATE = 0.04;
export const DEFAULT_ROLLING_WINDOW = 20;
export const DEFAULT_FAIR_GAP_THRESHOLD = 0.02;
export const DEFAULT_DELTA_GAP_THRESHOLD = 0.01;

export const MAX_OBSERVATIONS = 4_000;
export const HISTORY_INTERVAL = "1m";
export const HISTORY_FIDELITY_MINUTES = 10;
export const DATA_REVALIDATE_SECONDS = 300;
export const BROWSER_CACHE_MAX_AGE_SECONDS = 60;

export const DATABENTO_METADATA_URL =
  "https://hist.databento.com/v0/metadata.get_dataset_range";
export const DATABENTO_HISTORICAL_URL =
  "https://hist.databento.com/v0/timeseries.get_range";
export const DATABENTO_DATASET = "GLBX.MDP3";
export const DATABENTO_SYMBOL = "CL.c.0";
export const DATABENTO_SCHEMA = "ohlcv-1m";
export const DATABENTO_LOOKBACK_HOURS = 48;

export const POLY_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
export const POLY_CLOB_BASE_URL = "https://clob.polymarket.com";
export const POLY_WS_MARKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export const DASHBOARD_TITLE =
  "CL DELTA SCOPE - KALSHI WTI DAILY VS CALL SPREAD FAIR VALUE";
export const DASHBOARD_SUBTITLE = "Intraday options analytics, T+1 delayed";
export const LIVE_DASHBOARD_SUBTITLE =
  "Real-time Kalshi WTI dislocation monitor";

export const LIVE_SNAPSHOT_RELATIVE_PATH = "data/live_snapshot.json";
export const LIVE_SNAPSHOT_POLL_INTERVAL_MS = 1_000;
export const LIVE_PRESENTATION_WINDOW_MS = 20 * 60 * 1000;
export const LIVE_PRESENTATION_BUCKET_MS = 5_000;

export const POLY_COLOR = "#27d3c3";
export const THEO_COLOR = "#ff8b3d";
export const CRUDE_COLOR = "#b9a26a";
export const POSITIVE_COLOR = "#2ec27e";
export const NEGATIVE_COLOR = "#f66151";
export const NEUTRAL_COLOR = "#8a9199";
export const BG_COLOR = "#040710";
export const PANEL_BG = "#091220";
export const BORDER_COLOR = "#16283a";

export const SEARCH_TOKENS = new Set(["crude", "oil", "wti", "cl"]);

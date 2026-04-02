export type ProviderMode =
  | "databento_cl_c_0_1m"
  | "databento_live_mbp1"
  | "manual";

export type SnapshotMode = "live" | "delayed";

export type FeedConnectionState =
  | "warming"
  | "connected"
  | "stale"
  | "reconnecting"
  | "disconnected";

export type HistorySeedSource =
  | "historical_seed"
  | "clob_prices_history"
  | "kalshi_trade_history"
  | "live_recorder"
  | "live_stream"
  | "delayed_window";

export type CrudeMarkSource = "midpoint" | "lastTrade" | "close";

export type MarketDisplaySource =
  | "midpoint"
  | "lastTrade"
  | "marketPrice"
  | "tradeHistory";

export type PolyDisplaySource = MarketDisplaySource;

export type SignalState = "Market rich" | "Market cheap" | "Neutral";

export interface FeedStatus {
  state: FeedConnectionState;
  lastEventTs: number | null;
  lastError: string | null;
  detail: string | null;
  reconnectCount?: number;
}

export interface SourceStatus {
  sessionId: string | null;
  sessionStartedAt: string | null;
  snapshotWrittenAt: string | null;
  tokenId: string | null;
  marketTicker?: string | null;
  seriesTicker?: string | null;
  eventTicker?: string | null;
  marketUrl?: string | null;
  marketTransport?: string | null;
  marketPollIntervalSeconds?: number | null;
  presentationWindowMs: number | null;
  marketHistorySource?: string | null;
  polyHistorySource: string | null;
  crudeHistorySource: string | null;
  databento: FeedStatus;
  kalshi?: FeedStatus;
  polymarket?: FeedStatus;
}

export interface MarketMeta {
  title: string;
  question: string;
  slug: string;
  marketTicker?: string | null;
  subtitle?: string | null;
  venue?: string | null;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  conditionId: string | null;
  clobTokenIds: string[];
  yesTokenId: string | null;
  noTokenId: string | null;
  kalshiSeriesTicker?: string | null;
  kalshiEventTicker?: string | null;
  kalshiMarketTitle?: string | null;
  kalshiMarketUrl?: string | null;
  contractStrike?: number | null;
  strikeType?: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  marketPrice: number | null;
  midpoint: number | null;
  spread: number | null;
  lastTrade: number | null;
  displayProb: number | null;
  displaySource: PolyDisplaySource | null;
  lastUpdatedTs: number | null;
  historySource: string | null;
}

export interface SearchResult {
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDate: string | null;
}

export interface CrudePoint {
  timestamp: number;
  price: number;
  bid?: number | null;
  ask?: number | null;
  lastTrade?: number | null;
  midpoint?: number | null;
  markSource?: CrudeMarkSource | null;
  seededFrom?: HistorySeedSource | null;
}

export interface ProbabilityPoint {
  timestamp: number;
  price: number;
  bestBid?: number | null;
  bestAsk?: number | null;
  midpoint?: number | null;
  spread?: number | null;
  lastTrade?: number | null;
  displaySource?: PolyDisplaySource | null;
  seededFrom?: HistorySeedSource | null;
}

export interface CrudePayload {
  providerMode: ProviderMode;
  currentPrice: number | null;
  history: CrudePoint[];
  label: string;
  subLabel: string;
  isProxy: boolean;
  windowStartTs: number | null;
  windowEndTs: number | null;
  warnings: string[];
}

export interface Observation {
  timestamp: number;
  marketTicker: string;
  marketSlug?: string | null;
  yesTokenId?: string | null;
  crudePrice: number | null;
  polyProb: number | null;
  polyDisplaySource: PolyDisplaySource | null;
  fairProb: number | null;
  fairValueGap: number | null;
  empiricalDeltaInst: number | null;
  empiricalDeltaRoll: number | null;
  theoreticalDelta: number | null;
  deltaGap: number | null;
  signal: SignalState;
}

export interface BootstrapParams {
  slug: string;
  providerMode: ProviderMode;
  manualCrudePrice: number | null;
  strike: number;
  spreadWidth: number;
  impliedVol: number;
  riskFreeRate: number;
  rollingWindow: number;
  fairGapThreshold: number;
  deltaGapThreshold: number;
  expiryOverride: string | null;
}

export interface BootstrapPayload {
  ok: true;
  mode: SnapshotMode;
  market: MarketMeta;
  providerMode: ProviderMode;
  crudeLabel: string;
  crudeSubLabel: string;
  crudeIsProxy: boolean;
  crudeCurrentPrice: number | null;
  crudeHistory: CrudePoint[];
  polyHistory: ProbabilityPoint[];
  windowStartTs: number | null;
  windowEndTs: number | null;
  observations: Observation[];
  warnings: string[];
  generatedAt: string;
  sourceStatus?: SourceStatus | null;
}

export interface CrudeApiPayload extends CrudePayload {
  ok: true;
}

export interface ApiErrorPayload {
  ok: false;
  code: string;
  error: string;
  warnings?: string[];
}

export interface CuratedSession {
  id: string;
  label: string;
  description?: string | null;
  default: boolean;
  startTs?: string | null;
  endTs?: string | null;
}

export interface SessionListItem {
  id: string;
  label: string;
  curated: boolean;
  default: boolean;
  sessionStartedAt: string | null;
  crudeRange: [number, number] | null;
  observationCount: number;
  startTs: string | null;
  endTs: string | null;
}

export interface ReplayPricingDefaults {
  strike: number;
  spreadWidth: number;
  impliedVol: number;
  riskFreeRate: number;
  rollingWindow: number;
  fairGapThreshold: number;
  deltaGapThreshold: number;
}

export interface ReplayPayload {
  ok: true;
  sessionId: string;
  sessionStartedAt: string | null;
  market: MarketMeta;
  pricingDefaults: ReplayPricingDefaults;
  observations: Observation[];
  windowStartTs: number;
  windowEndTs: number;
  crudeLabel: string;
  crudeSubLabel: string;
  totalObservations: number;
}

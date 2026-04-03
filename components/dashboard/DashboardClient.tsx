"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ControlsPanel from "@/components/dashboard/ControlsPanel";
import EmptyStatePanels from "@/components/dashboard/EmptyStatePanels";
import HeaderStrip from "@/components/dashboard/HeaderStrip";
import KpiRow from "@/components/dashboard/KpiRow";
import MarketStateBanner from "@/components/dashboard/MarketStateBanner";
import MetricsStrip from "@/components/dashboard/MetricsStrip";
import MethodologyPanel from "@/components/dashboard/MethodologyPanel";
import {
  classifySignal,
  computeDeltaGap,
  computeFairValueGap,
  computeScatterStats,
  instantaneousDelta,
  nearestCrudePriceAtOrBefore,
  rollingRegressionSlope
} from "@/lib/analytics";
import { getCMEStatus } from "@/lib/cmeCalendar";
import type { CMEStatus } from "@/lib/cmeCalendar";
import {
  DEFAULT_DELTA_GAP_THRESHOLD,
  DEFAULT_FAIR_GAP_THRESHOLD,
  DEFAULT_IMPLIED_VOL,
  LIVE_PRESENTATION_BUCKET_MS,
  LIVE_PRESENTATION_WINDOW_MS,
  LIVE_SNAPSHOT_POLL_INTERVAL_MS,
  DEFAULT_RISK_FREE_RATE,
  DEFAULT_ROLLING_WINDOW,
  DEFAULT_SPREAD_WIDTH,
  DEFAULT_STRIKE
} from "@/lib/constants";
import { buildPayloadObservations } from "@/lib/polymarket";
import { callSpreadDelta, tightCallSpreadFairProb, yearFractionToExpiry } from "@/lib/pricing";
import type {
  ApiErrorPayload,
  BootstrapPayload,
  CrudePoint,
  FeedStatus,
  Observation,
  ProbabilityPoint,
  SnapshotMode
} from "@/lib/types";

const HeartbeatChart = dynamic(() => import("@/components/dashboard/HeartbeatChart"), {
  ssr: false,
  loading: () => (
    <div className="chart-panel chart-panel-skeleton">
      <div className="chart-loading">Loading chart...</div>
    </div>
  )
});

const ScatterDeltaChart = dynamic(() => import("@/components/dashboard/ScatterDeltaChart"), {
  ssr: false,
  loading: () => (
    <div className="chart-panel chart-panel-skeleton">
      <div className="chart-loading">Loading chart...</div>
    </div>
  )
});

const ObservationsTable = dynamic(() => import("@/components/dashboard/ObservationsTable"), {
  loading: () => (
    <div className="table-panel">
      <div className="chart-loading">Loading table...</div>
    </div>
  )
});

interface DashboardClientProps {
  initialPayload: BootstrapPayload | null;
  initialError: string | null;
  initialSlug: string;
  initialMode: SnapshotMode;
  appMode?: "live" | "replay";
  onToggleAppMode?: () => void;
  cmeStatus?: CMEStatus;
}

function isBootstrapPayload(value: unknown): value is BootstrapPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as BootstrapPayload).ok === true &&
      Array.isArray((value as BootstrapPayload).observations)
  );
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as ApiErrorPayload).ok === false &&
      typeof (value as ApiErrorPayload).error === "string"
  );
}

function uniqueMessages(messages: Array<string | null | undefined>): string[] {
  return Array.from(new Set(messages.filter(Boolean) as string[]));
}

function formatStatusTime(value: string | number | null | undefined): string {
  if (!value) {
    return "—";
  }

  const timestamp =
    typeof value === "number" ? value : Date.parse(String(value));

  if (Number.isNaN(timestamp)) {
    return "—";
  }

  return new Date(timestamp).toISOString().replace("T", " ").slice(11, 19);
}

function formatFeedStatus(label: string, status?: FeedStatus | null): string | null {
  if (!status) {
    return null;
  }

  const parts = [`${label} ${status.state}`];
  const lastSeen = formatStatusTime(status.lastEventTs);
  if (lastSeen !== "—") {
    parts.push(lastSeen);
  }
  if (status.detail) {
    parts.push(status.detail);
  }
  if (status.lastError) {
    parts.push(status.lastError);
  }

  return parts.join(" | ");
}

function getMarketFeedStatus(payload: BootstrapPayload | null): FeedStatus | null {
  return payload?.sourceStatus?.kalshi ?? payload?.sourceStatus?.polymarket ?? null;
}

function buildLiveMarketContext(payload: BootstrapPayload | null): string | null {
  const market = payload?.market;
  if (!market) {
    return null;
  }
  const subtitle = market.subtitle?.trim();
  const frequency =
    market.kalshiSeriesTicker === "KXWTI"
      ? "Daily"
      : market.kalshiSeriesTicker === "KXWTIW"
        ? "Weekly"
        : null;
  const title =
    subtitle && subtitle.length
      ? `WTI ${subtitle}`
      : market.kalshiMarketTitle || market.title || market.marketTicker || market.slug;
  return [title, frequency].filter(Boolean).join(" | ");
}

function formatStrikeLabel(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function pauseFairAnalytics(observation: Observation): Observation {
  return {
    ...observation,
    fairProb: null,
    fairValueGap: null,
    empiricalDeltaInst: null,
    empiricalDeltaRoll: null,
    theoreticalDelta: null,
    deltaGap: null
  };
}

function toTimestampMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function dedupeProbabilityHistory(points: ProbabilityPoint[]): ProbabilityPoint[] {
  const sorted = [...points].sort((left, right) => left.timestamp - right.timestamp);
  const deduped: ProbabilityPoint[] = [];

  for (const point of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && last.timestamp === point.timestamp) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
  }

  return deduped;
}

function dedupeCrudeHistory(points: CrudePoint[]): CrudePoint[] {
  const sorted = [...points].sort((left, right) => left.timestamp - right.timestamp);
  const deduped: CrudePoint[] = [];

  for (const point of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && last.timestamp === point.timestamp) {
      deduped[deduped.length - 1] = point;
      continue;
    }
    deduped.push(point);
  }

  return deduped;
}

function resampleLivePresentationHistories(params: {
  polyHistory: ProbabilityPoint[];
  crudeHistory: CrudePoint[];
  windowStartTs: number;
  windowEndTs: number;
  bucketMs: number;
}): {
  polyHistory: ProbabilityPoint[];
  crudeHistory: CrudePoint[];
} {
  const { polyHistory, crudeHistory, windowStartTs, windowEndTs, bucketMs } = params;
  if (!polyHistory.length && !crudeHistory.length) {
    return { polyHistory: [], crudeHistory: [] };
  }

  const earliestTs = Math.min(
    polyHistory[0]?.timestamp ?? Number.POSITIVE_INFINITY,
    crudeHistory[0]?.timestamp ?? Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(earliestTs)) {
    return { polyHistory: [], crudeHistory: [] };
  }

  const bucketStartTs = Math.floor(Math.max(windowStartTs, earliestTs) / bucketMs) * bucketMs;
  const resampledPoly: ProbabilityPoint[] = [];
  const resampledCrude: CrudePoint[] = [];

  let polyIndex = 0;
  let crudeIndex = 0;
  let latestPoly: ProbabilityPoint | null = null;
  let latestCrude: CrudePoint | null = null;

  for (let bucketTs = bucketStartTs; bucketTs <= windowEndTs; bucketTs += bucketMs) {
    while (polyIndex < polyHistory.length && polyHistory[polyIndex].timestamp <= bucketTs) {
      latestPoly = polyHistory[polyIndex];
      polyIndex += 1;
    }
    while (crudeIndex < crudeHistory.length && crudeHistory[crudeIndex].timestamp <= bucketTs) {
      latestCrude = crudeHistory[crudeIndex];
      crudeIndex += 1;
    }

    if (latestPoly) {
      resampledPoly.push({
        ...latestPoly,
        timestamp: bucketTs
      });
    }
    if (latestCrude) {
      resampledCrude.push({
        ...latestCrude,
        timestamp: bucketTs
      });
    }
  }

  return {
    polyHistory: dedupeProbabilityHistory(resampledPoly),
    crudeHistory: dedupeCrudeHistory(resampledCrude)
  };
}

function buildLivePresentationChartPayload(
  payload: BootstrapPayload
): Pick<BootstrapPayload, "market" | "polyHistory" | "crudeHistory"> | null {
  const marketFeedStatus = getMarketFeedStatus(payload);
  const latestTsCandidates = [
    payload.market.lastUpdatedTs,
    marketFeedStatus?.lastEventTs ?? null,
    payload.sourceStatus?.databento.lastEventTs ?? null,
    payload.polyHistory[payload.polyHistory.length - 1]?.timestamp ?? null,
    payload.crudeHistory[payload.crudeHistory.length - 1]?.timestamp ?? null
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!latestTsCandidates.length) {
    return null;
  }

  const windowEndTs = Math.max(...latestTsCandidates);
  const sessionStartedTs = toTimestampMs(payload.sourceStatus?.sessionStartedAt);
  const windowStartTs = Math.max(
    windowEndTs - LIVE_PRESENTATION_WINDOW_MS,
    sessionStartedTs ?? 0
  );

  const latestCrudePoint = payload.crudeHistory[payload.crudeHistory.length - 1] ?? null;
  const currentCrudeTs =
    payload.sourceStatus?.databento.lastEventTs ??
    latestCrudePoint?.timestamp ??
    null;

  const livePolyHistory = dedupeProbabilityHistory([
    ...payload.polyHistory.filter(
      (point) =>
        point.seededFrom === "live_recorder" && point.timestamp >= windowStartTs
    ),
    ...((payload.market.displayProb !== null &&
      payload.market.displaySource !== null &&
      payload.market.displaySource !== "tradeHistory" &&
      payload.market.lastUpdatedTs !== null &&
      payload.market.lastUpdatedTs >= windowStartTs)
      ? [
          {
            timestamp: payload.market.lastUpdatedTs,
            price: payload.market.displayProb,
            bestBid: payload.market.bestBid,
            bestAsk: payload.market.bestAsk,
            midpoint: payload.market.midpoint,
            spread: payload.market.spread,
            lastTrade: payload.market.lastTrade,
            displaySource: payload.market.displaySource,
            seededFrom: "live_recorder" as const
          }
        ]
      : [])
  ]);

  const lastCrudeBeforeWindow = (() => {
    let candidate: CrudePoint | null = null;
    for (const point of payload.crudeHistory) {
      if (point.timestamp < windowStartTs) {
        candidate = point;
      } else {
        break;
      }
    }
    return candidate;
  })();

  const liveCrudeHistory = dedupeCrudeHistory([
    ...(lastCrudeBeforeWindow ? [lastCrudeBeforeWindow] : []),
    ...payload.crudeHistory.filter((point) => point.timestamp >= windowStartTs),
    ...((payload.crudeCurrentPrice !== null &&
      currentCrudeTs !== null &&
      currentCrudeTs >= windowStartTs)
      ? [
          {
            timestamp: currentCrudeTs,
            price: payload.crudeCurrentPrice,
            bid: latestCrudePoint?.bid ?? null,
            ask: latestCrudePoint?.ask ?? null,
            midpoint: latestCrudePoint?.midpoint ?? null,
            lastTrade: latestCrudePoint?.lastTrade ?? null,
            markSource: latestCrudePoint?.markSource ?? null,
            seededFrom: "live_stream" as const
          }
        ]
      : [])
  ]);

  const resampled = resampleLivePresentationHistories({
    polyHistory: livePolyHistory,
    crudeHistory: liveCrudeHistory,
    windowStartTs,
    windowEndTs,
    bucketMs: LIVE_PRESENTATION_BUCKET_MS
  });

  if (!resampled.polyHistory.length && !resampled.crudeHistory.length) {
    return null;
  }

  return {
    market: payload.market,
    polyHistory: resampled.polyHistory,
    crudeHistory: resampled.crudeHistory
  };
}

function buildCurrentLiveObservation(params: {
  liveMode: boolean;
  payload: BootstrapPayload | null;
  observations: Observation[];
  strike: number;
  spreadWidth: number;
  impliedVol: number;
  riskFreeRate: number;
  rollingWindow: number;
  fairGapThreshold: number;
  deltaGapThreshold: number;
  expiryOverride: string | null;
}): Observation | null {
  const {
    liveMode,
    payload,
    observations,
    strike,
    spreadWidth,
    impliedVol,
    riskFreeRate,
    rollingWindow,
    fairGapThreshold,
    deltaGapThreshold,
    expiryOverride
  } = params;

  const latestObservation = observations.at(-1) ?? null;
  if (!liveMode || !payload) {
    return latestObservation;
  }

  const currentProb = payload.market.displayProb;
  const currentSource = payload.market.displaySource;
  const currentTs = payload.market.lastUpdatedTs;

  if (
    currentProb === null ||
    currentSource === null ||
    currentSource === "tradeHistory" ||
    currentTs === null
  ) {
    return latestObservation;
  }

  const latestMatchesCurrent =
    latestObservation &&
    Math.abs(latestObservation.timestamp - currentTs) < 1_000 &&
    latestObservation.polyProb === currentProb &&
    latestObservation.polyDisplaySource === currentSource;

  if (latestMatchesCurrent) {
    return latestObservation;
  }

  const crudePrice =
    payload.crudeCurrentPrice ??
    nearestCrudePriceAtOrBefore(currentTs, payload.crudeHistory) ??
    latestObservation?.crudePrice ??
    null;

  let fairProb: number | null = null;
  let theoreticalDelta: number | null = null;

  if (crudePrice !== null && Number.isFinite(crudePrice) && crudePrice > 0 && strike > 0 && spreadWidth > 0) {
    try {
      const expiry = expiryOverride || payload.market.endDate;
      const horizon = yearFractionToExpiry(expiry, new Date(currentTs));
      fairProb = tightCallSpreadFairProb(
        crudePrice,
        strike,
        spreadWidth,
        horizon,
        riskFreeRate,
        impliedVol
      );
      theoreticalDelta = callSpreadDelta(
        crudePrice,
        strike,
        spreadWidth,
        horizon,
        riskFreeRate,
        impliedVol
      );
    } catch {
      fairProb = null;
      theoreticalDelta = null;
    }
  }

  const previousObservation = latestObservation;
  const empiricalDeltaInst = previousObservation
    ? instantaneousDelta(
        previousObservation.polyProb,
        previousObservation.crudePrice,
        currentProb,
        crudePrice
      )
    : null;

  const rollingWindowBase = rollingWindow > 1 ? observations.slice(-(rollingWindow - 1)) : [];
  const empiricalDeltaRoll = rollingRegressionSlope(
    [...rollingWindowBase.map((point) => point.crudePrice), crudePrice],
    [...rollingWindowBase.map((point) => point.polyProb), currentProb]
  );
  const fairValueGap = computeFairValueGap(currentProb, fairProb);
  const deltaGap = computeDeltaGap(empiricalDeltaRoll, theoreticalDelta);

  return {
    timestamp: currentTs,
    marketTicker: payload.market.marketTicker || payload.market.slug,
    marketSlug: payload.market.slug,
    yesTokenId: payload.market.yesTokenId ?? null,
    crudePrice,
    polyProb: currentProb,
    polyDisplaySource: currentSource,
    fairProb,
    fairValueGap,
    empiricalDeltaInst,
    empiricalDeltaRoll,
    theoreticalDelta,
    deltaGap,
    signal: classifySignal(
      fairValueGap,
      deltaGap,
      fairGapThreshold,
      deltaGapThreshold
    )
  };
}

function buildBootstrapUrl(params: {
  slug: string;
  strike: number;
  spreadWidth: number;
  impliedVol: number;
  riskFreeRate: number;
  rollingWindow: number;
  fairGapThreshold: number;
  deltaGapThreshold: number;
  expiryOverride: string | null;
}): string {
  const url = new URL("/api/bootstrap", window.location.origin);
  url.searchParams.set("slug", params.slug);
  url.searchParams.set("strike", String(params.strike));
  url.searchParams.set("spreadWidth", String(params.spreadWidth));
  url.searchParams.set("impliedVol", String(params.impliedVol));
  url.searchParams.set("riskFreeRate", String(params.riskFreeRate));
  url.searchParams.set("rollingWindow", String(params.rollingWindow));
  url.searchParams.set("fairGapThreshold", String(params.fairGapThreshold));
  url.searchParams.set("deltaGapThreshold", String(params.deltaGapThreshold));
  if (params.expiryOverride) {
    url.searchParams.set("expiryOverride", params.expiryOverride);
  }
  return url.toString();
}

export default function DashboardClient({
  initialPayload,
  initialError,
  initialSlug,
  initialMode,
  appMode,
  onToggleAppMode,
  cmeStatus: cmeStatusProp
}: DashboardClientProps) {
  const [payload, setPayload] = useState<BootstrapPayload | null>(initialPayload);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialError);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(Boolean(!initialPayload));
  const [showSlowLoadNote, setShowSlowLoadNote] = useState(false);
  const [presentationMode, setPresentationMode] = useState(true);
  const [tableOpen, setTableOpen] = useState(false);
  const initialLoadStartedRef = useRef(false);
  const lastLiveMarketTickerRef = useRef<string | null>(
    initialPayload?.market.marketTicker ?? initialPayload?.market.slug ?? null
  );
  const monitorMode = payload?.mode ?? initialMode;
  const liveMode = monitorMode === "live";

  const [slug, setSlug] = useState(
    initialPayload?.market.marketTicker ?? initialPayload?.market.slug ?? initialSlug
  );
  const [strike, setStrike] = useState(
    initialPayload?.market.contractStrike ?? DEFAULT_STRIKE
  );
  const [spreadWidth, setSpreadWidth] = useState(DEFAULT_SPREAD_WIDTH);
  const [impliedVol, setImpliedVol] = useState(DEFAULT_IMPLIED_VOL);
  const [riskFreeRate, setRiskFreeRate] = useState(DEFAULT_RISK_FREE_RATE);
  const [rollingWindow, setRollingWindow] = useState(DEFAULT_ROLLING_WINDOW);
  const [fairGapThreshold, setFairGapThreshold] = useState(DEFAULT_FAIR_GAP_THRESHOLD);
  const [deltaGapThreshold, setDeltaGapThreshold] = useState(DEFAULT_DELTA_GAP_THRESHOLD);
  const [useMarketExpiry, setUseMarketExpiry] = useState(true);
  const [expiryOverride, setExpiryOverride] = useState(
    initialPayload?.market.endDate?.slice(0, 10) ?? ""
  );
  const marketFeedStatus = getMarketFeedStatus(payload);
  const marketVenueLabel = liveMode ? "Kalshi" : "Poly";
  const marketLegendLabel = liveMode ? "Kalshi" : "Poly";
  const marketCardLabel = liveMode ? "Kalshi Yes" : "Poly Yes";
  const marketCardContext = liveMode ? buildLiveMarketContext(payload) : null;
  const marketInstrument = payload?.market.marketTicker ?? payload?.market.slug ?? slug;
  const crudeFeedState = liveMode ? payload?.sourceStatus?.databento.state ?? null : null;
  const prevCrudeFeedStateRef = useRef<string | null>(null);
  const reconnectGraceEndRef = useRef<number>(0);
  const hiddenAtRef = useRef<number | null>(null);
  // When the tab is foregrounded after >60s in the background, set this to
  // Date.now() so the scatter only shows post-gap observations. The heartbeat
  // is unaffected — it keeps showing the full windowed session history.
  const [scatterGapCutoff, setScatterGapCutoff] = useState<number>(0);

  // useState so expiry triggers a re-render (a ref would not).
  // True for the first 15s after hydration — prevents the "stale" banner from
  // flashing on load when the SSR snapshot is a few seconds old.
  const [startupGraceActive, setStartupGraceActive] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setStartupGraceActive(false), 15_000);
    return () => clearTimeout(t);
  }, []);

  // When the feed transitions connected → non-connected, arm a 90s grace period.
  // The ref update fires before the memo re-runs (same React batch), so the
  // banner stays hidden during brief reconnects that resolve within 90s.
  useEffect(() => {
    const prev = prevCrudeFeedStateRef.current;
    if (prev === "connected" && crudeFeedState && crudeFeedState !== "connected") {
      reconnectGraceEndRef.current = Date.now() + 90_000;
    }
    prevCrudeFeedStateRef.current = crudeFeedState;
  }, [crudeFeedState]);

  // Page Visibility API — detect Chrome background tab throttling.
  // When the tab has been hidden for >60s and comes back, old observations
  // from before the gap are still within the 20-min time window but represent
  // a different price regime. Reset the scatter cutoff so only post-gap data
  // is shown. The heartbeat chart is unaffected.
  useEffect(() => {
    if (!liveMode) {
      return undefined;
    }

    const handler = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        const hiddenAt = hiddenAtRef.current;
        hiddenAtRef.current = null;
        if (hiddenAt !== null && Date.now() - hiddenAt > 60_000) {
          setScatterGapCutoff(Date.now());
        }
      }
    };

    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [liveMode]);

  const rawCrudeFeedPauseMessage = useMemo(() => {
    if (!liveMode || !payload || crudeFeedState === "connected") {
      return null;
    }

    const sessionStartedAt = payload.sourceStatus?.sessionStartedAt;
    const sessionAgeMs = sessionStartedAt
      ? Date.now() - Date.parse(sessionStartedAt)
      : Number.POSITIVE_INFINITY;
    const inSessionGrace = sessionAgeMs < 120_000;
    const inReconnectGrace = Date.now() < reconnectGraceEndRef.current;
    const inGrace = startupGraceActive || inSessionGrace || inReconnectGrace;

    if (crudeFeedState === "stale") {
      return inGrace ? null : "Crude feed stale - fair value paused";
    }
    if (crudeFeedState === "reconnecting") {
      return inGrace ? null : "Crude feed reconnecting - fair value paused";
    }
    if (crudeFeedState === "warming") {
      return inGrace ? null : "Crude feed warming - fair value paused";
    }
    if (crudeFeedState === "disconnected") {
      return "Crude feed disconnected - fair value paused";
    }
    return null;
  }, [crudeFeedState, liveMode, payload, startupGraceActive]);

  // cmeStatus comes from DashboardShell (computed once, shared) — fall back to
  // a local computation only if the prop isn't provided (e.g. in tests).
  const cmeStatus = cmeStatusProp ?? getCMEStatus();
  // Calendar is the source of truth — don't wait for the feed to time out.
  const cmeIsClosed = liveMode && !cmeStatus.isOpen;

  // When CME is closed, null out the "stale/paused" messages everywhere — the
  // CME banner is the single source of truth for why things look quiet.
  const crudeFeedPauseMessage = cmeIsClosed ? null : rawCrudeFeedPauseMessage;
  const fairAnalyticsPaused = Boolean(crudeFeedPauseMessage);
  const chartExplainers = useMemo(() => {
    const spreadLow = (strike - spreadWidth / 2).toFixed(1);
    const spreadHigh = (strike + spreadWidth / 2).toFixed(1);
    const venue = liveMode ? "Kalshi" : "Polymarket";
    const strikeLabel = formatStrikeLabel(strike);
    const ivLabel = Math.round(impliedVol * 100);
    const B = ({ children }: { children: React.ReactNode }) => (
      <strong className="explain-keyword">{children}</strong>
    );

    if (fairAnalyticsPaused) {
      return {
        whatYoureSeeingTitle: "Fair Value Paused",
        whatYoureSeeing: (
          <>
            The dashboard is still showing <B>{venue}&apos;s live market</B>, but the crude side is
            not trustworthy right now. When Databento CL goes stale, reconnects, or warms up, the
            UI intentionally hides the <B>orange fair-value line</B> and pauses all{" "}
            <B>crude-linked pricing analytics</B> instead of pretending they are still live.
          </>
        ),
        readingScatterTitle: "Why The Scatter Is Paused",
        readingScatter: (
          <>
            The scatter, regression slope, and {venue} minus theo signal all depend on{" "}
            <B>fresh paired CL and market observations</B>. If crude is stale, the dashboard keeps
            showing the <B>last known CL print for context</B> but refuses to render a live-looking
            regression off dead inputs. <B>The next real fix is the Databento resume path.</B>
          </>
        )
      };
    }

    return {
      whatYoureSeeingTitle: "What You're Seeing",
      whatYoureSeeing: (
        <>
          The orange line is the <B>value of the {spreadLow}/{spreadHigh} call spread</B> &mdash;
          priced via Black-Scholes at {ivLabel} IV as CL moves. It is the{" "}
          <B>fair probability</B> that CL settles above ${strikeLabel}. It moves smoothly because
          vol is held constant and only S changes. The teal line is{" "}
          <B>{venue}&apos;s market price</B> for the same question. It tracks the same fundamental
          but bounces harder &mdash; order flow, sentiment, and liquidity make it noisy.{" "}
          <B>The gap between them is the trade.</B>
        </>
      ),
      readingScatterTitle: "Reading the Scatter",
      readingScatter: (
        <>
          Each dot is a snapshot: x&nbsp;=&nbsp;CL price, y&nbsp;=&nbsp;probability. The{" "}
          <B>slope of the regression line is the delta</B> &mdash; how much probability moves per
          $1 in CL. The call spread slope is your <B>model delta</B>. The {venue} slope is the{" "}
          <B>implied delta</B>. If {venue}&apos;s slope is steeper, the market is overreacting to
          price moves &mdash; you&apos;d sell {venue} and hedge with futures. The{" "}
          <B>ratio of slopes suggests an edge</B>.
        </>
      )
    };
  }, [fairAnalyticsPaused, impliedVol, liveMode, spreadWidth, strike]);

  const observations = useMemo(
    () =>
      payload
        ? buildPayloadObservations(payload, {
            strike,
            spreadWidth,
            impliedVol,
            riskFreeRate,
            rollingWindow,
            fairGapThreshold,
            deltaGapThreshold,
            expiryOverride: useMarketExpiry ? null : expiryOverride || null
          })
        : [],
    [
      deltaGapThreshold,
      expiryOverride,
      fairGapThreshold,
      impliedVol,
      payload,
      riskFreeRate,
      rollingWindow,
      spreadWidth,
      strike,
      useMarketExpiry
    ]
  );
  const chartPayload = useMemo(() => {
    if (!payload) {
      return null;
    }

    if (!liveMode || !presentationMode) {
      return payload;
    }

    return buildLivePresentationChartPayload(payload) ?? payload;
  }, [liveMode, payload, presentationMode]);
  const chartObservations = useMemo(() => {
    if (!chartPayload) {
      return [];
    }

    return buildPayloadObservations(chartPayload, {
      strike,
      spreadWidth,
      impliedVol,
      riskFreeRate,
      rollingWindow,
      fairGapThreshold,
      deltaGapThreshold,
      expiryOverride: useMarketExpiry ? null : expiryOverride || null
    });
  }, [
    chartPayload,
    deltaGapThreshold,
    expiryOverride,
    fairGapThreshold,
    impliedVol,
    riskFreeRate,
    rollingWindow,
    spreadWidth,
    strike,
    useMarketExpiry
  ]);
  const displayChartObservations = useMemo(
    () =>
      fairAnalyticsPaused
        ? chartObservations.map((observation) => pauseFairAnalytics(observation))
        : chartObservations,
    [chartObservations, fairAnalyticsPaused]
  );
  // Scatter-only view: exclude observations from before the last background gap.
  // displayChartObservations (used by the heartbeat) keeps the full 20-min window.
  const scatterObservations = useMemo(
    () =>
      scatterGapCutoff > 0
        ? displayChartObservations.filter(
            (observation) => observation.timestamp >= scatterGapCutoff
          )
        : displayChartObservations,
    [displayChartObservations, scatterGapCutoff]
  );
  const latestChartGapObservation = useMemo(
    () =>
      [...displayChartObservations]
        .reverse()
        .find(
          (observation) =>
            observation.polyProb !== null &&
            observation.fairProb !== null &&
            observation.fairValueGap !== null
        ) ?? null,
    [displayChartObservations]
  );
  const currentObservation = useMemo(
    () =>
      buildCurrentLiveObservation({
        liveMode,
        payload,
        observations,
        strike,
        spreadWidth,
        impliedVol,
        riskFreeRate,
        rollingWindow,
        fairGapThreshold,
        deltaGapThreshold,
        expiryOverride: useMarketExpiry ? null : expiryOverride || null
      }),
    [
      deltaGapThreshold,
      expiryOverride,
      fairGapThreshold,
      impliedVol,
      liveMode,
      observations,
      payload,
      riskFreeRate,
      rollingWindow,
      spreadWidth,
      strike,
      useMarketExpiry
    ]
  );
  const analyticsObservation = useMemo(
    () =>
      currentObservation && fairAnalyticsPaused
        ? pauseFairAnalytics(currentObservation)
        : currentObservation,
    [currentObservation, fairAnalyticsPaused]
  );
  // Always prefer the freshly-computed analyticsObservation for the gap card so
  // both Presentation and Research views show the same number. Fall back to the
  // chart-history observation only when there is no live observation at all.
  const gapObservation = analyticsObservation ?? latestChartGapObservation;
  const scatterStats = useMemo(
    () => computeScatterStats(scatterObservations),
    [scatterObservations]
  );
  const derivedWarnings = useMemo(() => {
    if (!payload) {
      return [];
    }

    const warnings = [...payload.warnings];
    const pairedObservationCount = observations.filter(
      (observation) => observation.crudePrice !== null
    ).length;
    const fairValueCount = observations.filter(
      (observation) => observation.fairProb !== null
    ).length;

    if (!warnings.length && pairedObservationCount === 0) {
      warnings.push("Paired delayed data still accumulating or unavailable.");
    } else if (!warnings.length && pairedObservationCount > 0 && fairValueCount === 0) {
      warnings.push(
        "Crude history loaded, but the current pricing inputs did not produce usable fair values."
      );
    }

    return warnings;
  }, [observations, payload]);
  const hasSnapshot = Boolean(payload);
  const isLoading = isFetching && !hasSnapshot;
  const isRefreshing = isFetching && hasSnapshot;

  const statusMessages = useMemo(() => {
    if (presentationMode) {
      return uniqueMessages([
        isLoading
          ? liveMode
            ? "Loading local live snapshot..."
            : "Loading delayed Databento + Polymarket historical window..."
          : null,
        !hasSnapshot ? errorMessage : null,
        crudeFeedPauseMessage
      ]);
    }

    return uniqueMessages([
      isLoading
        ? liveMode
          ? "Loading live snapshot..."
          : "Loading delayed Databento + Polymarket historical window..."
        : null,
      isRefreshing
        ? liveMode
          ? "Refreshing local live snapshot..."
          : "Refreshing delayed snapshot in background..."
        : null,
      !liveMode && payload?.windowEndTs
        ? `Window ends at latest entitled CME historical timestamp: ${new Date(
            payload.windowEndTs
          )
            .toISOString()
            .replace("T", " ")
            .slice(0, 16)} UTC`
        : null,
      liveMode ? formatFeedStatus("Databento", payload?.sourceStatus?.databento) : null,
      liveMode ? formatFeedStatus(marketVenueLabel, marketFeedStatus) : null,
      liveMode && payload?.sourceStatus?.snapshotWrittenAt
        ? `Snapshot written ${formatStatusTime(payload.sourceStatus.snapshotWrittenAt)} UTC`
        : null,
      liveMode && payload?.sourceStatus?.sessionStartedAt
        ? `Session started ${formatStatusTime(payload.sourceStatus.sessionStartedAt)} UTC`
        : null,
      liveMode && payload?.sourceStatus?.marketTicker
        ? `Ticker ${payload.sourceStatus.marketTicker}`
        : null,
      liveMode && (payload?.sourceStatus?.marketHistorySource || payload?.sourceStatus?.polyHistorySource)
        ? `${marketVenueLabel} history ${
            payload?.sourceStatus?.marketHistorySource || payload?.sourceStatus?.polyHistorySource
          }`
        : null,
      liveMode && payload?.sourceStatus?.crudeHistorySource
        ? `Crude history ${payload.sourceStatus.crudeHistorySource}`
        : null,
      liveMode && payload?.market.displaySource
        ? `${marketVenueLabel} display ${payload.market.displaySource}`
        : null,
      !liveMode && showSlowLoadNote && process.env.NODE_ENV !== "production"
        ? "Historical load is slow because Databento + Polymarket are being aligned server-side."
        : null,
      cmeIsClosed ? null : crudeFeedPauseMessage,
      refreshMessage,
      ...derivedWarnings,
      errorMessage
    ]);
  }, [
    derivedWarnings,
    errorMessage,
    hasSnapshot,
    isLoading,
    isRefreshing,
    liveMode,
    marketFeedStatus,
    marketVenueLabel,
    payload?.market.displaySource,
    payload?.sourceStatus?.crudeHistorySource,
    payload?.sourceStatus?.databento,
    payload?.sourceStatus?.marketHistorySource,
    payload?.sourceStatus?.marketTicker,
    payload?.sourceStatus?.polyHistorySource,
    payload?.sourceStatus?.sessionStartedAt,
    payload?.sourceStatus?.snapshotWrittenAt,
    payload?.windowEndTs,
    presentationMode,
    crudeFeedPauseMessage,
    refreshMessage,
    showSlowLoadNote
  ]);

  const loadSnapshot = useCallback(async () => {
    const hadSnapshot = Boolean(payload);
    const startedAt = Date.now();
    setIsFetching(true);
    setShowSlowLoadNote(false);
    setRefreshMessage(null);
    if (!hadSnapshot) {
      setErrorMessage(null);
    }

    if (process.env.NODE_ENV !== "production") {
      console.info(liveMode ? "[live-snapshot] start" : "[bootstrap] start", {
        slug: slug.trim(),
        startedAt: new Date(startedAt).toISOString()
      });
    }

    try {
      let response: Response;
      if (liveMode) {
        response = await fetch("/api/live-snapshot", {
          cache: "no-store"
        });
      } else {
        const cleanSlug = slug.trim();
        if (!cleanSlug) {
          setErrorMessage("Missing market slug.");
          setIsFetching(false);
          return;
        }

        response = await fetch(
          buildBootstrapUrl({
            slug: cleanSlug,
            strike,
            spreadWidth,
            impliedVol,
            riskFreeRate,
            rollingWindow,
            fairGapThreshold,
            deltaGapThreshold,
            expiryOverride: useMarketExpiry ? null : expiryOverride || null
          })
        );
      }

      const json = (await response.json()) as unknown;

      if (isBootstrapPayload(json)) {
        setPayload(json);
        setSlug(json.market.marketTicker || json.market.slug || slug.trim() || initialSlug);
        setErrorMessage(null);
        if (json.market.endDate && !expiryOverride) {
          setExpiryOverride(json.market.endDate.slice(0, 10));
        }
        return;
      }

      if (isApiErrorPayload(json)) {
        if (hadSnapshot) {
          setRefreshMessage(
            liveMode
              ? "Live snapshot refresh failed. Serving last successful snapshot."
              : "Refresh failed. Serving last successful snapshot."
          );
        } else {
          setErrorMessage(json.error);
        }
        return;
      }

      if (hadSnapshot) {
        setRefreshMessage(
          liveMode
            ? "Live snapshot refresh failed. Serving last successful snapshot."
            : "Refresh failed. Serving last successful snapshot."
        );
      } else {
        setErrorMessage(
          liveMode ? "Unexpected live snapshot response." : "Unexpected bootstrap response."
        );
      }
    } catch (error) {
      if (hadSnapshot) {
        setRefreshMessage(
          liveMode
            ? "Live snapshot refresh failed. Serving last successful snapshot."
            : "Refresh failed. Serving last successful snapshot."
        );
      } else {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : liveMode
              ? "Failed to load live snapshot."
              : "Failed to load delayed window."
        );
      }
    } finally {
      if (process.env.NODE_ENV !== "production") {
        console.info(liveMode ? "[live-snapshot] end" : "[bootstrap] end", {
          slug: slug.trim(),
          elapsedMs: Date.now() - startedAt
        });
      }
      setIsFetching(false);
    }
  }, [
    liveMode,
    initialSlug,
    payload,
    deltaGapThreshold,
    expiryOverride,
    fairGapThreshold,
    impliedVol,
    riskFreeRate,
    rollingWindow,
    slug,
    spreadWidth,
    strike,
    useMarketExpiry
  ]);

  useEffect(() => {
    if (initialLoadStartedRef.current) {
      return;
    }
    initialLoadStartedRef.current = true;
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (!liveMode || !payload) {
      return;
    }
    const liveMarketTicker = payload.market.marketTicker ?? payload.market.slug ?? null;
    if (!liveMarketTicker || lastLiveMarketTickerRef.current === liveMarketTicker) {
      return;
    }
    lastLiveMarketTickerRef.current = liveMarketTicker;
    setSlug(liveMarketTicker);
    if (
      typeof payload.market.contractStrike === "number" &&
      Number.isFinite(payload.market.contractStrike)
    ) {
      setStrike(payload.market.contractStrike);
    }
    if (payload.market.endDate) {
      setExpiryOverride(payload.market.endDate.slice(0, 10));
    }
  }, [
    liveMode,
    payload,
    payload?.market.contractStrike,
    payload?.market.endDate,
    payload?.market.marketTicker,
    payload?.market.slug
  ]);

  useEffect(() => {
    if (!liveMode) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void loadSnapshot();
    }, LIVE_SNAPSHOT_POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [liveMode, loadSnapshot]);

  useEffect(() => {
    if (!isLoading || liveMode || process.env.NODE_ENV === "production") {
      setShowSlowLoadNote(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setShowSlowLoadNote(true);
    }, 10_000);

    return () => window.clearTimeout(timeout);
  }, [isLoading, liveMode]);

  const hasObservations = Boolean(chartObservations.length);

  // ── CME closed: replace entire dashboard body with a clean holiday hero ──
  if (cmeIsClosed && onToggleAppMode) {
    return (
      <div className="monitor-shell">
        <HeaderStrip
          appMode={appMode}
          generatedAt={payload?.generatedAt ?? null}
          lastUpdatedTs={
            payload?.market.lastUpdatedTs ??
            marketFeedStatus?.lastEventTs ??
            payload?.sourceStatus?.databento.lastEventTs ??
            currentObservation?.timestamp ??
            null
          }
          marketDisplaySource={payload?.market.displaySource ?? null}
          marketUrl={payload?.sourceStatus?.marketUrl ?? payload?.market.kalshiMarketUrl ?? null}
          marketVenueLabel={marketVenueLabel}
          mode={monitorMode}
          onToggleAppMode={onToggleAppMode}
          onTogglePresentationMode={() => setPresentationMode((value) => !value)}
          presentationMode={presentationMode}
          selectedInstrument={marketInstrument}
          sourceStatus={payload?.sourceStatus ?? null}
          windowEndTimestamp={payload?.windowEndTs ?? null}
          cmeStatus={cmeStatus}
        />

        <div className="cme-closed-hero">
          <div className="cme-closed-hero-badge">MARKET HOLIDAY</div>
          <h2 className="cme-closed-hero-title">
            CME Globex closed — {cmeStatus.reason}
          </h2>
          <p className="cme-closed-hero-sub">
            Live market data resumes {cmeStatus.reopens ?? "when the market reopens"}.
          </p>
          <button
            className="cme-closed-hero-btn"
            onClick={onToggleAppMode}
            type="button"
          >
            View Replay →
          </button>
          <p className="cme-closed-hero-hint">
            Replay shows real captured market data through the full interactive dashboard
          </p>
        </div>

        <MethodologyPanel />
      </div>
    );
  }

  return (
    <div className="monitor-shell">
      <HeaderStrip
        appMode={appMode}
        generatedAt={payload?.generatedAt ?? null}
        lastUpdatedTs={
          payload?.market.lastUpdatedTs ??
          marketFeedStatus?.lastEventTs ??
          payload?.sourceStatus?.databento.lastEventTs ??
          currentObservation?.timestamp ??
          null
        }
        marketDisplaySource={payload?.market.displaySource ?? null}
        marketUrl={payload?.sourceStatus?.marketUrl ?? payload?.market.kalshiMarketUrl ?? null}
        marketVenueLabel={marketVenueLabel}
        mode={monitorMode}
        onToggleAppMode={onToggleAppMode}
        onTogglePresentationMode={() => setPresentationMode((value) => !value)}
        presentationMode={presentationMode}
        selectedInstrument={marketInstrument}
        sourceStatus={payload?.sourceStatus ?? null}
        windowEndTimestamp={payload?.windowEndTs ?? null}
        cmeStatus={cmeStatus}
      />

      <MarketStateBanner
        isLiveMode={liveMode}
        lastKalshiUpdateTs={
          payload?.market.lastUpdatedTs ?? marketFeedStatus?.lastEventTs ?? null
        }
        crudeFeedState={crudeFeedState}
        kalshiProb={currentObservation?.polyProb ?? null}
        cmeStatus={cmeStatus}
        onSwitchToReplay={appMode !== "replay" && onToggleAppMode ? onToggleAppMode : undefined}
      />

      {statusMessages.length ? (
        <div className="status-ribbon status-ribbon-compact">
          {statusMessages.map((message) => (
            <span className="status-pill status-pill-note" key={message}>
              {message}
            </span>
          ))}
        </div>
      ) : null}

      {presentationMode ? null : (
        <ControlsPanel
          snapshotMode={monitorMode}
          slug={slug}
          onSlugChange={setSlug}
          strike={strike}
          onStrikeChange={setStrike}
          spreadWidth={spreadWidth}
          onSpreadWidthChange={setSpreadWidth}
          impliedVol={impliedVol}
          onImpliedVolChange={setImpliedVol}
          riskFreeRate={riskFreeRate}
          onRiskFreeRateChange={setRiskFreeRate}
          rollingWindow={rollingWindow}
          onRollingWindowChange={setRollingWindow}
          fairGapThreshold={fairGapThreshold}
          onFairGapThresholdChange={setFairGapThreshold}
          deltaGapThreshold={deltaGapThreshold}
          onDeltaGapThresholdChange={setDeltaGapThreshold}
          useMarketExpiry={useMarketExpiry}
          onUseMarketExpiryChange={setUseMarketExpiry}
          expiryOverride={expiryOverride}
          onExpiryOverrideChange={setExpiryOverride}
          onRefresh={loadSnapshot}
          isLoading={isFetching}
        />
      )}

      <KpiRow
        latestObservation={analyticsObservation}
        gapObservation={gapObservation}
        mode={monitorMode}
        crudeLabel={payload?.crudeLabel ?? "CME CL.c.0 (Databento)"}
        crudeSubLabel={payload?.crudeSubLabel ?? "T+1 Delayed Intraday"}
        crudeUpdatedTs={
          payload?.sourceStatus?.databento.lastEventTs ??
          payload?.crudeHistory.at(-1)?.timestamp ??
          null
        }
        marketVenueLabel={marketVenueLabel}
        marketCardLabel={marketCardLabel}
        marketCardContext={marketCardContext}
        polyDisplaySource={payload?.market.displaySource ?? null}
        polyUpdatedTs={
          payload?.market.lastUpdatedTs ??
          marketFeedStatus?.lastEventTs ??
          currentObservation?.timestamp ??
          null
        }
        strike={strike}
        spreadWidth={spreadWidth}
        impliedVol={impliedVol}
        crudeFeedState={crudeFeedState}
        fairPausedMessage={crudeFeedPauseMessage}
        isLoading={isLoading}
        cmeIsClosed={cmeIsClosed}
        cmeReason={cmeStatus.reason}
      />

      {presentationMode ? null : (
        <MetricsStrip
          empiricalDelta={analyticsObservation?.empiricalDeltaRoll ?? null}
          theoreticalDelta={analyticsObservation?.theoreticalDelta ?? null}
          deltaGap={analyticsObservation?.deltaGap ?? null}
          slopeRatio={scatterStats.ratio}
        />
      )}

      {hasObservations ? (
        <>
          <section className="charts-grid">
            <HeartbeatChart
              observations={displayChartObservations}
              crudeLabel={payload?.crudeLabel ?? "CME CL.c.0 (Databento)"}
              marketLegendLabel={marketLegendLabel}
              pausedMessage={
                cmeIsClosed
                  ? "Kalshi market quotes shown — no CME crude data available. Switch to Replay to see the full dashboard."
                  : crudeFeedPauseMessage
              }
              cmeNote={
                cmeIsClosed
                  ? "Kalshi quotes only — CME crude feed offline (market holiday)"
                  : null
              }
              resetKey={`${marketInstrument}-${strike}`}
            />
            <ScatterDeltaChart
              observations={scatterObservations}
              marketLegendLabel={marketLegendLabel}
              pausedMessage={
                cmeIsClosed
                  ? "CME closed — switch to Replay to see the dashboard in action"
                  : crudeFeedPauseMessage
              }
            />
          </section>

          <section className="explain-grid">
            <article className="explain-card">
              <div className="explain-title">{chartExplainers.whatYoureSeeingTitle}</div>
              <div className="explain-copy">{chartExplainers.whatYoureSeeing}</div>
            </article>
            <article className="explain-card">
              <div className="explain-title">{chartExplainers.readingScatterTitle}</div>
              <div className="explain-copy">{chartExplainers.readingScatter}</div>
            </article>
          </section>

          {presentationMode ? null : (
            <details
              className="table-disclosure"
              onToggle={(event) =>
                setTableOpen((event.currentTarget as HTMLDetailsElement).open)
              }
            >
              <summary>
                {tableOpen
                  ? liveMode
                    ? "Hide recorded observations"
                    : "Hide delayed observations"
                  : liveMode
                    ? "Show recorded observations"
                    : "Show delayed observations"}
              </summary>
              {tableOpen ? (
                <ObservationsTable observations={observations} mode={monitorMode} />
              ) : null}
            </details>
          )}
        </>
      ) : isLoading ? (
        <section className="charts-grid">
          <div className="chart-panel chart-panel-skeleton">
            <div className="chart-loading">Loading chart...</div>
          </div>
          <div className="chart-panel chart-panel-skeleton">
            <div className="chart-loading">Loading chart...</div>
          </div>
        </section>
      ) : (
        <EmptyStatePanels isLoading={isLoading} mode={monitorMode} />
      )}

      <MethodologyPanel />
    </div>
  );
}

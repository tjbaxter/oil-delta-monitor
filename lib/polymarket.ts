import {
  DATA_REVALIDATE_SECONDS,
  HISTORY_FIDELITY_MINUTES,
  HISTORY_INTERVAL,
  MAX_OBSERVATIONS,
  POLY_CLOB_BASE_URL,
  POLY_GAMMA_BASE_URL,
  SEARCH_TOKENS
} from "@/lib/constants";
import { unstable_cache } from "next/cache";
import { buildObservations } from "@/lib/analytics";
import { fetchCrudeData } from "@/lib/crude";
import type {
  BootstrapParams,
  BootstrapPayload,
  CrudePayload,
  MarketMeta,
  ProbabilityPoint,
  SearchResult
} from "@/lib/types";

interface DelayedWindowData {
  market: MarketMeta;
  crudeBundle: CrudePayload;
  polyHistory: ProbabilityPoint[];
}

export function buildPayloadObservations(
  payload: Pick<
    BootstrapPayload,
    "market" | "polyHistory" | "crudeHistory"
  >,
  params: Pick<
    BootstrapParams,
    | "strike"
    | "spreadWidth"
    | "impliedVol"
    | "riskFreeRate"
    | "rollingWindow"
    | "fairGapThreshold"
    | "deltaGapThreshold"
    | "expiryOverride"
  >
) {
  return buildObservations({
    marketTicker: payload.market.marketTicker || payload.market.slug,
    marketSlug: payload.market.slug,
    yesTokenId: payload.market.yesTokenId ?? null,
    polyHistory: payload.polyHistory,
    crudeHistory: payload.crudeHistory,
    strike: params.strike,
    spreadWidth: params.spreadWidth,
    impliedVol: params.impliedVol,
    riskFreeRate: params.riskFreeRate,
    expiry: params.expiryOverride || payload.market.endDate,
    rollingWindow: params.rollingWindow,
    fairGapThreshold: params.fairGapThreshold,
    deltaGapThreshold: params.deltaGapThreshold
  });
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value)).filter(Boolean);
  }

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.map((value) => String(value)).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseOutcomePrices(raw: unknown): number[] {
  return parseStringArray(raw)
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null);
}

function marketTextBlob(market: Record<string, unknown>): string {
  return [
    market.question,
    market.title,
    market.name,
    market.slug,
    market.eventTitle
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" ");
}

function tokenSet(market: Record<string, unknown>): Set<string> {
  return new Set(marketTextBlob(market).match(/[a-z0-9]+/g) ?? []);
}

function isOilRelevant(market: Record<string, unknown>): boolean {
  const tokens = tokenSet(market);
  if (tokens.has("crude") || tokens.has("oil") || tokens.has("wti") || tokens.has("cl")) {
    return true;
  }
  return (
    tokens.has("brent") &&
    (tokens.has("crude") || tokens.has("oil") || tokens.has("wti") || tokens.has("cl"))
  );
}

function scoreMarket(
  market: Record<string, unknown>,
  queryTokens: string[]
): number {
  const tokens = tokenSet(market);
  const queryHits = queryTokens.filter((token) => tokens.has(token)).length;
  const oilHits = [...SEARCH_TOKENS].filter((token) => tokens.has(token)).length;
  const isBrentCommodity =
    tokens.has("brent") &&
    (tokens.has("crude") || tokens.has("oil") || tokens.has("wti") || tokens.has("cl"));
  const activeBoost = market.active === true && market.closed === false ? 2 : 0;
  const volumeBoost = Math.min((toNumber(market.volume) ?? 0) / 100_000, 2);
  const liquidityBoost = Math.min((toNumber(market.liquidity) ?? 0) / 50_000, 2);
  return queryHits * 4 + oilHits * 3 + (isBrentCommodity ? 2 : 0) + activeBoost + volumeBoost + liquidityBoost;
}

async function fetchJson(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    next: { revalidate: DATA_REVALIDATE_SECONDS },
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Polymarket request failed (${response.status}) for ${path}.`);
  }

  return response.json();
}

function normalizeMarketMeta(rawMarket: Record<string, unknown>): MarketMeta {
  const clobTokenIds = parseStringArray(rawMarket.clobTokenIds);
  const outcomePrices = parseOutcomePrices(rawMarket.outcomePrices);
  const yesTokenId = clobTokenIds[0];
  if (!yesTokenId) {
    throw new Error("Market is missing YES token id.");
  }

  return {
    title: String(rawMarket.question || rawMarket.title || rawMarket.name || "Unknown market"),
    question: String(rawMarket.question || rawMarket.title || rawMarket.name || "Unknown market"),
    slug: String(rawMarket.slug || ""),
    endDate: rawMarket.endDate ? String(rawMarket.endDate) : null,
    active: rawMarket.active === true,
    closed: rawMarket.closed === true,
    conditionId: rawMarket.conditionId ? String(rawMarket.conditionId) : null,
    clobTokenIds,
    yesTokenId,
    noTokenId: clobTokenIds[1] ?? null,
    bestBid: null,
    bestAsk: null,
    marketPrice: outcomePrices[0] ?? null,
    midpoint: null,
    spread: null,
    lastTrade: null,
    displayProb: outcomePrices[0] ?? null,
    displaySource: outcomePrices[0] != null ? "marketPrice" : null,
    lastUpdatedTs: null,
    historySource: "delayed_window"
  };
}

function flattenEventMarkets(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const markets: Record<string, unknown>[] = [];
  for (const event of payload) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const eventRecord = event as Record<string, unknown>;
    const eventTitle = String(eventRecord.title || eventRecord.question || "");
    const eventMarkets = eventRecord.markets;
    if (!Array.isArray(eventMarkets)) {
      continue;
    }
    for (const market of eventMarkets) {
      if (!market || typeof market !== "object") {
        continue;
      }
      const copy = { ...(market as Record<string, unknown>) };
      if (!copy.eventTitle && eventTitle) {
        copy.eventTitle = eventTitle;
      }
      markets.push(copy);
    }
  }
  return markets;
}

export async function getMarketMetaBySlug(slug: string): Promise<MarketMeta> {
  const cleanSlug = slug.trim();
  if (!cleanSlug) {
    throw new Error("Market slug is empty.");
  }

  const payload = await fetchJson(POLY_GAMMA_BASE_URL, `/markets/slug/${cleanSlug}`);
  if (!payload || typeof payload !== "object") {
    throw new Error(`No market found for slug '${cleanSlug}'.`);
  }

  return normalizeMarketMeta(payload as Record<string, unknown>);
}

export async function searchOilChildMarkets(query: string): Promise<SearchResult[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return [];
  }

  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];

  const searchPayload = await fetchJson(
    POLY_GAMMA_BASE_URL,
    `/public-search?q=${encodeURIComponent(cleanQuery)}`
  );

  if (
    searchPayload &&
    typeof searchPayload === "object" &&
    Array.isArray((searchPayload as Record<string, unknown>).events)
  ) {
    for (const market of flattenEventMarkets(
      (searchPayload as Record<string, unknown>).events
    )) {
      const slug = String(market.slug || "");
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        merged.push(market);
      }
    }
  }

  const activeEvents = await fetchJson(
    POLY_GAMMA_BASE_URL,
    "/events?active=true&closed=false&limit=1000"
  );
  for (const market of flattenEventMarkets(activeEvents)) {
    const slug = String(market.slug || "");
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      merged.push(market);
    }
  }

  const oilResults = merged.filter(isOilRelevant);
  const queryTokens = cleanQuery.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const activeOpen = oilResults.filter(
    (market) => market.active === true && market.closed === false
  );
  const pool = activeOpen.length ? activeOpen : oilResults;

  return pool
    .sort((a, b) => scoreMarket(b, queryTokens) - scoreMarket(a, queryTokens))
    .slice(0, 12)
    .map((market) => ({
      title: String(market.question || market.title || market.name || "Unknown market"),
      slug: String(market.slug || ""),
      active: market.active === true,
      closed: market.closed === true,
      endDate: market.endDate ? String(market.endDate) : null
    }))
    .filter((result) => Boolean(result.slug));
}

export async function fetchPolyPriceHistory(params: {
  tokenId: string;
  startTimestampMs: number;
  endTimestampMs: number;
}): Promise<ProbabilityPoint[]> {
  const query = new URLSearchParams({
    market: params.tokenId,
    interval: HISTORY_INTERVAL,
    // Polymarket's `1m` interval currently rejects fidelity `1`; `10`
    // is the lowest accepted setting for dense intraday backfill.
    fidelity: String(HISTORY_FIDELITY_MINUTES),
    startTs: String(Math.floor(params.startTimestampMs / 1000)),
    endTs: String(Math.floor(params.endTimestampMs / 1000))
  });

  const payload = await fetchJson(
    POLY_CLOB_BASE_URL,
    `/prices-history?${query.toString()}`
  );

  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as Record<string, unknown>).history)
  ) {
    return [];
  }

  return ((payload as Record<string, unknown>).history as Array<Record<string, unknown>>)
    .map((point) => ({
      timestamp: (toNumber(point.t) ?? 0) * 1000,
      price: toNumber(point.p) ?? NaN,
      displaySource: "tradeHistory" as const,
      seededFrom: "clob_prices_history" as const
    }))
    .filter(
      (point) =>
        point.timestamp > 0 &&
        Number.isFinite(point.price) &&
        point.timestamp >= params.startTimestampMs &&
        point.timestamp <= params.endTimestampMs
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_OBSERVATIONS);
}

async function loadDelayedWindowDataUncached(
  slug: string,
  providerMode: BootstrapParams["providerMode"],
  manualCrudePrice: number | null
): Promise<DelayedWindowData> {
  const [market, crudeBundle] = await Promise.all([
    getMarketMetaBySlug(slug),
    fetchCrudeData({
      providerMode,
      manualValue: manualCrudePrice
    })
  ]);

  const fallbackWindowEndTs = Date.now();
  const fallbackWindowStartTs = fallbackWindowEndTs - 48 * 60 * 60 * 1000;
  const polyWindowStartTs = crudeBundle.windowStartTs ?? fallbackWindowStartTs;
  const polyWindowEndTs = crudeBundle.windowEndTs ?? fallbackWindowEndTs;
  const polyHistory = market.yesTokenId
    ? await fetchPolyPriceHistory({
        tokenId: market.yesTokenId,
        startTimestampMs: polyWindowStartTs,
        endTimestampMs: polyWindowEndTs
      })
    : [];

  return {
    market,
    crudeBundle,
    polyHistory
  };
}

const loadDelayedWindowDataCached = unstable_cache(
  async (
    slug: string,
    providerMode: BootstrapParams["providerMode"],
    manualCrudePrice: number | null
  ) => {
    const windowData = await loadDelayedWindowDataUncached(
      slug,
      providerMode,
      manualCrudePrice
    );

    if (
      providerMode === "databento_cl_c_0_1m" &&
      windowData.crudeBundle.history.length === 0
    ) {
      throw new Error("Delayed crude window unavailable.");
    }

    return windowData;
  },
  ["delayed-window-data"],
  { revalidate: DATA_REVALIDATE_SECONDS }
);

export async function buildBootstrapPayload(
  params: BootstrapParams
): Promise<BootstrapPayload> {
  let delayedWindowData: DelayedWindowData;
  try {
    delayedWindowData = await loadDelayedWindowDataCached(
      params.slug,
      params.providerMode,
      params.manualCrudePrice
    );
  } catch {
    delayedWindowData = await loadDelayedWindowDataUncached(
      params.slug,
      params.providerMode,
      params.manualCrudePrice
    );
  }

  const { market, crudeBundle, polyHistory } = delayedWindowData;
  const latestPolyProb = polyHistory.length ? polyHistory[polyHistory.length - 1].price : null;

  const hydratedMarket: MarketMeta = {
    ...market,
    bestBid: null,
    bestAsk: null,
    midpoint: null,
    spread: null,
    lastTrade: null,
    displayProb: latestPolyProb,
    displaySource: latestPolyProb !== null ? "tradeHistory" : null,
    lastUpdatedTs: polyHistory.length ? polyHistory[polyHistory.length - 1].timestamp : null,
    historySource: "delayed_window"
  };

  const observations = buildObservations({
    marketTicker: market.marketTicker || market.slug,
    marketSlug: market.slug,
    yesTokenId: market.yesTokenId ?? null,
    polyHistory,
    crudeHistory: crudeBundle.history,
    strike: params.strike,
    spreadWidth: params.spreadWidth,
    impliedVol: params.impliedVol,
    riskFreeRate: params.riskFreeRate,
    expiry: params.expiryOverride || market.endDate,
    rollingWindow: params.rollingWindow,
    fairGapThreshold: params.fairGapThreshold,
    deltaGapThreshold: params.deltaGapThreshold
  });

  const warnings = [...crudeBundle.warnings];
  const pairedObservationCount = observations.filter(
    (observation) => observation.crudePrice !== null
  ).length;
  const fairValueCount = observations.filter(
    (observation) => observation.fairProb !== null
  ).length;

  if (!polyHistory.length) {
    warnings.push("Polymarket delayed history is unavailable for the selected window.");
  }
  if (!warnings.length && pairedObservationCount === 0) {
    warnings.push("Paired delayed data still accumulating or unavailable.");
  } else if (!warnings.length && pairedObservationCount > 0 && fairValueCount === 0) {
    warnings.push(
      "Crude history loaded, but the current pricing inputs did not produce usable fair values."
    );
  }

  return {
    ok: true,
    mode: "delayed",
    market: hydratedMarket,
    providerMode: crudeBundle.providerMode,
    crudeLabel: crudeBundle.label,
    crudeSubLabel: crudeBundle.subLabel,
    crudeIsProxy: crudeBundle.isProxy,
    crudeCurrentPrice: crudeBundle.currentPrice,
    crudeHistory: crudeBundle.history,
    polyHistory,
    windowStartTs: crudeBundle.windowStartTs,
    windowEndTs: crudeBundle.windowEndTs,
    observations,
    warnings,
    generatedAt: new Date().toISOString()
  };
}

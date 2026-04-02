import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  recomputeObservationAnalytics
} from "@/lib/analytics";
import { callSpreadDelta, tightCallSpreadFairProb, yearFractionToExpiry } from "@/lib/pricing";
import type {
  MarketMeta,
  Observation,
  PolyDisplaySource,
  ReplayPayload
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");
const CURATED_PATH = path.join(process.cwd(), "data", "curated.json");

interface CuratedEntry {
  id: string;
  startTs?: string | null;
  endTs?: string | null;
}

interface RawObservation {
  recordedAt: number;
  marketTicker?: string | null;
  marketSlug?: string | null;
  yesTokenId?: string | null;
  polyDisplayMark?: number | null;
  polyDisplaySource?: string | null;
  crudePrice?: number | null;
}

interface SessionMetadata {
  sessionId: string;
  sessionStartedAt: string;
  pricingDefaults: {
    strike: number;
    spreadWidth: number;
    impliedVol: number;
    riskFreeRate: number;
    rollingWindow: number;
    fairGapThreshold: number;
    deltaGapThreshold: number;
    expiryOverride?: string | null;
  };
}

interface SessionSnapshot {
  market?: MarketMeta;
  crudeLabel?: string;
  crudeSubLabel?: string;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Keep one observation per bucket of bucketMs milliseconds (last-value). */
function bucketObservations(
  obs: RawObservation[],
  bucketMs: number
): RawObservation[] {
  if (obs.length === 0) return [];
  const buckets = new Map<number, RawObservation>();
  for (const o of obs) {
    const bucket = Math.floor(o.recordedAt / bucketMs) * bucketMs;
    buckets.set(bucket, o);
  }
  return Array.from(buckets.values()).sort((a, b) => a.recordedAt - b.recordedAt);
}

function toPolyDisplaySource(raw: string | null | undefined): PolyDisplaySource {
  if (raw === "lastTrade" || raw === "marketPrice" || raw === "tradeHistory") {
    return raw;
  }
  return "midpoint";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!/^\d{8}_\d{6}$/.test(id)) {
    return NextResponse.json(
      { ok: false, error: "Invalid session ID format" },
      { status: 400 }
    );
  }

  const sessionDir = path.join(SESSIONS_DIR, id);

  const [metadata, snapshot, rawContent, curated] = await Promise.all([
    readJsonFile<SessionMetadata>(path.join(sessionDir, "metadata.json")),
    readJsonFile<SessionSnapshot>(path.join(sessionDir, "snapshot.json")),
    readFile(path.join(sessionDir, "observations.jsonl"), "utf8").catch(() => null),
    readJsonFile<CuratedEntry[]>(CURATED_PATH)
  ]);

  const curatedEntry = curated?.find((c) => c.id === id) ?? null;
  const clipStartMs = curatedEntry?.startTs ? Date.parse(curatedEntry.startTs) : null;
  const clipEndMs = curatedEntry?.endTs ? Date.parse(curatedEntry.endTs) : null;

  if (!metadata || !rawContent) {
    return NextResponse.json(
      { ok: false, error: `Session "${id}" not found or incomplete` },
      { status: 404 }
    );
  }

  const pricing = metadata.pricingDefaults;
  const expiry: string | null =
    pricing.expiryOverride ||
    snapshot?.market?.endDate ||
    null;

  const rawLines = rawContent.split("\n").filter((l) => l.trim().length > 0);
  const rawObs: RawObservation[] = [];
  for (const line of rawLines) {
    try {
      rawObs.push(JSON.parse(line) as RawObservation);
    } catch {
      // skip malformed lines
    }
  }

  if (rawObs.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No observations in session" },
      { status: 404 }
    );
  }

  // Apply curated time window clip if set
  const clippedObs =
    clipStartMs !== null && clipEndMs !== null
      ? rawObs.filter((o) => o.recordedAt >= clipStartMs && o.recordedAt <= clipEndMs)
      : rawObs;

  // Bucket to 5-second windows to keep response size manageable
  const bucketed = bucketObservations(clippedObs, 5_000);
  const totalObservations = clippedObs.length;

  // Build Observation objects with fairProb + theoreticalDelta computed per record
  const partialObs: Observation[] = bucketed
    .filter((raw) => typeof raw.crudePrice === "number" && raw.crudePrice > 0)
    .map((raw) => {
      const crudePrice = raw.crudePrice as number;
      const polyProb =
        typeof raw.polyDisplayMark === "number" ? raw.polyDisplayMark : null;
      const timestamp = raw.recordedAt;

      let fairProb: number | null = null;
      let theoreticalDelta: number | null = null;

      if (
        polyProb !== null &&
        pricing.strike > 0 &&
        pricing.spreadWidth > 0
      ) {
        try {
          const T = yearFractionToExpiry(expiry, new Date(timestamp));
          fairProb = tightCallSpreadFairProb(
            crudePrice,
            pricing.strike,
            pricing.spreadWidth,
            T,
            pricing.riskFreeRate,
            pricing.impliedVol
          );
          theoreticalDelta = callSpreadDelta(
            crudePrice,
            pricing.strike,
            pricing.spreadWidth,
            T,
            pricing.riskFreeRate,
            pricing.impliedVol
          );
        } catch {
          fairProb = null;
          theoreticalDelta = null;
        }
      }

      return {
        timestamp,
        marketTicker: raw.marketTicker ?? raw.marketSlug ?? id,
        marketSlug: raw.marketSlug ?? raw.marketTicker ?? id,
        yesTokenId: raw.yesTokenId ?? null,
        crudePrice,
        polyProb,
        polyDisplaySource: toPolyDisplaySource(raw.polyDisplaySource),
        fairProb,
        fairValueGap: null,
        empiricalDeltaInst: null,
        empiricalDeltaRoll: null,
        theoreticalDelta,
        deltaGap: null,
        signal: "Neutral" as const
      };
    });

  // Apply rolling analytics (empiricalDelta, deltaGap, signal, fairValueGap)
  const enrichedObs = recomputeObservationAnalytics({
    observations: partialObs,
    rollingWindow: pricing.rollingWindow,
    fairGapThreshold: pricing.fairGapThreshold,
    deltaGapThreshold: pricing.deltaGapThreshold
  });

  // classifySignal requires both fairValueGap and deltaGap to be non-null.
  // For replay data, deltaGap is null until the rolling window warms up, so
  // we fall back to fairValueGap-only classification for those observations.
  const fairThreshold = pricing.fairGapThreshold;
  for (const obs of enrichedObs) {
    if (obs.signal === "Neutral" && obs.deltaGap === null && obs.fairValueGap !== null) {
      if (obs.fairValueGap > fairThreshold) {
        obs.signal = "Market rich";
      } else if (obs.fairValueGap < -fairThreshold) {
        obs.signal = "Market cheap";
      }
    }
  }

  const windowStartTs = enrichedObs[0]?.timestamp ?? 0;
  const windowEndTs = enrichedObs[enrichedObs.length - 1]?.timestamp ?? 0;

  const market: MarketMeta = snapshot?.market ?? {
    title: `Session ${id}`,
    question: `Session ${id}`,
    slug: id,
    marketTicker: null,
    endDate: expiry,
    active: false,
    closed: true,
    conditionId: null,
    clobTokenIds: [],
    yesTokenId: null,
    noTokenId: null,
    bestBid: null,
    bestAsk: null,
    marketPrice: null,
    midpoint: null,
    spread: null,
    lastTrade: null,
    displayProb: null,
    displaySource: null,
    lastUpdatedTs: null,
    historySource: null
  };

  const sessionDate = id.slice(0, 8);
  const formattedDate = `${sessionDate.slice(0, 4)}-${sessionDate.slice(4, 6)}-${sessionDate.slice(6, 8)}`;

  const payload: ReplayPayload = {
    ok: true,
    sessionId: id,
    sessionStartedAt: metadata.sessionStartedAt,
    market,
    pricingDefaults: {
      strike: pricing.strike,
      spreadWidth: pricing.spreadWidth,
      impliedVol: pricing.impliedVol,
      riskFreeRate: pricing.riskFreeRate,
      rollingWindow: pricing.rollingWindow,
      fairGapThreshold: pricing.fairGapThreshold,
      deltaGapThreshold: pricing.deltaGapThreshold
    },
    observations: enrichedObs,
    windowStartTs,
    windowEndTs,
    crudeLabel: snapshot?.crudeLabel ?? "CME CL.c.0 (Databento Live)",
    crudeSubLabel: `Historical recording — ${formattedDate}`,
    totalObservations
  };

  return NextResponse.json(payload);
}

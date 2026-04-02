#!/usr/bin/env node
/**
 * Build-time script: precomputes the default curated replay session and writes
 * it to public/replay/default-session.json so the frontend can fetch a static
 * file instead of hitting the API route on every cold visit.
 *
 * Run automatically as part of `npm run build`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ── Pricing math (mirrors lib/pricing.ts) ────────────────────────────────────

const EPSILON_T = 1e-6;
const EPSILON_S = 1e-6;

function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * value);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429;
  const erf = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t) * Math.exp(-value*value);
  return 0.5 * (1 + sign * erf);
}

function bsCallPrice(S, K, T, r, sigma) {
  if (S <= 0 || K <= 0) throw new Error("S and K must be positive.");
  if (T <= EPSILON_T || sigma <= 0) return Math.max(S - K, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
}

function tightCallSpreadFairProb(S, strike, width, T, r, sigma) {
  if (width <= 0) throw new Error("Spread width must be positive.");
  const k1 = strike - width / 2;
  const k2 = strike + width / 2;
  const c1 = bsCallPrice(S, k1, Math.max(T, EPSILON_T), r, sigma);
  const c2 = bsCallPrice(S, k2, Math.max(T, EPSILON_T), r, sigma);
  return Math.max(0, Math.min(1, (c1 - c2) / width));
}

function callSpreadDelta(S, strike, width, T, r, sigma, h = 0.01) {
  const sUp = Math.max(S + h, EPSILON_S);
  const sDn = Math.max(S - h, EPSILON_S);
  const pUp = tightCallSpreadFairProb(sUp, strike, width, T, r, sigma);
  const pDn = tightCallSpreadFairProb(sDn, strike, width, T, r, sigma);
  return (pUp - pDn) / (sUp - sDn);
}

function yearFractionToExpiry(expiry, now = new Date()) {
  if (!expiry) return EPSILON_T;
  const expiryDate = expiry instanceof Date ? expiry : new Date(expiry);
  if (Number.isNaN(expiryDate.getTime())) return EPSILON_T;
  return Math.max((expiryDate.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000), EPSILON_T);
}

// ── Analytics (mirrors lib/analytics.ts) ─────────────────────────────────────

const EPSILON = 1e-12;

function instantaneousDelta(prevProb, prevPrice, currProb, currPrice) {
  if (prevProb === null || prevPrice === null || currProb === null || currPrice === null) return null;
  const dPrice = currPrice - prevPrice;
  if (Math.abs(dPrice) < EPSILON) return null;
  return (currProb - prevProb) / dPrice;
}

function rollingRegressionSlope(xSeries, ySeries) {
  const points = xSeries
    .map((x, i) => ({ x, y: ySeries[i] ?? null }))
    .filter((p) => p.x !== null && p.y !== null && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length < 2) return null;
  const xMean = points.reduce((s, p) => s + p.x, 0) / points.length;
  const yMean = points.reduce((s, p) => s + p.y, 0) / points.length;
  let num = 0, den = 0;
  for (const p of points) {
    const xd = p.x - xMean;
    num += xd * (p.y - yMean);
    den += xd * xd;
  }
  return Math.abs(den) < EPSILON ? null : num / den;
}

function classifySignal(fairGap, deltaGap, fairGapThreshold, deltaGapThreshold) {
  if (fairGap === null || deltaGap === null) return "Neutral";
  if (fairGap > fairGapThreshold && deltaGap > deltaGapThreshold) return "Market rich";
  if (fairGap < -fairGapThreshold && deltaGap < -deltaGapThreshold) return "Market cheap";
  return "Neutral";
}

function recomputeObservationAnalytics(observations, rollingWindow, fairGapThreshold, deltaGapThreshold) {
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  return sorted.map((obs, index) => {
    const prev = index > 0 ? sorted[index - 1] : null;
    const empiricalDeltaInst = prev
      ? instantaneousDelta(prev.polyProb, prev.crudePrice, obs.polyProb, obs.crudePrice)
      : null;
    const start = Math.max(0, index - rollingWindow + 1);
    const window = sorted.slice(start, index + 1);
    const empiricalDeltaRoll = rollingRegressionSlope(
      window.map((p) => p.crudePrice),
      window.map((p) => p.polyProb)
    );
    const fairValueGap = (obs.polyProb !== null && obs.fairProb !== null)
      ? obs.polyProb - obs.fairProb : null;
    const deltaGap = (empiricalDeltaRoll !== null && obs.theoreticalDelta !== null)
      ? empiricalDeltaRoll - obs.theoreticalDelta : null;
    const signal = classifySignal(fairValueGap, deltaGap, fairGapThreshold, deltaGapThreshold);
    return { ...obs, fairValueGap, empiricalDeltaInst, empiricalDeltaRoll, deltaGap, signal };
  });
}

// ── Session processing (mirrors app/api/sessions/[id]/route.ts) ───────────────

function bucketObservations(obs, bucketMs) {
  if (obs.length === 0) return [];
  const buckets = new Map();
  for (const o of obs) {
    const bucket = Math.floor(o.recordedAt / bucketMs) * bucketMs;
    buckets.set(bucket, o);
  }
  return Array.from(buckets.values()).sort((a, b) => a.recordedAt - b.recordedAt);
}

function toPolyDisplaySource(raw) {
  if (raw === "lastTrade" || raw === "marketPrice" || raw === "tradeHistory") return raw;
  return "midpoint";
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function buildPayload(curatedEntry) {
  const { id, startTs, endTs, animationStartTs } = curatedEntry;
  const sessionDir = path.join(ROOT, "data", "sessions", id);

  const [metadata, snapshot, rawContent] = await Promise.all([
    readJson(path.join(sessionDir, "metadata.json")),
    readJson(path.join(sessionDir, "snapshot.json")),
    readFile(path.join(sessionDir, "observations.jsonl"), "utf8").catch(() => null)
  ]);

  if (!metadata || !rawContent) throw new Error(`Session ${id}: missing metadata or observations`);

  const pricing = metadata.pricingDefaults;
  const expiry = pricing.expiryOverride || snapshot?.market?.endDate || null;

  const rawObs = rawContent
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  if (rawObs.length === 0) throw new Error(`Session ${id}: no observations`);

  const clipStartMs = startTs ? Date.parse(startTs) : null;
  const clipEndMs   = endTs   ? Date.parse(endTs)   : null;
  const animStartMs = animationStartTs ? Date.parse(animationStartTs) : null;

  const clippedObs = (clipStartMs !== null && clipEndMs !== null)
    ? rawObs.filter((o) => o.recordedAt >= clipStartMs && o.recordedAt <= clipEndMs)
    : rawObs;

  const bucketed = bucketObservations(clippedObs, 5_000);
  const totalObservations = clippedObs.length;

  const partialObs = bucketed
    .filter((raw) => typeof raw.crudePrice === "number" && raw.crudePrice > 0)
    .map((raw) => {
      const crudePrice = raw.crudePrice;
      const polyProb = typeof raw.polyDisplayMark === "number" ? raw.polyDisplayMark : null;
      const timestamp = raw.recordedAt;
      let fairProb = null, theoreticalDelta = null;
      if (polyProb !== null && pricing.strike > 0 && pricing.spreadWidth > 0) {
        try {
          const T = yearFractionToExpiry(expiry, new Date(timestamp));
          fairProb = tightCallSpreadFairProb(crudePrice, pricing.strike, pricing.spreadWidth, T, pricing.riskFreeRate, pricing.impliedVol);
          theoreticalDelta = callSpreadDelta(crudePrice, pricing.strike, pricing.spreadWidth, T, pricing.riskFreeRate, pricing.impliedVol);
        } catch { /* leave null */ }
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
        signal: "Neutral"
      };
    });

  const enrichedObs = recomputeObservationAnalytics(
    partialObs,
    pricing.rollingWindow,
    pricing.fairGapThreshold,
    pricing.deltaGapThreshold
  );

  // Fair-value-only fallback for early observations before rolling window warms up
  for (const obs of enrichedObs) {
    if (obs.signal === "Neutral" && obs.deltaGap === null && obs.fairValueGap !== null) {
      if (obs.fairValueGap > pricing.fairGapThreshold) obs.signal = "Market rich";
      else if (obs.fairValueGap < -pricing.fairGapThreshold) obs.signal = "Market cheap";
    }
  }

  const windowStartTs = enrichedObs[0]?.timestamp ?? 0;
  const windowEndTs   = enrichedObs[enrichedObs.length - 1]?.timestamp ?? 0;

  const animationStartIndex = animStartMs !== null
    ? Math.max(0, enrichedObs.findIndex((o) => o.timestamp >= animStartMs))
    : null;

  const market = snapshot?.market ?? {
    title: `Session ${id}`, question: `Session ${id}`, slug: id,
    marketTicker: null, endDate: expiry, active: false, closed: true,
    conditionId: null, clobTokenIds: [], yesTokenId: null, noTokenId: null,
    bestBid: null, bestAsk: null, marketPrice: null, midpoint: null,
    spread: null, lastTrade: null, displayProb: null, displaySource: null,
    lastUpdatedTs: null, historySource: null
  };

  const sessionDate = id.slice(0, 8);
  const formattedDate = `${sessionDate.slice(0,4)}-${sessionDate.slice(4,6)}-${sessionDate.slice(6,8)}`;

  return {
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
    totalObservations,
    animationStartIndex
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const curated = await readJson(path.join(ROOT, "data", "curated.json"));
  if (!curated) throw new Error("data/curated.json not found");

  const defaultEntry = curated.find((c) => c.default === true);
  if (!defaultEntry) throw new Error("No default entry found in curated.json");

  // Skip gracefully if session data doesn't exist (local dev without VM data)
  const sessionDir = path.join(ROOT, "data", "sessions", defaultEntry.id);
  const metaExists = await readJson(path.join(sessionDir, "metadata.json"));
  if (!metaExists) {
    console.log(`[precompute] SKIP — session ${defaultEntry.id} not present locally. Static file will not be updated.`);
    return;
  }

  console.log(`[precompute] Building default session: ${defaultEntry.id} (${defaultEntry.label})`);

  const payload = await buildPayload(defaultEntry);

  const outDir = path.join(ROOT, "public", "replay");
  await mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, "default-session.json");
  await writeFile(outPath, JSON.stringify(payload), "utf8");

  console.log(
    `[precompute] Written ${payload.observations.length} observations → public/replay/default-session.json` +
    (payload.animationStartIndex !== null ? ` (animationStartIndex=${payload.animationStartIndex})` : "")
  );
}

main().catch((err) => {
  console.error("[precompute] FAILED:", err.message);
  process.exit(1);
});

import { MAX_OBSERVATIONS } from "@/lib/constants";
import { callSpreadDelta, tightCallSpreadFairProb, yearFractionToExpiry } from "@/lib/pricing";
import type {
  CrudePoint,
  Observation,
  ProbabilityPoint,
  SignalState
} from "@/lib/types";

const EPSILON = 1e-12;

interface BuildObservationsArgs {
  marketTicker: string;
  marketSlug?: string | null;
  yesTokenId?: string | null;
  polyHistory: ProbabilityPoint[];
  crudeHistory: CrudePoint[];
  strike: number;
  spreadWidth: number;
  impliedVol: number;
  riskFreeRate: number;
  expiry: string | null;
  rollingWindow: number;
  fairGapThreshold: number;
  deltaGapThreshold: number;
}

interface RecomputeArgs {
  observations: Observation[];
  rollingWindow: number;
  fairGapThreshold: number;
  deltaGapThreshold: number;
}

export function instantaneousDelta(
  prevProb: number | null,
  prevPrice: number | null,
  currProb: number | null,
  currPrice: number | null
): number | null {
  if (
    prevProb === null ||
    prevPrice === null ||
    currProb === null ||
    currPrice === null
  ) {
    return null;
  }

  const dPrice = currPrice - prevPrice;
  if (Math.abs(dPrice) < EPSILON) {
    return null;
  }

  return (currProb - prevProb) / dPrice;
}

export function rollingRegressionSlope(
  xSeries: Array<number | null>,
  ySeries: Array<number | null>
): number | null {
  const points = xSeries
    .map((x, idx) => ({ x, y: ySeries[idx] ?? null }))
    .filter(
      (point): point is { x: number; y: number } =>
        point.x !== null &&
        point.y !== null &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
    );

  if (points.length < 2) {
    return null;
  }

  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const xDiff = point.x - xMean;
    numerator += xDiff * (point.y - yMean);
    denominator += xDiff * xDiff;
  }

  if (Math.abs(denominator) < EPSILON) {
    return null;
  }

  return numerator / denominator;
}

export function computeFairValueGap(
  polyProb: number | null,
  fairProb: number | null
): number | null {
  if (polyProb === null || fairProb === null) {
    return null;
  }

  return polyProb - fairProb;
}

export function computeDeltaGap(
  empiricalDelta: number | null,
  theoreticalDelta: number | null
): number | null {
  if (empiricalDelta === null || theoreticalDelta === null) {
    return null;
  }

  return empiricalDelta - theoreticalDelta;
}

export function classifySignal(
  fairGap: number | null,
  deltaGap: number | null,
  fairGapThreshold: number,
  deltaGapThreshold: number
): SignalState {
  if (fairGap === null || deltaGap === null) {
    return "Neutral";
  }

  if (fairGap > fairGapThreshold && deltaGap > deltaGapThreshold) {
    return "Market rich";
  }

  if (fairGap < -fairGapThreshold && deltaGap < -deltaGapThreshold) {
    return "Market cheap";
  }

  return "Neutral";
}

export function nearestCrudePriceAtOrBefore(
  timestamp: number,
  crudeHistory: CrudePoint[]
): number | null {
  let candidate: number | null = null;
  for (const point of crudeHistory) {
    if (point.timestamp <= timestamp) {
      candidate = point.price;
    } else {
      break;
    }
  }
  return candidate;
}

function hydrateObservationValues(
  observation: Observation,
  strike: number,
  spreadWidth: number,
  impliedVol: number,
  riskFreeRate: number,
  expiry: string | null
): Observation {
  if (
    observation.crudePrice === null ||
    !Number.isFinite(observation.crudePrice) ||
    observation.crudePrice <= 0 ||
    strike <= 0 ||
    spreadWidth <= 0
  ) {
    return {
      ...observation,
      fairProb: null,
      theoreticalDelta: null
    };
  }

  try {
    const T = yearFractionToExpiry(expiry, new Date(observation.timestamp));
    const fairProb = tightCallSpreadFairProb(
      observation.crudePrice,
      strike,
      spreadWidth,
      T,
      riskFreeRate,
      impliedVol
    );
    const theoreticalDelta = callSpreadDelta(
      observation.crudePrice,
      strike,
      spreadWidth,
      T,
      riskFreeRate,
      impliedVol
    );

    return {
      ...observation,
      fairProb,
      theoreticalDelta
    };
  } catch {
    return {
      ...observation,
      fairProb: null,
      theoreticalDelta: null
    };
  }
}

function dedupeAndCapObservations(observations: Observation[]): Observation[] {
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  const deduped: Observation[] = [];

  for (const observation of sorted) {
    const last = deduped[deduped.length - 1];
    if (
      last &&
      Math.abs(last.timestamp - observation.timestamp) < 1_000 &&
      last.polyProb === observation.polyProb &&
      last.crudePrice === observation.crudePrice
    ) {
      deduped[deduped.length - 1] = observation;
      continue;
    }
    deduped.push(observation);
  }

  return deduped.slice(-MAX_OBSERVATIONS);
}

export function recomputeObservationAnalytics({
  observations,
  rollingWindow,
  fairGapThreshold,
  deltaGapThreshold
}: RecomputeArgs): Observation[] {
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);

  return sorted.map((observation, index) => {
    const previous = index > 0 ? sorted[index - 1] : null;
    const empiricalDeltaInst = previous
      ? instantaneousDelta(
          previous.polyProb,
          previous.crudePrice,
          observation.polyProb,
          observation.crudePrice
        )
      : null;

    const start = Math.max(0, index - rollingWindow + 1);
    const window = sorted.slice(start, index + 1);
    const empiricalDeltaRoll = rollingRegressionSlope(
      window.map((point) => point.crudePrice),
      window.map((point) => point.polyProb)
    );

    const fairValueGap = computeFairValueGap(observation.polyProb, observation.fairProb);
    const deltaGap = computeDeltaGap(empiricalDeltaRoll, observation.theoreticalDelta);
    const signal = classifySignal(
      fairValueGap,
      deltaGap,
      fairGapThreshold,
      deltaGapThreshold
    );

    return {
      ...observation,
      fairValueGap,
      empiricalDeltaInst,
      empiricalDeltaRoll,
      deltaGap,
      signal
    };
  });
}

export function buildObservations(args: BuildObservationsArgs): Observation[] {
  const historySeeds: Observation[] = args.polyHistory.map((point) =>
    hydrateObservationValues(
      {
        timestamp: point.timestamp,
        marketTicker: args.marketTicker,
        marketSlug: args.marketSlug ?? args.marketTicker,
        yesTokenId: args.yesTokenId ?? null,
        crudePrice: nearestCrudePriceAtOrBefore(point.timestamp, args.crudeHistory),
        polyProb: point.price,
        polyDisplaySource: point.displaySource ?? "tradeHistory",
        fairProb: null,
        fairValueGap: null,
        empiricalDeltaInst: null,
        empiricalDeltaRoll: null,
        theoreticalDelta: null,
        deltaGap: null,
        signal: "Neutral"
      },
      args.strike,
      args.spreadWidth,
      args.impliedVol,
      args.riskFreeRate,
      args.expiry
    )
  );

  const deduped = dedupeAndCapObservations(historySeeds);
  return recomputeObservationAnalytics({
    observations: deduped,
    rollingWindow: args.rollingWindow,
    fairGapThreshold: args.fairGapThreshold,
    deltaGapThreshold: args.deltaGapThreshold
  });
}

export function computeScatterStats(observations: Observation[]): {
  polySlope: number | null;
  theoSlope: number | null;
  ratio: number | null;
} {
  const paired = observations.filter(
    (observation) =>
      observation.crudePrice !== null &&
      observation.polyProb !== null &&
      observation.fairProb !== null
  );

  const polySlope = rollingRegressionSlope(
    paired.map((point) => point.crudePrice),
    paired.map((point) => point.polyProb)
  );
  const theoSlope = rollingRegressionSlope(
    paired.map((point) => point.crudePrice),
    paired.map((point) => point.fairProb)
  );

  return {
    polySlope,
    theoSlope,
    ratio:
      polySlope !== null &&
      theoSlope !== null &&
      Math.abs(theoSlope) > EPSILON
        ? polySlope / theoSlope
        : null
  };
}

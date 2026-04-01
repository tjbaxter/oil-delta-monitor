import { NextResponse } from "next/server";

import {
  BROWSER_CACHE_MAX_AGE_SECONDS,
  DATA_REVALIDATE_SECONDS,
  DEFAULT_DELTA_GAP_THRESHOLD,
  DEFAULT_FAIR_GAP_THRESHOLD,
  DEFAULT_IMPLIED_VOL,
  DEFAULT_MARKET_SLUG,
  DEFAULT_RISK_FREE_RATE,
  DEFAULT_ROLLING_WINDOW,
  DEFAULT_SPREAD_WIDTH,
  DEFAULT_STRIKE
} from "@/lib/constants";
import { getDefaultProviderMode } from "@/lib/crude";
import { buildBootstrapPayload } from "@/lib/polymarket";
import type { ApiErrorPayload } from "@/lib/types";

export const revalidate = 300;
export const maxDuration = 60;

const BOOTSTRAP_CACHE_CONTROL = `public, max-age=${BROWSER_CACHE_MAX_AGE_SECONDS}, s-maxage=${DATA_REVALIDATE_SECONDS}, stale-while-revalidate=${DATA_REVALIDATE_SECONDS}`;

function parseNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim() || DEFAULT_MARKET_SLUG;

  if (!slug) {
    const payload: ApiErrorPayload = {
      ok: false,
      code: "MISSING_SLUG",
      error: "Missing market slug."
    };
    return NextResponse.json(payload, { status: 400 });
  }

  try {
    const payload = await buildBootstrapPayload({
      slug,
      providerMode: getDefaultProviderMode(),
      manualCrudePrice: null,
      strike: parseNumber(url.searchParams.get("strike"), DEFAULT_STRIKE),
      spreadWidth: parseNumber(url.searchParams.get("spreadWidth"), DEFAULT_SPREAD_WIDTH),
      impliedVol: parseNumber(url.searchParams.get("impliedVol"), DEFAULT_IMPLIED_VOL),
      riskFreeRate: parseNumber(url.searchParams.get("riskFreeRate"), DEFAULT_RISK_FREE_RATE),
      rollingWindow: parseNumber(url.searchParams.get("rollingWindow"), DEFAULT_ROLLING_WINDOW),
      fairGapThreshold: parseNumber(
        url.searchParams.get("fairGapThreshold"),
        DEFAULT_FAIR_GAP_THRESHOLD
      ),
      deltaGapThreshold: parseNumber(
        url.searchParams.get("deltaGapThreshold"),
        DEFAULT_DELTA_GAP_THRESHOLD
      ),
      expiryOverride: url.searchParams.get("expiryOverride")
    });

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": BOOTSTRAP_CACHE_CONTROL
      }
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Bootstrap failed.";
    const payload: ApiErrorPayload = {
      ok: false,
      code: "BOOTSTRAP_FAILED",
      error: message
    };

    const status = message.toLowerCase().includes("no market found") ? 404 : 500;
    return NextResponse.json(payload, {
      status,
      headers: {
        "Cache-Control": BOOTSTRAP_CACHE_CONTROL
      }
    });
  }
}

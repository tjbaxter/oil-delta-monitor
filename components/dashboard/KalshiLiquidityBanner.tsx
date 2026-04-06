"use client";

import { useMemo } from "react";
import type { KalshiLiquidity } from "@/lib/types";

interface Props {
  liquidity: KalshiLiquidity | null | undefined;
  snapshotAgeMs: number | null;
}

function minutesAgo(isoUtc: string | null): number | null {
  if (!isoUtc) return null;
  const diffMs = Date.now() - new Date(isoUtc).getTime();
  return Math.floor(diffMs / 60_000);
}

export default function KalshiLiquidityBanner({ liquidity, snapshotAgeMs }: Props) {
  const message = useMemo(() => {
    if (!liquidity) return null;

    // Edge case: ingestor hasn't written snapshot in >90s — defer to staleness pill
    if (snapshotAgeMs !== null && snapshotAgeMs > 90_000) return null;

    if (liquidity.status === "normal") return null;

    if (liquidity.status === "closed") {
      return {
        icon: "●",
        text: "No active Kalshi WTI contract right now — daily binaries trade 10:00 AM – 2:30 PM ET, Mon–Fri. The orange fair value line continues tracking CL futures via Black-Scholes.",
      };
    }

    // "low"
    const mins = minutesAgo(liquidity.lastMeaningfulChangeUtc);
    const suffix =
      mins !== null && mins > 15
        ? ` Last price movement: ${mins} min ago.`
        : "";
    return {
      icon: "●",
      text: `Kalshi liquidity is thin right now — the teal line will appear flat until order flow picks up. Check back during active hours (10 AM – 2:30 PM ET).${suffix}`,
    };
  }, [liquidity, snapshotAgeMs]);

  if (!message) return null;

  return (
    <div className="kalshi-liquidity-banner" role="status" aria-live="polite">
      <span className="kalshi-liquidity-banner__dot">{message.icon}</span>
      <span className="kalshi-liquidity-banner__text">{message.text}</span>
    </div>
  );
}

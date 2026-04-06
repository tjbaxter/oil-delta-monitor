"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const outerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  const message = useMemo(() => {
    if (!liquidity) return null;
    if (snapshotAgeMs !== null && snapshotAgeMs > 90_000) return null;
    if (liquidity.status === "normal") return null;

    if (liquidity.status === "closed") {
      return {
        icon: "●",
        text: "No active Kalshi WTI contract right now — daily binaries trade 10:00 AM – 2:30 PM ET, Mon–Fri. The orange fair value line continues tracking CL futures via Black-Scholes.",
      };
    }

    const mins = minutesAgo(liquidity.lastMeaningfulChangeUtc);
    const suffix =
      mins !== null && mins > 15 ? ` Last price movement: ${mins} min ago.` : "";
    return {
      icon: "●",
      text: `Kalshi liquidity is thin right now — the teal line will appear flat until order flow picks up. Check back during active hours (10 AM – 2:30 PM ET).${suffix}`,
    };
  }, [liquidity, snapshotAgeMs]);

  // Measure overflow so the scroll is exactly as far as needed, no more.
  useEffect(() => {
    if (!textRef.current || !outerRef.current) {
      setScrollDistance(0);
      return;
    }
    const overflow = textRef.current.scrollWidth - outerRef.current.clientWidth;
    setScrollDistance(Math.max(0, overflow));
  }, [message?.text]);

  if (!message) return null;

  // Duration scales with scroll distance so short text scrolls slowly,
  // long text doesn't race. 8s minimum, ~1px per 25ms thereafter.
  const durationS = scrollDistance > 0 ? Math.max(8, scrollDistance / 25) : 0;

  const textStyle: React.CSSProperties =
    scrollDistance > 0
      ? ({
          "--scroll-distance": `-${scrollDistance}px`,
          "--scroll-duration": `${durationS}s`,
          animation: `kalshi-banner-scroll var(--scroll-duration) ease-in-out infinite alternate`,
        } as React.CSSProperties)
      : {};

  return (
    <div className="kalshi-liquidity-banner" role="status" aria-live="polite">
      <span className="kalshi-liquidity-banner__dot">{message.icon}</span>
      <span className="kalshi-liquidity-banner__text-outer" ref={outerRef}>
        <span
          className="kalshi-liquidity-banner__text"
          ref={textRef}
          style={textStyle}
        >
          {message.text}
        </span>
      </span>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

interface MarketStateBannerProps {
  lastKalshiUpdateTs: number | null;
  isLiveMode: boolean;
}

const STALE_THRESHOLD_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 15_000;

export default function MarketStateBanner({
  lastKalshiUpdateTs,
  isLiveMode
}: MarketStateBannerProps) {
  const [isStale, setIsStale] = useState(false);
  const lastTsRef = useRef(lastKalshiUpdateTs);

  useEffect(() => {
    lastTsRef.current = lastKalshiUpdateTs;
  }, [lastKalshiUpdateTs]);

  useEffect(() => {
    if (!isLiveMode) {
      setIsStale(false);
      return;
    }

    const check = () => {
      const ts = lastTsRef.current;
      if (ts === null) {
        setIsStale(false);
        return;
      }
      setIsStale(Date.now() - ts > STALE_THRESHOLD_MS);
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isLiveMode]);

  if (!isStale || !isLiveMode) {
    return null;
  }

  return (
    <div className="market-state-banner">
      <span className="market-state-banner-icon">◌</span>
      Kalshi price unchanged — low liquidity or quiet market. Check back during
      active US trading hours (9:00–16:00 ET).
    </div>
  );
}

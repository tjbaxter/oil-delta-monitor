"use client";

import { useEffect, useRef, useState } from "react";

import type { CMEStatus } from "@/lib/cmeCalendar";

interface MarketStateBannerProps {
  lastKalshiUpdateTs: number | null;
  isLiveMode: boolean;
  crudeFeedState: string | null;
  kalshiProb: number | null;
  cmeStatus: CMEStatus;
  onSwitchToReplay?: () => void;
}

const KALSHI_STALE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 30_000;

type BannerKind = "cme-closed" | "kalshi-quiet" | "kalshi-otm" | null;

interface BannerState {
  kind: BannerKind;
  text: string;
  reopens: string | null;
}

function computeBanner(
  isLiveMode: boolean,
  crudeFeedState: string | null,
  lastKalshiUpdateTs: number | null,
  kalshiProb: number | null,
  cmeStatus: CMEStatus,
  now: number
): BannerState {
  if (!isLiveMode) return { kind: null, text: "", reopens: null };

  const crudeIsStale = crudeFeedState !== "connected" && crudeFeedState !== null;
  const kalshiIsStale =
    lastKalshiUpdateTs !== null && now - lastKalshiUpdateTs > KALSHI_STALE_MS;

  if (!cmeStatus.isOpen && crudeIsStale) {
    return {
      kind: "cme-closed",
      text: cmeStatus.reason,
      reopens: cmeStatus.reopens
    };
  }

  if (crudeIsStale || !kalshiIsStale) return { kind: null, text: "", reopens: null };

  if (kalshiProb !== null && (kalshiProb < 0.10 || kalshiProb > 0.90)) {
    const direction = kalshiProb < 0.10 ? "deep out-of-the-money" : "deep in-the-money";
    return {
      kind: "kalshi-otm",
      text: `Kalshi contract is ${direction} (${Math.round(kalshiProb * 100)}¢) — limited trading activity at this probability. Fair value comparison is less meaningful far from 50%.`,
      reopens: null
    };
  }

  return {
    kind: "kalshi-quiet",
    text: "Kalshi WTI contract is quiet — no recent quote updates. Kalshi binary markets are typically most active during US hours (9 AM – 4 PM ET). The model continues tracking CL fair value.",
    reopens: null
  };
}

export default function MarketStateBanner({
  lastKalshiUpdateTs,
  isLiveMode,
  crudeFeedState,
  kalshiProb,
  cmeStatus,
  onSwitchToReplay
}: MarketStateBannerProps) {
  const [banner, setBanner] = useState<BannerState>({ kind: null, text: "", reopens: null });

  const lastKalshiRef = useRef(lastKalshiUpdateTs);
  const crudeFeedRef = useRef(crudeFeedState);
  const kalshiProbRef = useRef(kalshiProb);
  const cmeStatusRef = useRef(cmeStatus);

  useEffect(() => { lastKalshiRef.current = lastKalshiUpdateTs; }, [lastKalshiUpdateTs]);
  useEffect(() => { crudeFeedRef.current = crudeFeedState; }, [crudeFeedState]);
  useEffect(() => { kalshiProbRef.current = kalshiProb; }, [kalshiProb]);
  useEffect(() => { cmeStatusRef.current = cmeStatus; }, [cmeStatus]);

  useEffect(() => {
    if (!isLiveMode) {
      setBanner({ kind: null, text: "", reopens: null });
      return;
    }
    const check = () => {
      setBanner(computeBanner(isLiveMode, crudeFeedRef.current, lastKalshiRef.current, kalshiProbRef.current, cmeStatusRef.current, Date.now()));
    };
    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isLiveMode]);

  useEffect(() => {
    if (isLiveMode) {
      setBanner(computeBanner(isLiveMode, crudeFeedState, lastKalshiUpdateTs, kalshiProb, cmeStatus, Date.now()));
    }
  }, [isLiveMode, crudeFeedState, lastKalshiUpdateTs, kalshiProb, cmeStatus]);

  if (!banner.kind || !isLiveMode) return null;

  if (banner.kind === "cme-closed") {
    return (
      <div className="market-state-banner market-state-banner--closed">
        <div className="market-state-banner-body">
          <span className="market-state-banner-icon">🗓</span>
          <div className="market-state-banner-content">
            <span className="market-state-banner-headline">{banner.text}</span>
            {banner.reopens ? (
              <span className="market-state-banner-sub">
                Live data resumes {banner.reopens}.
              </span>
            ) : null}
          </div>
        </div>
        {onSwitchToReplay ? (
          <button
            className="market-state-banner-cta"
            onClick={onSwitchToReplay}
            type="button"
          >
            View Replay →
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="market-state-banner">
      <span className="market-state-banner-icon">◌</span>
      {banner.text}
    </div>
  );
}

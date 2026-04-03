"use client";

import { useEffect, useRef, useState } from "react";

import { getCMEStatus } from "@/lib/cmeCalendar";

interface MarketStateBannerProps {
  lastKalshiUpdateTs: number | null;
  isLiveMode: boolean;
  crudeFeedState: string | null;
  kalshiProb: number | null;
}

const KALSHI_STALE_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 30_000;

type BannerMessage = {
  icon: string;
  text: string;
} | null;

function buildMessage(
  isLiveMode: boolean,
  crudeFeedState: string | null,
  lastKalshiUpdateTs: number | null,
  kalshiProb: number | null,
  now: number
): BannerMessage {
  if (!isLiveMode) return null;

  const cmeStatus = getCMEStatus(new Date(now));
  const crudeIsStale = crudeFeedState !== "connected" && crudeFeedState !== null;
  const kalshiIsStale =
    lastKalshiUpdateTs !== null && now - lastKalshiUpdateTs > KALSHI_STALE_MS;

  // CME closed (holiday or weekend or maintenance) — this explains everything
  if (!cmeStatus.isOpen && crudeIsStale) {
    const reopensNote = cmeStatus.reopens ? ` Resumes ${cmeStatus.reopens}.` : "";
    return {
      icon: "🗓",
      text: `${cmeStatus.reason}.${reopensNote} Switch to Replay to see the dashboard in action.`
    };
  }

  // CME is open but CL feed stale — don't repeat info already in the pause banner
  // Just surface Kalshi-specific context if relevant.
  if (crudeIsStale) return null;

  // CME open, CL live — check Kalshi staleness
  if (!kalshiIsStale) return null;

  // Kalshi deep out-of/in-the-money: nobody trading the contract
  if (kalshiProb !== null && (kalshiProb < 0.10 || kalshiProb > 0.90)) {
    const direction = kalshiProb < 0.10 ? "deep out-of-the-money" : "deep in-the-money";
    return {
      icon: "◌",
      text: `Kalshi contract is ${direction} (${Math.round(kalshiProb * 100)}¢) — limited trading activity at this probability. Fair value comparison is less meaningful far from 50%.`
    };
  }

  // Kalshi quiet during normal hours
  return {
    icon: "◌",
    text: "Kalshi WTI contract is quiet — no recent quote updates. Kalshi binary markets are typically most active during US hours (9 AM – 4 PM ET). The model continues tracking CL fair value."
  };
}

export default function MarketStateBanner({
  lastKalshiUpdateTs,
  isLiveMode,
  crudeFeedState,
  kalshiProb
}: MarketStateBannerProps) {
  const [message, setMessage] = useState<BannerMessage>(null);
  const lastKalshiRef = useRef(lastKalshiUpdateTs);
  const crudeFeedRef = useRef(crudeFeedState);
  const kalshiProbRef = useRef(kalshiProb);

  useEffect(() => { lastKalshiRef.current = lastKalshiUpdateTs; }, [lastKalshiUpdateTs]);
  useEffect(() => { crudeFeedRef.current = crudeFeedState; }, [crudeFeedState]);
  useEffect(() => { kalshiProbRef.current = kalshiProb; }, [kalshiProb]);

  useEffect(() => {
    if (!isLiveMode) {
      setMessage(null);
      return;
    }

    const check = () => {
      setMessage(
        buildMessage(isLiveMode, crudeFeedRef.current, lastKalshiRef.current, kalshiProbRef.current, Date.now())
      );
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isLiveMode]);

  // Also re-evaluate immediately when key props change
  useEffect(() => {
    if (isLiveMode) {
      setMessage(
        buildMessage(isLiveMode, crudeFeedState, lastKalshiUpdateTs, kalshiProb, Date.now())
      );
    }
  }, [isLiveMode, crudeFeedState, lastKalshiUpdateTs, kalshiProb]);

  if (!message || !isLiveMode) return null;

  return (
    <div className="market-state-banner">
      <span className="market-state-banner-icon">{message.icon}</span>
      {message.text}
    </div>
  );
}

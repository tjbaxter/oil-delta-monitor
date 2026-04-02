"use client";

import { useEffect, useRef, useState } from "react";
import {
  DASHBOARD_SUBTITLE,
  DASHBOARD_TITLE,
  LIVE_DASHBOARD_SUBTITLE
} from "@/lib/constants";
import { formatUtcTime } from "@/lib/format";
import type { PolyDisplaySource, SnapshotMode, SourceStatus } from "@/lib/types";

interface HeaderStripProps {
  mode: SnapshotMode;
  selectedInstrument: string;
  marketVenueLabel: string;
  marketUrl: string | null;
  windowEndTimestamp: number | null;
  generatedAt: string | null;
  marketDisplaySource: PolyDisplaySource | null;
  lastUpdatedTs: number | null;
  sourceStatus: SourceStatus | null;
  presentationMode: boolean;
  onTogglePresentationMode: () => void;
  appMode?: "live" | "replay";
  onToggleAppMode?: () => void;
}

export default function HeaderStrip({
  mode,
  selectedInstrument,
  marketVenueLabel,
  marketUrl,
  windowEndTimestamp,
  generatedAt,
  marketDisplaySource,
  lastUpdatedTs,
  sourceStatus,
  presentationMode,
  onTogglePresentationMode,
  appMode,
  onToggleAppMode
}: HeaderStripProps) {
  const [suppressStale, setSuppressStale] = useState(true);
  const mountRef = useRef(Date.now());
  useEffect(() => {
    const remaining = 10_000 - (Date.now() - mountRef.current);
    const timer = setTimeout(() => setSuppressStale(false), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, []);

  const generatedAtTimestamp = generatedAt ? Date.parse(generatedAt) : null;
  const snapshotWrittenTimestamp = sourceStatus?.snapshotWrittenAt
    ? Date.parse(sourceStatus.snapshotWrittenAt)
    : null;
  const sessionStartedTimestamp = sourceStatus?.sessionStartedAt
    ? Date.parse(sourceStatus.sessionStartedAt)
    : null;
  const marketFeedStatus = sourceStatus?.kalshi ?? sourceStatus?.polymarket ?? null;
  const rawDatabentoState = sourceStatus?.databento.state ?? null;
  const databentoState = suppressStale && rawDatabentoState === "stale" ? null : rawDatabentoState;
  const liveLabel =
    marketDisplaySource === "midpoint"
      ? `${marketVenueLabel} midpoint`
      : marketDisplaySource === "lastTrade"
        ? `${marketVenueLabel} last trade`
        : `${marketVenueLabel} display mark`;
  const crudeStatusLabel =
    mode !== "live"
      ? "CME CL"
      : databentoState === "stale"
        ? "CME CL stale"
        : databentoState === "reconnecting"
          ? "CME CL reconnecting"
          : databentoState === "warming"
            ? "CME CL warming"
            : databentoState === "disconnected"
              ? "CME CL disconnected"
              : "CME CL";
  const liveUpdateLabel =
    mode === "live" && lastUpdatedTs
      ? databentoState && databentoState !== "connected"
        ? `Last market update ${formatUtcTime(lastUpdatedTs).slice(11, 19)} UTC`
        : `Last update ${formatUtcTime(lastUpdatedTs).slice(11, 19)} UTC`
      : null;

  return (
    <header className="header-strip">
      <div className="loading-stack">
        <div className="header-title">{DASHBOARD_TITLE}</div>
        <div className="header-subtitle">
          {mode === "live" ? LIVE_DASHBOARD_SUBTITLE : DASHBOARD_SUBTITLE}
        </div>
        <div className="pill-row">
          <span className="status-pill">{mode === "live" ? "Live" : "T+1 delayed"}</span>
          <span className="status-pill">{crudeStatusLabel}</span>
          <span className="status-pill">
            {mode === "live" ? liveLabel : "Poly trade history"}
          </span>
          {liveUpdateLabel ? (
            <span className="status-pill">
              {liveUpdateLabel}
            </span>
          ) : null}
          {mode === "live" && marketUrl ? (
            <a
              className="status-pill"
              href={marketUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open {marketVenueLabel}
            </a>
          ) : null}
          {mode === "delayed" && generatedAtTimestamp ? (
            <span className="status-pill">
              Last loaded {formatUtcTime(generatedAtTimestamp).slice(11, 16)} UTC
            </span>
          ) : null}
        </div>
      </div>
      <div className="header-meta">
        {appMode !== undefined && onToggleAppMode ? (
          <div className="mode-toggle-buttons mode-toggle-buttons--inline">
            <button
              className={`mode-toggle-btn${appMode === "replay" ? " mode-toggle-btn--active" : ""}`}
              onClick={() => appMode !== "replay" && onToggleAppMode()}
              type="button"
            >
              Replay
            </button>
            <button
              className={`mode-toggle-btn${appMode === "live" ? " mode-toggle-btn--active" : ""}`}
              onClick={() => appMode !== "live" && onToggleAppMode()}
              type="button"
            >
              Live
            </button>
          </div>
        ) : null}
        <button
          className="secondary-button header-toggle"
          onClick={onTogglePresentationMode}
          type="button"
        >
          {presentationMode ? "Research view" : "Presentation view"}
        </button>
        {presentationMode ? null : (
          <>
            <span>{mode === "live" ? "ticker" : "slug"} {selectedInstrument || "—"}</span>
            {mode === "live" ? (
              <>
                <span>series {sourceStatus?.seriesTicker ?? "—"}</span>
                <span>Databento {sourceStatus?.databento.state ?? "—"}</span>
                <span>{marketVenueLabel} {marketFeedStatus?.state ?? "—"}</span>
                <span>session {formatUtcTime(sessionStartedTimestamp)}</span>
                <span>snapshot {formatUtcTime(snapshotWrittenTimestamp)}</span>
              </>
            ) : (
              <>
                <span>window {formatUtcTime(windowEndTimestamp)}</span>
                <span>loaded {formatUtcTime(generatedAtTimestamp)}</span>
              </>
            )}
          </>
        )}
      </div>
    </header>
  );
}

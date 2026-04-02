"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

import ModeToggle from "@/components/dashboard/ModeToggle";
import ReplayControls from "@/components/dashboard/ReplayControls";
import MethodologyPanel from "@/components/dashboard/MethodologyPanel";
import { useReplayEngine } from "@/hooks/useReplayEngine";
import { computeScatterStats } from "@/lib/analytics";
import {
  DASHBOARD_TITLE,
  POSITIVE_COLOR,
  SIGNAL_RICH_COLOR
} from "@/lib/constants";
import type { ReplayPayload, SessionListItem } from "@/lib/types";

const HeartbeatChart = dynamic(() => import("@/components/dashboard/HeartbeatChart"), {
  ssr: false,
  loading: () => <div className="chart-panel" style={{ minHeight: 340 }} />
});

const ScatterDeltaChart = dynamic(() => import("@/components/dashboard/ScatterDeltaChart"), {
  ssr: false,
  loading: () => <div className="chart-panel" style={{ minHeight: 340 }} />
});

const KpiRow = dynamic(() => import("@/components/dashboard/KpiRow"), { ssr: false });

interface ReplayClientProps {
  appMode: "live" | "replay";
  onToggleAppMode: () => void;
}

async function fetchSessions(): Promise<SessionListItem[]> {
  const res = await fetch("/api/sessions", { cache: "no-store" });
  if (!res.ok) return [];
  return res.json() as Promise<SessionListItem[]>;
}

async function fetchDefaultSession(): Promise<ReplayPayload | null> {
  try {
    // Fetch the precomputed static file — served directly by the web server,
    // no API computation, browser likely already has it cached from the preload hint.
    const res = await fetch("/replay/default-session.json");
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (data && typeof data === "object" && (data as ReplayPayload).ok === true) {
      return data as ReplayPayload;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchSession(
  id: string,
  startTs: string | null,
  endTs: string | null,
  animationStartTs: string | null
): Promise<ReplayPayload | null> {
  try {
    const params = new URLSearchParams();
    // Pass empty string to explicitly opt out of any curated clip
    params.set("startTs", startTs ?? "");
    params.set("endTs", endTs ?? "");
    params.set("animationStartTs", animationStartTs ?? "");
    const res = await fetch(`/api/sessions/${id}?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (
      data &&
      typeof data === "object" &&
      (data as ReplayPayload).ok === true
    ) {
      return data as ReplayPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function formatStrikeLabel(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

export default function ReplayClient({ appMode, onToggleAppMode }: ReplayClientProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<SessionListItem | null>(null);
  const [sessionData, setSessionData] = useState<ReplayPayload | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { visibleObservations, currentIndex, totalCount, isPlaying, speed,
    currentTimestamp, play, pause, seek, setSpeed, restart } = useReplayEngine(sessionData, 5);

  // Load session list on mount
  useEffect(() => {
    fetchSessions().then((list) => {
      setSessions(list);
      const def = list.find((s) => s.default) ?? list[0] ?? null;
      if (def) setSelectedItem(def);
    }).catch(() => setSessions([]));
  }, []);

  // Load session data when selected item changes.
  // For the default curated session use the precomputed static file so the
  // browser can serve it from cache with no API round-trip.
  useEffect(() => {
    if (!selectedItem) return;
    setIsLoadingSession(true);
    setLoadError(null);
    setSessionData(null);

    const loader = selectedItem.default
      ? fetchDefaultSession()
      : fetchSession(selectedItem.id, selectedItem.startTs, selectedItem.endTs, selectedItem.animationStartTs);

    loader.then((data) => {
      if (!data) {
        setLoadError("Failed to load session data.");
      } else {
        setSessionData(data);
      }
    }).catch(() => {
      setLoadError("Failed to load session data.");
    }).finally(() => {
      setIsLoadingSession(false);
    });
  }, [selectedItem]);

  const handleSessionChange = useCallback((idx: string) => {
    const item = sessions[Number(idx)] ?? null;
    if (item) setSelectedItem(item);
  }, [sessions]);

  const latestObservation = visibleObservations[visibleObservations.length - 1] ?? null;
  const scatterStats = useMemo(() => computeScatterStats(visibleObservations), [visibleObservations]);

  const sessionLabel = selectedItem?.label ?? "—";

  const pricing = sessionData?.pricingDefaults;
  const strike = pricing?.strike ?? 100;
  const spreadWidth = pricing?.spreadWidth ?? 1;
  const impliedVol = pricing?.impliedVol ?? 0.9;
  const spreadLow = (strike - spreadWidth / 2).toFixed(1);
  const spreadHigh = (strike + spreadWidth / 2).toFixed(1);
  const ivLabel = Math.round((impliedVol ?? 0.9) * 100);

  const signalState = latestObservation?.signal ?? "Neutral";
  const signalColor =
    signalState === "Market rich"
      ? SIGNAL_RICH_COLOR
      : POSITIVE_COLOR;

  const hasData = visibleObservations.length > 0;

  return (
    <div className="monitor-shell">
      <header className="header-strip">
        <div className="loading-stack">
          <div className="header-title">{DASHBOARD_TITLE}</div>
          <div className="header-subtitle">Market replay — real captured session data</div>
          <div className="pill-row">
            <span className="status-pill status-pill-replay">Replay</span>
            <span className="status-pill">CME CL</span>
            <span className="status-pill">Kalshi midpoint</span>
            {latestObservation?.timestamp ? (
              <span className="status-pill">
                {new Date(latestObservation.timestamp)
                  .toISOString()
                  .replace("T", " ")
                  .slice(11, 19)}{" "}
                UTC
              </span>
            ) : null}
          </div>
        </div>
        <div className="header-meta">
          <ModeToggle appMode={appMode} onToggle={onToggleAppMode} />
          {sessions.length > 0 ? (
            <select
              className="session-selector"
              onChange={(e) => handleSessionChange(e.target.value)}
              value={sessions.indexOf(selectedItem ?? sessions[0])}
            >
              {sessions.map((s, i) => (
                <option key={`${s.id}-${i}`} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>

      {sessionData ? (
        <ReplayControls
          currentIndex={currentIndex}
          currentTimestamp={currentTimestamp}
          isPlaying={isPlaying}
          onPause={pause}
          onPlay={play}
          onRestart={restart}
          onSeek={seek}
          onSetSpeed={setSpeed}
          sessionLabel={sessionLabel}
          speed={speed}
          totalCount={totalCount}
        />
      ) : null}

      {isLoadingSession ? (
        <div className="status-ribbon status-ribbon-compact">
          <span className="status-pill status-pill-note">Loading session data…</span>
        </div>
      ) : loadError ? (
        <div className="status-ribbon status-ribbon-compact">
          <span className="status-pill status-pill-note">{loadError}</span>
        </div>
      ) : null}

      {hasData ? (
        <>
          <KpiRow
            crudeFeedState={null}
            crudeLabel={sessionData?.crudeLabel ?? "CME CL.c.0 (Databento Live)"}
            crudeSubLabel={sessionData?.crudeSubLabel ?? "Historical recording"}
            crudeUpdatedTs={latestObservation?.timestamp ?? null}
            fairPausedMessage={null}
            gapObservation={latestObservation}
            impliedVol={impliedVol}
            isLoading={false}
            latestObservation={latestObservation}
            marketCardContext={null}
            marketCardLabel="Kalshi Yes"
            marketVenueLabel="Kalshi"
            mode="live"
            polyDisplaySource={latestObservation?.polyDisplaySource ?? null}
            polyUpdatedTs={latestObservation?.timestamp ?? null}
            spreadWidth={spreadWidth}
            strike={strike}
          />

          <section className="charts-grid">
            <HeartbeatChart
              crudeLabel={sessionData?.crudeLabel ?? "CME CL.c.0 (Databento Live)"}
              marketLegendLabel="Kalshi"
              observations={visibleObservations}
              pausedMessage={null}
              resetKey={selectedItem ? `${selectedItem.id}-${selectedItem.startTs ?? "full"}` : "replay"}
            />
            <ScatterDeltaChart
              marketLegendLabel="Kalshi"
              observations={visibleObservations}
              pausedMessage={null}
            />
          </section>

          <section className="explain-grid">
            <article className="explain-card">
              <div className="explain-title">What You&apos;re Seeing</div>
              <div className="explain-copy">
                The orange line is the{" "}
                <strong className="explain-keyword">
                  value of the {spreadLow}/{spreadHigh} call spread
                </strong>{" "}
                — priced via Black-Scholes at {ivLabel} IV as CL moves. It is the{" "}
                <strong className="explain-keyword">fair probability</strong> that CL settles
                above ${formatStrikeLabel(strike)}. The teal line is{" "}
                <strong className="explain-keyword">Kalshi&apos;s market price</strong> for the
                same question.{" "}
                <strong className="explain-keyword">
                  The gap between them is the trade.
                </strong>
                {signalState !== "Neutral" ? (
                  <>
                    {" "}
                    Current signal:{" "}
                    <strong style={{ color: signalColor }}>{signalState}</strong>.
                  </>
                ) : null}
              </div>
            </article>
            <article className="explain-card">
              <div className="explain-title">Reading the Scatter</div>
              <div className="explain-copy">
                Each dot is a snapshot: x&nbsp;=&nbsp;CL price, y&nbsp;=&nbsp;probability. The{" "}
                <strong className="explain-keyword">slope of the regression line is the delta</strong>{" "}
                — how much probability moves per $1 in CL. The call spread slope is your{" "}
                <strong className="explain-keyword">model delta</strong>. The Kalshi slope is the{" "}
                <strong className="explain-keyword">implied delta</strong>. The{" "}
                <strong className="explain-keyword">ratio of slopes suggests an edge</strong>.
                {scatterStats.ratio !== null ? (
                  <>
                    {" "}
                    Current ratio:{" "}
                    <strong className="explain-keyword">
                      {scatterStats.ratio.toFixed(2)}×
                    </strong>
                    .
                  </>
                ) : null}
              </div>
            </article>
          </section>
        </>
      ) : !isLoadingSession && !loadError ? (
        <div className="status-ribbon">
          <span className="status-pill status-pill-note">Select a session to begin replay</span>
        </div>
      ) : null}

      <MethodologyPanel />
    </div>
  );
}

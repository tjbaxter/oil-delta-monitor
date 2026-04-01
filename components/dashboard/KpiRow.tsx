import {
  formatCents,
  formatGapCents,
  formatPrice,
  formatProb,
  formatUtcTime
} from "@/lib/format";
import type { Observation, PolyDisplaySource, SnapshotMode } from "@/lib/types";

import KpiCard from "@/components/dashboard/KpiCard";

interface KpiRowProps {
  latestObservation: Observation | null;
  gapObservation: Observation | null;
  mode: SnapshotMode;
  crudeLabel: string;
  crudeSubLabel: string;
  crudeUpdatedTs: number | null;
  marketVenueLabel: string;
  marketCardLabel: string;
  marketCardContext: string | null;
  polyDisplaySource: PolyDisplaySource | null;
  polyUpdatedTs: number | null;
  strike: number;
  spreadWidth: number;
  impliedVol: number;
  crudeFeedState: string | null;
  fairPausedMessage: string | null;
  isLoading: boolean;
}

function gapSignalTone(fairValueGap: number | null | undefined): {
  accentClass: string;
  toneClass: string;
  message: string;
} {
  if (typeof fairValueGap === "number" && fairValueGap > 0) {
    return {
      accentClass: "accent-negative",
      toneClass: "kpi-value-negative",
      message: "Market rich - sell signal"
    };
  }

  return {
    accentClass: "accent-positive",
    toneClass: "kpi-value-positive",
    message: "Market cheap - buy signal"
  };
}

export default function KpiRow({
  latestObservation,
  gapObservation,
  mode,
  crudeLabel,
  crudeSubLabel,
  crudeUpdatedTs,
  marketVenueLabel,
  marketCardLabel,
  marketCardContext,
  polyDisplaySource,
  polyUpdatedTs,
  strike,
  spreadWidth,
  impliedVol,
  crudeFeedState,
  fairPausedMessage,
  isLoading
}: KpiRowProps) {
  const spreadLow = strike - spreadWidth / 2;
  const spreadHigh = strike + spreadWidth / 2;
  const crudeReady =
    latestObservation?.crudePrice !== null && latestObservation?.crudePrice !== undefined;
  const fairReady =
    latestObservation?.fairProb !== null && latestObservation?.fairProb !== undefined;
  const fairGapReady =
    gapObservation?.fairValueGap !== null &&
    gapObservation?.fairValueGap !== undefined;
  const fairPaused = Boolean(fairPausedMessage);
  const fairPausedLabel = fairPausedMessage ?? "Crude feed paused";
  const crudeFeedConnected = mode !== "live" || crudeFeedState === "connected";
  const crudeFreshness =
    crudeUpdatedTs !== null ? formatUtcTime(crudeUpdatedTs).slice(11, 19) : null;
  const polyFreshness =
    polyUpdatedTs !== null ? formatUtcTime(polyUpdatedTs).slice(11, 19) : null;
  const polySourceLabel =
    polyDisplaySource === "midpoint"
      ? "Midpoint"
      : polyDisplaySource === "lastTrade"
        ? "Last trade"
        : mode === "live"
          ? "Display mark"
          : "Historical trade";
  const crudeCardLabel = mode === "live" ? "CL FRONT MONTH" : crudeLabel;
  const liveMarketCardLabel = mode === "live" ? `${marketVenueLabel.toUpperCase()} YES` : marketCardLabel;
  const fairCardLabel = `${spreadLow.toFixed(1)}/${spreadHigh.toFixed(1)} SPREAD VALUE`;
  const fairCardSubtext =
    mode === "live"
      ? `${Math.round(impliedVol * 100)} IV, live expiry`
      : "tight Black-Scholes call spread";
  const gapCardLabel = `${marketVenueLabel.toUpperCase()} - THEO`;
  const gapTone = gapSignalTone(gapObservation?.fairValueGap);
  const crudePausedLabel =
    crudeFeedState === "stale"
      ? `Crude feed stale${crudeFreshness ? ` | last CL ${crudeFreshness} UTC` : ""}`
      : crudeFeedState === "reconnecting"
        ? `Crude feed reconnecting${crudeFreshness ? ` | last CL ${crudeFreshness} UTC` : ""}`
        : crudeFeedState === "warming"
          ? `Crude feed warming${crudeFreshness ? ` | last CL ${crudeFreshness} UTC` : ""}`
          : crudeFeedState === "disconnected"
            ? `Crude feed disconnected${crudeFreshness ? ` | last CL ${crudeFreshness} UTC` : ""}`
            : null;

  return (
    <section className="kpi-grid">
      <KpiCard
        label={crudeCardLabel}
        value={
          crudeReady
            ? formatPrice(latestObservation?.crudePrice)
            : isLoading
              ? "Loading"
              : "Awaiting"
        }
        subtext={
          crudeReady
            ? !crudeFeedConnected && crudePausedLabel
              ? crudePausedLabel
              : mode === "live" && crudeFreshness
                ? `${crudeSubLabel} | ${crudeFreshness} UTC`
                : crudeSubLabel
            : !crudeFeedConnected && crudePausedLabel
              ? crudePausedLabel
              : isLoading
                ? mode === "live"
                  ? "Loading live CME feed..."
                  : "Loading delayed CME history..."
                : mode === "live"
                  ? "Awaiting live CME feed"
                  : "Awaiting delayed CME history"
        }
        accentClass={crudeFeedConnected ? "accent-crude" : "accent-neutral"}
      />
      <KpiCard
        label={liveMarketCardLabel}
        value={
          latestObservation?.polyProb !== null && latestObservation?.polyProb !== undefined
            ? formatProb(latestObservation?.polyProb)
            : isLoading
              ? "Loading"
            : "Awaiting"
        }
        subtext={
          latestObservation?.polyProb !== null && latestObservation?.polyProb !== undefined
            ? `${marketCardContext ? `${marketCardContext} | ` : ""}${formatCents(
                latestObservation.polyProb
              )} | ${polySourceLabel}${polyFreshness ? ` | ${polyFreshness} UTC` : ""}`
            : isLoading
              ? mode === "live"
                ? `Loading live ${marketVenueLabel} book...`
                : "Loading historical trade prices..."
              : mode === "live"
                ? `Awaiting live ${marketVenueLabel} book`
                : "Awaiting historical trade prices"
        }
        accentClass="accent-poly"
      />
      <KpiCard
        label={fairCardLabel}
        value={
          fairPaused
            ? "Paused"
            : fairReady
              ? formatProb(latestObservation?.fairProb)
              : isLoading
                ? "Loading"
                : "Awaiting"
        }
        subtext={
          fairPaused
            ? fairPausedLabel
            : fairReady
              ? fairCardSubtext
              : isLoading
                ? mode === "live"
                  ? "Recomputing live fair value..."
                  : "Loading delayed window..."
                : "Awaiting crude-linked fair value"
        }
        accentClass={fairPaused ? "accent-neutral" : "accent-theo"}
        valueClassName={fairPaused ? "kpi-value-neutral" : undefined}
      />
      <KpiCard
        label={gapCardLabel}
        value={
          fairPaused
            ? "Paused"
            : fairGapReady
              ? formatGapCents(gapObservation?.fairValueGap)
              : isLoading
                ? "Loading"
                : "Awaiting"
        }
        subtext={
          fairPaused
            ? fairPausedLabel
            : fairGapReady
              ? gapTone.message
              : isLoading
                ? mode === "live"
                  ? "Waiting for live pair..."
                  : "Loading delayed window..."
                : "Awaiting paired gap"
        }
        accentClass={fairPaused ? "accent-neutral" : gapTone.accentClass}
        className="kpi-card-hero"
        valueClassName={fairPaused ? "kpi-value-neutral" : gapTone.toneClass}
        subtextClassName={fairPaused ? undefined : gapTone.toneClass}
      />
    </section>
  );
}

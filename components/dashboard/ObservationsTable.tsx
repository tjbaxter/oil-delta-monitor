"use client";

import { useMemo } from "react";

import { formatGapCents, formatNumber, formatPrice, formatProb, formatUtcTime } from "@/lib/format";
import type { Observation, SnapshotMode } from "@/lib/types";

interface ObservationsTableProps {
  observations: Observation[];
  mode: SnapshotMode;
}

function displaySignalLabel(fairValueGap: number | null | undefined): string {
  if (fairValueGap === null || fairValueGap === undefined) {
    return "Awaiting";
  }

  return fairValueGap > 0 ? "Market rich - sell signal" : "Market cheap - buy signal";
}

export default function ObservationsTable({
  observations,
  mode
}: ObservationsTableProps) {
  const marketColumnLabel = mode === "live" ? "Kalshi" : "Poly";
  const csvHref = useMemo(() => {
    if (!observations.length) {
      return "";
    }

    const headers = [
      "timestamp",
      "crudePrice",
      "polyProb",
      "fairProb",
      "fairValueGap",
      "empiricalDeltaInst",
      "empiricalDeltaRoll",
      "theoreticalDelta",
      "deltaGap",
      "signal"
    ];
    const lines = observations.map((observation) =>
      [
        formatUtcTime(observation.timestamp),
        observation.crudePrice ?? "",
        observation.polyProb ?? "",
        observation.fairProb ?? "",
        observation.fairValueGap ?? "",
        observation.empiricalDeltaInst ?? "",
        observation.empiricalDeltaRoll ?? "",
        observation.theoreticalDelta ?? "",
        observation.deltaGap ?? "",
        displaySignalLabel(observation.fairValueGap)
      ].join(",")
    );

    return `data:text/csv;charset=utf-8,${encodeURIComponent(
      [headers.join(","), ...lines].join("\n")
    )}`;
  }, [observations]);

  return (
    <section className="table-panel">
      <div className="panel-head">
        <span>{mode === "live" ? "Recorded observations" : "Delayed observations"}</span>
        <a
          className={`table-button ${observations.length ? "" : "is-disabled"}`.trim()}
          download="oil-delta-history.csv"
          href={csvHref || undefined}
        >
          Download CSV
        </a>
      </div>
      <div className="table-scroll">
        <table className="observations-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Crude</th>
              <th>{marketColumnLabel}</th>
              <th>Fair</th>
              <th>Fair gap</th>
              <th>Empirical delta</th>
              <th>Theo delta</th>
              <th>Delta gap</th>
              <th>Signal</th>
            </tr>
          </thead>
          <tbody>
            {observations.length ? (
              observations.slice(-60).reverse().map((observation) => (
                <tr key={`${observation.timestamp}-${observation.polyProb}`}>
                  <td className="mono">{formatUtcTime(observation.timestamp)}</td>
                  <td>{formatPrice(observation.crudePrice)}</td>
                  <td>{formatProb(observation.polyProb)}</td>
                  <td>{formatProb(observation.fairProb)}</td>
                  <td>{formatGapCents(observation.fairValueGap)}</td>
                  <td>{formatNumber(observation.empiricalDeltaRoll, 3)}</td>
                  <td>{formatNumber(observation.theoreticalDelta, 4)}</td>
                  <td>{formatNumber(observation.deltaGap, 3)}</td>
                  <td>{displaySignalLabel(observation.fairValueGap)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="empty-row" colSpan={9}>
                  No observations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

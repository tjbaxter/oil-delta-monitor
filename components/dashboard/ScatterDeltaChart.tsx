"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";

import { computeScatterStats } from "@/lib/analytics";
import { BG_COLOR, PANEL_BG, POLY_COLOR, THEO_COLOR } from "@/lib/constants";
import type { Observation } from "@/lib/types";

const MONO_FONT = '"IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace';
const MUTED_TITLE = "rgba(130, 150, 170, 0.55)";
const MUTED_TICK = "rgba(140, 160, 180, 0.45)";
const MUTED_LEGEND = "rgba(160, 175, 190, 0.5)";
const DIM_GRID = "rgba(255, 255, 255, 0.025)";
const STAT_BG = "rgba(6, 10, 18, 0.78)";

const Plot = dynamic(() => import("@/components/dashboard/PlotClient"), {
  ssr: false,
  loading: () => <div className="chart-loading">Loading chart...</div>
});

interface ScatterDeltaChartProps {
  observations: Observation[];
  marketLegendLabel: string;
  pausedMessage?: string | null;
}

function fitLine(
  points: Array<{ x: number; y: number }>
): { x: number[]; y: number[] } | null {
  if (points.length < 2) {
    return null;
  }

  const xMean = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const yMean = points.reduce((sum, point) => sum + point.y, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const xDiff = point.x - xMean;
    numerator += xDiff * (point.y - yMean);
    denominator += xDiff * xDiff;
  }

  if (Math.abs(denominator) < 1e-12) {
    return null;
  }

  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;
  const xValues = points.map((point) => point.x);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);

  return {
    x: [minX, maxX],
    y: [intercept + slope * minX, intercept + slope * maxX]
  };
}

export default function ScatterDeltaChart({
  observations,
  marketLegendLabel,
  pausedMessage
}: ScatterDeltaChartProps) {
  const { data, layout } = useMemo(() => {
    const paused = Boolean(pausedMessage);
    const hasCrudeHistory = observations.some(
      (observation) => observation.crudePrice !== null
    );
    const paired = paused
      ? []
      : observations.filter(
          (observation) =>
            observation.crudePrice !== null &&
            observation.polyProb !== null &&
            observation.fairProb !== null
        );

    const polyPoints = paired.map((point) => ({
      x: point.crudePrice as number,
      y: point.polyProb as number
    }));
    const theoPoints = paired.map((point) => ({
      x: point.crudePrice as number,
      y: point.fairProb as number
    }));
    const latestPolyPoint = polyPoints[polyPoints.length - 1] ?? null;
    const latestTheoPoint = theoPoints[theoPoints.length - 1] ?? null;

    const polyFit = fitLine(polyPoints);
    const theoFit = fitLine(theoPoints);
    const stats = paused
      ? { polySlope: null, theoSlope: null, ratio: null }
      : computeScatterStats(observations);
    const showAxes = paired.length > 0;
    const statAnnotations =
      paused
        ? [
            {
              x: 0.5,
              y: 0.5,
              xref: "paper",
              yref: "paper",
              showarrow: false,
              xanchor: "center",
              yanchor: "middle",
              align: "center",
              text: pausedMessage,
              font: { color: "#95a5ba", size: 12, family: MONO_FONT }
            }
          ]
        : stats.polySlope !== null && stats.theoSlope !== null && stats.ratio !== null
        ? [
            {
              x: 0.03,
              y: 0.97,
              xref: "paper",
              yref: "paper",
              showarrow: false,
              xanchor: "left",
              align: "left",
              text: `\u0394 ${marketLegendLabel.toLowerCase()} = ${stats.polySlope.toFixed(4)} / $`,
              font: { color: POLY_COLOR, size: 13, family: MONO_FONT },
              bgcolor: STAT_BG
            },
            {
              x: 0.03,
              y: 0.90,
              xref: "paper",
              yref: "paper",
              showarrow: false,
              xanchor: "left",
              align: "left",
              text: `\u0394 theo = ${stats.theoSlope.toFixed(4)} / $`,
              font: { color: THEO_COLOR, size: 13, family: MONO_FONT },
              bgcolor: STAT_BG
            },
            {
              x: 0.03,
              y: 0.83,
              xref: "paper",
              yref: "paper",
              showarrow: false,
              xanchor: "left",
              align: "left",
              text: `ratio: ${stats.ratio.toFixed(2)}x`,
              font: { color: "#dbe8f8", size: 13, family: MONO_FONT },
              bgcolor: STAT_BG
            }
          ]
        : [
            {
              x: 0.03,
              y: 0.95,
              xref: "paper",
              yref: "paper",
              showarrow: false,
              xanchor: "left",
              align: "left",
              text: !hasCrudeHistory
                ? "Fair value and delta require delayed CME CL.c.0 history."
                : "Paired delayed data still accumulating or unavailable",
              font: { color: "#95a5ba", size: 12, family: MONO_FONT }
            }
          ];

    // Dynamic axis bounds from current windowed points only — never ratchet.
    // The observations are already time-windowed upstream; ratcheting here
    // caused the scatter to bunch into the top-right corner after long sessions.
    const xRange: [number, number] | undefined =
      polyPoints.length > 0
        ? (() => {
            const allX = polyPoints.map((p) => p.x);
            const min = Math.min(...allX);
            const max = Math.max(...allX);
            const pad = Math.max(0.02, (max - min) * 0.10);
            return [min - pad, max + pad];
          })()
        : undefined;
    const yRange: [number, number] | undefined =
      polyPoints.length > 0
        ? (() => {
            const allY = [...polyPoints.map((p) => p.y), ...theoPoints.map((p) => p.y)];
            const min = Math.min(...allY);
            const max = Math.max(...allY);
            const pad = Math.max(0.005, (max - min) * 0.10);
            return [Math.max(0, min - pad), Math.min(1, max + pad)];
          })()
        : undefined;

    return {
      data: [
        {
          type: "scatter",
          mode: "markers",
          name: marketLegendLabel,
          x: polyPoints.map((point) => point.x),
          y: polyPoints.map((point) => point.y),
          marker: { color: POLY_COLOR, size: 5.5, opacity: 0.52 }
        },
        {
          type: "scatter",
          mode: "markers",
          name: "Fair",
          x: theoPoints.map((point) => point.x),
          y: theoPoints.map((point) => point.y),
          marker: { color: THEO_COLOR, size: 5.25, opacity: 0.48 }
        },
        ...(latestPolyPoint
          ? [
              {
                type: "scatter",
                mode: "markers",
                name: `${marketLegendLabel} latest glow`,
                showlegend: false,
                hoverinfo: "skip",
                x: [latestPolyPoint.x],
                y: [latestPolyPoint.y],
                marker: {
                  color: POLY_COLOR,
                  size: 30,
                  opacity: 0.18
                }
              },
              {
                type: "scatter",
                mode: "markers",
                name: `${marketLegendLabel} latest`,
                showlegend: false,
                hoverinfo: "skip",
                x: [latestPolyPoint.x],
                y: [latestPolyPoint.y],
                marker: {
                  color: POLY_COLOR,
                  size: 12,
                  line: { color: PANEL_BG, width: 2.5 }
                }
              }
            ]
          : []),
        ...(latestTheoPoint
          ? [
              {
                type: "scatter",
                mode: "markers",
                name: "Fair latest glow",
                showlegend: false,
                hoverinfo: "skip",
                x: [latestTheoPoint.x],
                y: [latestTheoPoint.y],
                marker: {
                  color: THEO_COLOR,
                  size: 28,
                  opacity: 0.18
                }
              },
              {
                type: "scatter",
                mode: "markers",
                name: "Fair latest",
                showlegend: false,
                hoverinfo: "skip",
                x: [latestTheoPoint.x],
                y: [latestTheoPoint.y],
                marker: {
                  color: THEO_COLOR,
                  size: 11,
                  line: { color: PANEL_BG, width: 2.5 }
                }
              }
            ]
          : []),
        ...(polyFit
          ? [
              {
                type: "scatter",
                mode: "lines",
                name: `${marketLegendLabel} fit`,
                x: polyFit.x,
                y: polyFit.y,
                line: { color: POLY_COLOR, width: 1.9, dash: "dot" }
              }
            ]
          : []),
        ...(theoFit
          ? [
              {
                type: "scatter",
                mode: "lines",
                name: "Fair fit",
                x: theoFit.x,
                y: theoFit.y,
                line: { color: THEO_COLOR, width: 1.9, dash: "dot" }
              }
            ]
          : [])
      ],
      layout: {
        title: {
          text: `<span style="font-family:${MONO_FONT};font-size:10px;letter-spacing:0.14em;color:${MUTED_TITLE};">\u0394 SCATTER \u2014 SLOPE : DELTA</span>`,
          x: 0.02,
          xanchor: "left"
        },
        paper_bgcolor: PANEL_BG,
        plot_bgcolor: BG_COLOR,
        margin: { l: 44, r: 26, t: 52, b: 34 },
        height: 372,
        font: { color: MUTED_TICK, size: 11 },
        hoverlabel: {
          bgcolor: "#091220",
          bordercolor: "#19304a",
          font: { color: "#e6eef8", family: MONO_FONT, size: 11 }
        },
        legend: {
          orientation: "h",
          x: 0.995,
          y: 1.02,
          xanchor: "right",
          yanchor: "bottom",
          font: { size: 10, family: MONO_FONT, color: MUTED_LEGEND },
          bgcolor: "rgba(0,0,0,0)"
        },
        xaxis: {
          title: showAxes ? { text: "CL PRICE", font: { size: 10, family: MONO_FONT, color: MUTED_TITLE } } : undefined,
          gridcolor: showAxes ? DIM_GRID : "transparent",
          showgrid: showAxes,
          showticklabels: showAxes,
          tickfont: { family: MONO_FONT, size: 10, color: MUTED_TICK },
          zeroline: false,
          range: xRange
        },
        yaxis: {
          title: showAxes ? { text: "PROBABILITY", font: { size: 10, family: MONO_FONT, color: MUTED_TITLE } } : undefined,
          tickformat: ".0%",
          gridcolor: showAxes ? DIM_GRID : "transparent",
          showgrid: showAxes,
          showticklabels: showAxes,
          tickfont: { family: MONO_FONT, size: 10, color: MUTED_TICK },
          zeroline: false,
          range: yRange
        },
        annotations: statAnnotations,
        uirevision: "scatter"
      }
    };
  }, [marketLegendLabel, observations, pausedMessage]);

  return (
    <div className="chart-panel chart-panel-wide">
      <Plot
        data={data as never[]}
        layout={layout as never}
        config={{ displayModeBar: false, responsive: true }}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

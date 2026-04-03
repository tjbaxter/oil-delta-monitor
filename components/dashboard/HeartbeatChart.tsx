"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef } from "react";

import { BG_COLOR, PANEL_BG, POLY_COLOR, THEO_COLOR } from "@/lib/constants";
import type { Observation } from "@/lib/types";

const MONO_FONT = '"IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace';
const PROBABILITY_PAD = 0.005;
const MUTED_TITLE = "rgba(130, 150, 170, 0.55)";
const MUTED_TICK = "rgba(140, 160, 180, 0.45)";
const MUTED_LEGEND = "rgba(160, 175, 190, 0.5)";
const DIM_GRID = "rgba(255, 255, 255, 0.025)";

const Plot = dynamic(() => import("@/components/dashboard/PlotClient"), {
  ssr: false,
  loading: () => <div className="chart-loading">Loading chart...</div>
});

interface Bounds { min: number; max: number }
const EMPTY_BOUNDS: Bounds = { min: Infinity, max: -Infinity };

interface HeartbeatChartProps {
  observations: Observation[];
  crudeLabel: string;
  marketLegendLabel: string;
  pausedMessage?: string | null;
  cmeNote?: string | null;
  resetKey?: string;
}

export default function HeartbeatChart({
  observations,
  crudeLabel,
  marketLegendLabel,
  pausedMessage,
  cmeNote,
  resetKey
}: HeartbeatChartProps) {
  // Ratcheted axis bounds: expand to fit new data, never shrink within a session.
  // Refs are safe to mutate inside useMemo — they're not state and don't cause re-renders.
  const probBoundsRef = useRef<Bounds>({ ...EMPTY_BOUNDS });
  const crudeBoundsRef = useRef<Bounds>({ ...EMPTY_BOUNDS });
  const prevResetKeyRef = useRef<string | undefined>(undefined);

  const { data, layout } = useMemo(() => {
    // Reset when strike/market changes so the new range re-discovers bounds cleanly.
    if (resetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = resetKey;
      probBoundsRef.current = { ...EMPTY_BOUNDS };
      crudeBoundsRef.current = { ...EMPTY_BOUNDS };
    }
    const fairPaused = Boolean(pausedMessage);
    const hasPolyHistory = observations.some((observation) => observation.polyProb !== null);
    const hasCrude = observations.some((observation) => observation.crudePrice !== null);
    const hasTheo = !fairPaused && observations.some((observation) => observation.fairProb !== null);
    const probabilityValues = observations
      .flatMap((observation) => [observation.polyProb, observation.fairProb])
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const latestPoly = [...observations]
      .reverse()
      .find((observation) => observation.polyProb !== null);
    const latestTheo = fairPaused
      ? null
      : [...observations].reverse().find((observation) => observation.fairProb !== null);
    const noCrudeFairMessage =
      fairPaused
        ? pausedMessage
        : hasPolyHistory && !hasCrude && !hasTheo
        ? "Fair value and delta require delayed CME CL.c.0 history."
        : null;
    // Ratchet probability bounds: expand to fit, never shrink.
    if (probabilityValues.length > 0) {
      const dataMin = Math.min(...probabilityValues);
      const dataMax = Math.max(...probabilityValues);
      probBoundsRef.current = {
        min: Math.min(probBoundsRef.current.min, dataMin),
        max: Math.max(probBoundsRef.current.max, dataMax)
      };
    }
    const probabilityRange: [number, number] | undefined =
      probBoundsRef.current.min < probBoundsRef.current.max
        ? (() => {
            const { min, max } = probBoundsRef.current;
            const span = max - min;
            const pad = Math.max(PROBABILITY_PAD, span * 0.08);
            const lower = Math.max(0, min - pad);
            const upper = Math.min(1, max + pad);
            if (upper - lower < PROBABILITY_PAD * 4) {
              return [Math.max(0, lower - PROBABILITY_PAD), Math.min(1, upper + PROBABILITY_PAD)];
            }
            return [lower, upper];
          })()
        : undefined;

    // Ratchet CL price bounds for right y-axis.
    const crudePrices = observations
      .map((o) => o.crudePrice)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (crudePrices.length > 0) {
      crudeBoundsRef.current = {
        min: Math.min(crudeBoundsRef.current.min, Math.min(...crudePrices)),
        max: Math.max(crudeBoundsRef.current.max, Math.max(...crudePrices))
      };
    }
    const crudeRange: [number, number] | undefined =
      crudeBoundsRef.current.min < crudeBoundsRef.current.max
        ? (() => {
            const { min, max } = crudeBoundsRef.current;
            const pad = Math.max(0.05, (max - min) * 0.08);
            return [min - pad, max + pad];
          })()
        : undefined;

    const data = [
      ...(hasPolyHistory
        ? [
            {
              type: "scatter",
              mode: "lines",
              name: `${marketLegendLabel} glow`,
              showlegend: false,
              hoverinfo: "skip",
              x: observations.map((observation) => new Date(observation.timestamp)),
              y: observations.map((observation) => observation.polyProb),
              line: { color: POLY_COLOR, width: 7 },
              opacity: 0.16
            },
            {
              type: "scatter",
              mode: "lines",
              name: marketLegendLabel,
              x: observations.map((observation) => new Date(observation.timestamp)),
              y: observations.map((observation) => observation.polyProb),
              line: { color: POLY_COLOR, width: 2.5 }
            }
          ]
        : []),
      ...(latestPoly
        ? [
            {
              type: "scatter",
              mode: "markers",
              name: `${marketLegendLabel} latest`,
              showlegend: false,
              hoverinfo: "skip",
              x: [new Date(latestPoly.timestamp)],
              y: [latestPoly.polyProb],
              marker: {
                color: POLY_COLOR,
                size: 9,
                line: { color: PANEL_BG, width: 2 }
              }
            }
          ]
        : []),
      ...(hasTheo
        ? [
            {
              type: "scatter",
              mode: "lines",
              name: "Fair glow",
              showlegend: false,
              hoverinfo: "skip",
              x: observations.map((observation) => new Date(observation.timestamp)),
              y: observations.map((observation) => observation.fairProb),
              line: { color: THEO_COLOR, width: 7 },
              opacity: 0.14
            },
            {
              type: "scatter",
              mode: "lines",
              name: "Fair",
              x: observations.map((observation) => new Date(observation.timestamp)),
              y: observations.map((observation) => observation.fairProb),
              line: { color: THEO_COLOR, width: 2.2 }
            },
            ...(latestTheo
              ? [
                  {
                    type: "scatter",
                    mode: "markers",
                    name: "Fair latest",
                    showlegend: false,
                    hoverinfo: "skip",
                    x: [new Date(latestTheo.timestamp)],
                    y: [latestTheo.fairProb],
                    marker: {
                      color: THEO_COLOR,
                      size: 7,
                      line: { color: PANEL_BG, width: 2 }
                    }
                  }
                ]
              : [])
          ]
        : []),
      ...(hasCrude
        ? [
            {
              type: "scatter",
              mode: "lines",
              name: crudeLabel,
              x: observations.map((observation) => new Date(observation.timestamp)),
              y: observations.map((observation) => observation.crudePrice),
              yaxis: "y2",
              opacity: 0.38,
              line: { color: "rgba(154, 164, 184, 0.85)", width: 1.1 }
            }
          ]
        : []),
    ];

    return {
      data,
      layout: {
        title: {
          text: cmeNote
            ? `<span style="font-family:${MONO_FONT};font-size:10px;letter-spacing:0.14em;color:${MUTED_TITLE};">HEARTBEAT \u2014 ${marketLegendLabel.toUpperCase()} ODDS BOUNCING AROUND FAIR VALUE</span><br><span style="font-family:${MONO_FONT};font-size:9px;color:#6b7e9a;">${cmeNote}</span>`
            : `<span style="font-family:${MONO_FONT};font-size:10px;letter-spacing:0.14em;color:${MUTED_TITLE};">HEARTBEAT \u2014 ${marketLegendLabel.toUpperCase()} ODDS BOUNCING AROUND FAIR VALUE</span>`,
          x: 0.02,
          xanchor: "left"
        },
        paper_bgcolor: PANEL_BG,
        plot_bgcolor: BG_COLOR,
        margin: { l: 42, r: 48, t: 52, b: 34 },
        height: 372,
        font: { color: MUTED_TICK, size: 11 },
        hovermode: "x unified",
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
          tickfont: { family: MONO_FONT, size: 10, color: MUTED_TICK },
          showgrid: true,
          gridcolor: DIM_GRID,
          tickcolor: "rgba(255, 255, 255, 0.04)",
          zeroline: false
        },
        yaxis: {
          title: { text: "PROBABILITY", font: { family: MONO_FONT, size: 10, color: MUTED_TITLE } },
          tickformat: ".0%",
          gridcolor: DIM_GRID,
          tickfont: { family: MONO_FONT, size: 10, color: MUTED_TICK },
          range: probabilityRange
        },
        ...(hasCrude
          ? {
              yaxis2: {
                title: { text: crudeLabel.toUpperCase(), font: { family: MONO_FONT, size: 10, color: MUTED_TITLE } },
                overlaying: "y",
                side: "right",
                showgrid: false,
                tickfont: { family: MONO_FONT, size: 10, color: MUTED_TICK },
                range: crudeRange
              }
            }
          : {}),
        annotations:
          noCrudeFairMessage
            ? [
                {
                  x: 0.5,
                  y: 0.5,
                  xref: "paper",
                  yref: "paper",
                  align: "center",
                  xanchor: "center",
                  yanchor: "middle",
                  text: noCrudeFairMessage,
                  showarrow: false,
                  font: { color: "#95a5ba", size: 11, family: MONO_FONT }
                }
              ]
            : hasPolyHistory || hasTheo || hasCrude
              ? []
              : [
                  {
                    x: 0.5,
                    y: 0.5,
                    xref: "paper",
                    yref: "paper",
                    text: "Delayed history unavailable",
                    showarrow: false,
                    font: { color: "#95a5ba", size: 12, family: MONO_FONT }
                  }
                ],
        uirevision: "heartbeat"
      }
    };
  }, [cmeNote, crudeLabel, marketLegendLabel, observations, pausedMessage, resetKey]);

  return (
    <div className="chart-panel">
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

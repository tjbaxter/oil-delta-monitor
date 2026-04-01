"use client";

import type { ChangeEvent } from "react";
import type { SnapshotMode } from "@/lib/types";

interface ControlsPanelProps {
  snapshotMode: SnapshotMode;
  slug: string;
  onSlugChange: (value: string) => void;
  strike: number;
  onStrikeChange: (value: number) => void;
  spreadWidth: number;
  onSpreadWidthChange: (value: number) => void;
  impliedVol: number;
  onImpliedVolChange: (value: number) => void;
  riskFreeRate: number;
  onRiskFreeRateChange: (value: number) => void;
  rollingWindow: number;
  onRollingWindowChange: (value: number) => void;
  fairGapThreshold: number;
  onFairGapThresholdChange: (value: number) => void;
  deltaGapThreshold: number;
  onDeltaGapThresholdChange: (value: number) => void;
  useMarketExpiry: boolean;
  onUseMarketExpiryChange: (value: boolean) => void;
  expiryOverride: string;
  onExpiryOverrideChange: (value: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
}

function numberValue(event: ChangeEvent<HTMLInputElement>): number {
  return Number(event.target.value);
}

export default function ControlsPanel({
  snapshotMode,
  slug,
  onSlugChange,
  strike,
  onStrikeChange,
  spreadWidth,
  onSpreadWidthChange,
  impliedVol,
  onImpliedVolChange,
  riskFreeRate,
  onRiskFreeRateChange,
  rollingWindow,
  onRollingWindowChange,
  fairGapThreshold,
  onFairGapThresholdChange,
  deltaGapThreshold,
  onDeltaGapThresholdChange,
  useMarketExpiry,
  onUseMarketExpiryChange,
  expiryOverride,
  onExpiryOverrideChange,
  onRefresh,
  isLoading
}: ControlsPanelProps) {
  const liveMode = snapshotMode === "live";

  return (
    <details className="controls-panel">
      <summary>Model Controls</summary>
      <div className="controls-grid controls-grid-single">
        <label className="field">
          <span>{liveMode ? "Ingestor market ticker" : "Market slug"}</span>
          <input
            value={slug}
            disabled={liveMode}
            onChange={(event) => onSlugChange(event.target.value)}
          />
        </label>
        {liveMode ? (
          <span className="field-note">
            Live mode tracks the Kalshi contract selected by the Python ingestor.
          </span>
        ) : null}
      </div>

      <div className="controls-grid controls-grid-compact">
        <label className="field">
          <span>Strike</span>
          <input
            type="number"
            step="0.5"
            value={strike}
            onChange={(event) => onStrikeChange(numberValue(event))}
          />
        </label>
        <label className="field">
          <span>Spread width</span>
          <input
            type="number"
            step="0.05"
            value={spreadWidth}
            onChange={(event) => onSpreadWidthChange(numberValue(event))}
          />
        </label>
        <label className="field">
          <span>Implied vol</span>
          <input
            type="number"
            step="0.01"
            value={impliedVol}
            onChange={(event) => onImpliedVolChange(numberValue(event))}
          />
        </label>
        <label className="field">
          <span>Risk-free rate</span>
          <input
            type="number"
            step="0.005"
            value={riskFreeRate}
            onChange={(event) => onRiskFreeRateChange(numberValue(event))}
          />
        </label>
        <label className="field">
          <span>Rolling window</span>
          <input
            type="number"
            step="1"
            value={rollingWindow}
            onChange={(event) => onRollingWindowChange(numberValue(event))}
          />
        </label>
        <label className="field">
          <span>Fair gap threshold</span>
          <input
            type="number"
            step="0.005"
            value={fairGapThreshold}
            onChange={(event) => onFairGapThresholdChange(numberValue(event))}
          />
        </label>
        <label className="field">
          <span>Delta gap threshold</span>
          <input
            type="number"
            step="0.005"
            value={deltaGapThreshold}
            onChange={(event) => onDeltaGapThresholdChange(numberValue(event))}
          />
        </label>
        <label className="field field-checkbox">
          <span>Use market expiry</span>
          <input
            checked={useMarketExpiry}
            onChange={(event) => onUseMarketExpiryChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        <label className="field">
          <span>Expiry override</span>
          <input
            type="date"
            value={expiryOverride}
            disabled={useMarketExpiry}
            onChange={(event) => onExpiryOverrideChange(event.target.value)}
          />
        </label>
      </div>

      <div className="control-actions">
        <button className="primary-button" onClick={onRefresh} type="button">
          {isLoading
            ? "Refreshing..."
            : liveMode
              ? "Refresh local live snapshot"
              : "Refresh delayed window"}
        </button>
      </div>
    </details>
  );
}

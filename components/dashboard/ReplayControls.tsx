"use client";

import type { ReplaySpeed } from "@/hooks/useReplayEngine";

const SPEEDS: ReplaySpeed[] = [1, 2, 5, 10, 20];

function formatTimestamp(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatProgress(index: number, total: number): string {
  if (total === 0) return "—";
  return `${index + 1} / ${total}`;
}

interface ReplayControlsProps {
  isPlaying: boolean;
  speed: ReplaySpeed;
  progress?: number;
  currentIndex: number;
  totalCount: number;
  currentTimestamp: number | null;
  sessionLabel: string;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (index: number) => void;
  onSetSpeed: (speed: ReplaySpeed) => void;
  onRestart: () => void;
}

export default function ReplayControls({
  isPlaying,
  speed,
  currentIndex,
  totalCount,
  currentTimestamp,
  sessionLabel,
  onPlay,
  onPause,
  onSeek,
  onSetSpeed,
  onRestart
}: ReplayControlsProps) {
  const atEnd = totalCount > 0 && currentIndex >= totalCount - 1;

  return (
    <div className="replay-controls">
      <div className="replay-badge">
        <span className="replay-badge-dot" />
        Market Replay — {sessionLabel}
      </div>

      <div className="replay-controls-row">
        <div className="replay-transport">
          {atEnd ? (
            <button
              className="replay-btn replay-btn-play"
              onClick={onRestart}
              title="Restart replay"
              type="button"
            >
              ↺
            </button>
          ) : isPlaying ? (
            <button
              className="replay-btn replay-btn-play"
              onClick={onPause}
              title="Pause"
              type="button"
            >
              ❚❚
            </button>
          ) : (
            <button
              className="replay-btn replay-btn-play"
              onClick={onPlay}
              title="Play"
              type="button"
            >
              ▶
            </button>
          )}
        </div>

        <div className="replay-scrubber-wrap">
          <input
            className="replay-scrubber"
            max={Math.max(0, totalCount - 1)}
            min={0}
            onChange={(e) => onSeek(Number(e.target.value))}
            onMouseDown={onPause}
            step={1}
            type="range"
            value={currentIndex}
          />
          <div className="replay-time">{formatTimestamp(currentTimestamp)}</div>
        </div>

        <div className="replay-speed-group">
          {SPEEDS.map((s) => (
            <button
              className={`replay-speed-btn${s === speed ? " replay-speed-btn--active" : ""}`}
              key={s}
              onClick={() => onSetSpeed(s)}
              type="button"
            >
              {s}×
            </button>
          ))}
        </div>

        <div className="replay-progress-label">
          {formatProgress(currentIndex, totalCount)}
        </div>
      </div>
    </div>
  );
}

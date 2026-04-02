"use client";

interface ModeToggleProps {
  appMode: "live" | "replay";
  onToggle: () => void;
}

export default function ModeToggle({ appMode, onToggle }: ModeToggleProps) {
  return (
    <div className="mode-toggle-bar">
      <div className="mode-toggle-buttons">
        <button
          className={`mode-toggle-btn${appMode === "replay" ? " mode-toggle-btn--active" : ""}`}
          onClick={() => appMode !== "replay" && onToggle()}
          type="button"
        >
          Replay
        </button>
        <button
          className={`mode-toggle-btn${appMode === "live" ? " mode-toggle-btn--active" : ""}`}
          onClick={() => appMode !== "live" && onToggle()}
          type="button"
        >
          Live
        </button>
      </div>
      {appMode === "replay" ? (
        <span className="mode-toggle-hint">
          Viewing real market data replay — switch to Live for current feed
        </span>
      ) : null}
    </div>
  );
}

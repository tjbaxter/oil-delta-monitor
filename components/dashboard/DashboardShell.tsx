"use client";

import { useEffect, useState } from "react";

import DashboardClient from "@/components/dashboard/DashboardClient";
import ReplayClient from "@/components/dashboard/ReplayClient";
import { getCMEStatus } from "@/lib/cmeCalendar";
import type { CMEStatus } from "@/lib/cmeCalendar";
import type { SnapshotMode } from "@/lib/types";

type AppMode = "live" | "replay";

interface DashboardShellProps {
  initialSlug: string;
  initialMode: SnapshotMode;
}

export default function DashboardShell({ initialSlug, initialMode }: DashboardShellProps) {
  // Always start in replay — that's what recruiters see on first load.
  // Switch to live on ?mode=live or when the user clicks the toggle.
  const [appMode, setAppMode] = useState<AppMode>("replay");

  // Compute cmeStatus here so it's available immediately when toggling to live —
  // DashboardClient receives it as a prop and renders the hero on frame 1.
  const [cmeStatus, setCmeStatus] = useState<CMEStatus>(() => getCMEStatus());
  useEffect(() => {
    const interval = setInterval(() => setCmeStatus(getCMEStatus()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "live") {
      setAppMode("live");
    }
  }, []);

  const toggleMode = () =>
    setAppMode((prev) => (prev === "live" ? "replay" : "live"));

  // Render BOTH simultaneously — hide the inactive one with display:none.
  // This preserves all state (scrubber position, live data, etc.) across toggles.
  // display:"contents" makes the wrapper invisible to layout; the children
  // render as if it weren't there.
  return (
    <>
      <div style={{ display: appMode === "live" ? "contents" : "none" }}>
        <DashboardClient
          appMode="live"
          initialError={null}
          initialMode={initialMode}
          initialPayload={null}
          initialSlug={initialSlug}
          onToggleAppMode={toggleMode}
          cmeStatus={cmeStatus}
        />
      </div>
      <div style={{ display: appMode === "replay" ? "contents" : "none" }}>
        <ReplayClient
          appMode="replay"
          onToggleAppMode={toggleMode}
        />
      </div>
    </>
  );
}

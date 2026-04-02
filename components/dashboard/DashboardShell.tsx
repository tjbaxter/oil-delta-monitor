"use client";

import { useEffect, useState } from "react";

import DashboardClient from "@/components/dashboard/DashboardClient";
import ReplayClient from "@/components/dashboard/ReplayClient";
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "live") {
      setAppMode("live");
    }
  }, []);

  const toggleMode = () =>
    setAppMode((prev) => (prev === "live" ? "replay" : "live"));

  if (appMode === "replay") {
    return <ReplayClient appMode="replay" onToggleAppMode={toggleMode} />;
  }

  return (
    <DashboardClient
      appMode="live"
      initialError={null}
      initialMode={initialMode}
      initialPayload={null}
      initialSlug={initialSlug}
      onToggleAppMode={toggleMode}
    />
  );
}

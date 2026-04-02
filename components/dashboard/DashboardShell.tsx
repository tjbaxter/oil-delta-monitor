"use client";

import { useEffect, useState } from "react";

import DashboardClient from "@/components/dashboard/DashboardClient";
import ReplayClient from "@/components/dashboard/ReplayClient";
import type { BootstrapPayload, SnapshotMode } from "@/lib/types";

type AppMode = "live" | "replay";

interface DashboardShellProps {
  initialPayload: BootstrapPayload | null;
  initialError: string | null;
  initialSlug: string;
  initialMode: SnapshotMode;
  defaultAppMode: AppMode;
}

export default function DashboardShell({
  initialPayload,
  initialError,
  initialSlug,
  initialMode,
  defaultAppMode
}: DashboardShellProps) {
  const [appMode, setAppMode] = useState<AppMode>(defaultAppMode);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Check URL param after mount
    const params = new URLSearchParams(window.location.search);
    const urlMode = params.get("mode");
    if (urlMode === "live" || urlMode === "replay") {
      setAppMode(urlMode);
    }
  }, []);

  const toggleMode = () =>
    setAppMode((prev) => (prev === "live" ? "replay" : "live"));

  // During SSR and before mount, render live dashboard to avoid hydration mismatch
  if (!mounted) {
    return (
      <DashboardClient
        appMode="live"
        initialError={initialError}
        initialMode={initialMode}
        initialPayload={initialPayload}
        initialSlug={initialSlug}
        onToggleAppMode={toggleMode}
      />
    );
  }

  if (appMode === "replay") {
    return <ReplayClient appMode={appMode} onToggleAppMode={toggleMode} />;
  }

  return (
    <DashboardClient
      appMode={appMode}
      initialError={initialError}
      initialMode={initialMode}
      initialPayload={initialPayload}
      initialSlug={initialSlug}
      onToggleAppMode={toggleMode}
    />
  );
}

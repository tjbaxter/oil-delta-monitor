"use client";

import { useEffect, useState } from "react";

import DashboardClient from "@/components/dashboard/DashboardClient";
import ReplayClient from "@/components/dashboard/ReplayClient";
import { getCMEStatus } from "@/lib/cmeCalendar";
import type { CMEStatus } from "@/lib/cmeCalendar";
import type { BootstrapPayload, ReplayPayload, SessionListItem, SnapshotMode } from "@/lib/types";

type AppMode = "live" | "replay";

interface InitialReplayData {
  sessionData: ReplayPayload | null;
  sessions: SessionListItem[];
}

interface DashboardShellProps {
  initialSlug: string;
  initialMode: SnapshotMode;
  initialReplayData?: InitialReplayData;
}

export default function DashboardShell({ initialSlug, initialMode, initialReplayData }: DashboardShellProps) {
  // Always start in replay — that's what recruiters see on first load.
  // Switch to live on ?mode=live or when the user clicks the toggle.
  const [appMode, setAppMode] = useState<AppMode>("replay");

  // Track when charts are loaded
  const [chartsReady, setChartsReady] = useState(false);

  // Hide the SSR preview once the interactive charts are actually ready.
  // We wait for a custom event from the chart components, or a reasonable timeout.
  useEffect(() => {
    const hidePreview = () => {
      const preview = document.getElementById("ssr-preview");
      if (preview) {
        preview.style.transition = "opacity 0.3s ease-out";
        preview.style.opacity = "0";
        setTimeout(() => {
          preview.style.display = "none";
        }, 300);
      }
    };

    // Listen for charts-ready event from chart components
    const handleChartsReady = () => {
      setChartsReady(true);
      hidePreview();
    };

    window.addEventListener("charts-ready", handleChartsReady);
    
    // Fallback: hide after charts should be loaded (but keep preview longer)
    const fallbackTimer = setTimeout(() => {
      if (!chartsReady) {
        hidePreview();
      }
    }, 8000); // 8 second fallback - charts should be loaded by then

    return () => {
      window.removeEventListener("charts-ready", handleChartsReady);
      clearTimeout(fallbackTimer);
    };
  }, [chartsReady]);

  // Compute cmeStatus here so it's available immediately when toggling to live —
  // DashboardClient receives it as a prop and renders the hero on frame 1.
  const [cmeStatus, setCmeStatus] = useState<CMEStatus>(() => getCMEStatus());
  useEffect(() => {
    const interval = setInterval(() => setCmeStatus(getCMEStatus()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Prefetch the live snapshot on mount, in parallel with the replay session.
  // By the time anyone toggles to Live — even 2 seconds after page load — the
  // browser has already received the data and DashboardClient can render frame 1
  // with real values instead of showing "Awaiting".
  const [prefetchedPayload, setPrefetchedPayload] = useState<BootstrapPayload | null>(null);
  useEffect(() => {
    fetch("/api/live-snapshot")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          (data as BootstrapPayload).ok === true &&
          Array.isArray((data as BootstrapPayload).observations)
        ) {
          setPrefetchedPayload(data as BootstrapPayload);
        }
      })
      .catch(() => {});
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
          initialPayload={prefetchedPayload}
          initialSlug={initialSlug}
          onToggleAppMode={toggleMode}
          cmeStatus={cmeStatus}
        />
      </div>
      <div style={{ display: appMode === "replay" ? "contents" : "none" }}>
        <ReplayClient
          appMode="replay"
          onToggleAppMode={toggleMode}
          initialSessionData={initialReplayData?.sessionData ?? null}
          initialSessions={initialReplayData?.sessions ?? []}
        />
      </div>
    </>
  );
}

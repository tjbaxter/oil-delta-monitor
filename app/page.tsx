import { readFile } from "node:fs/promises";
import path from "node:path";

import DashboardShell from "@/components/dashboard/DashboardShell";
import ReplayPreview from "@/components/dashboard/ReplayPreview";
import { DEFAULT_MARKET_SLUG, DEFAULT_MONITOR_MODE } from "@/lib/constants";
import type { ReplayPayload, SessionListItem } from "@/lib/types";

async function getInitialReplayData(): Promise<{
  sessionData: ReplayPayload | null;
  sessions: SessionListItem[];
}> {
  try {
    const filePath = path.join(process.cwd(), "public", "replay", "default-session.json");
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as ReplayPayload;

    if (data && data.ok === true && Array.isArray(data.observations)) {
      const defaultSession: SessionListItem = {
        id: data.sessionId,
        label: data.crudeSubLabel.replace("Historical recording — ", ""),
        curated: true,
        default: true,
        sessionStartedAt: data.sessionStartedAt,
        crudeRange: null,
        observationCount: data.observations.length,
        startTs: null,
        endTs: null,
        animationStartTs: null
      };
      return { sessionData: data, sessions: [defaultSession] };
    }
  } catch {
    // File doesn't exist or is invalid - ReplayClient will fetch on mount
  }
  return { sessionData: null, sessions: [] };
}

export default async function HomePage() {
  const initialReplayData = await getInitialReplayData();

  return (
    <main>
      {/*
        SSR Preview: Server-rendered static snapshot that displays IMMEDIATELY
        in the initial HTML, before any JavaScript loads. This eliminates the
        blank screen problem - users see actual data within milliseconds.
        
        The preview is positioned absolute and stays visible until the Plotly
        charts are ready, then fades out smoothly.
      */}
      {initialReplayData.sessionData && (
        <div 
          id="ssr-preview"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            background: "var(--bg, #05080f)",
            overflow: "auto"
          }}
        >
          <div style={{ padding: "14px 16px 18px" }}>
            <ReplayPreview
              sessionData={initialReplayData.sessionData}
              animationStartIndex={initialReplayData.sessionData.animationStartIndex ?? undefined}
            />
          </div>
        </div>
      )}
      
      {/* Interactive client shell - renders behind preview, takes over when ready */}
      <DashboardShell
        initialMode={DEFAULT_MONITOR_MODE}
        initialSlug={DEFAULT_MARKET_SLUG}
        initialReplayData={initialReplayData}
      />
    </main>
  );
}

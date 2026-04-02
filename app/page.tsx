import DashboardShell from "@/components/dashboard/DashboardShell";
import {
  DEFAULT_MONITOR_MODE,
  DEFAULT_DELTA_GAP_THRESHOLD,
  DEFAULT_FAIR_GAP_THRESHOLD,
  DEFAULT_IMPLIED_VOL,
  DEFAULT_MARKET_SLUG,
  DEFAULT_RISK_FREE_RATE,
  DEFAULT_ROLLING_WINDOW,
  DEFAULT_SPREAD_WIDTH,
  DEFAULT_STRIKE
} from "@/lib/constants";
import { getDefaultProviderMode } from "@/lib/crude";
import { readLiveSnapshotFromDisk } from "@/lib/liveSnapshot";
import { buildBootstrapPayload } from "@/lib/polymarket";
import type { BootstrapPayload } from "@/lib/types";

const INITIAL_SNAPSHOT_TIMEOUT_MS = 150;

// Default to "replay" so visitors see compelling market data immediately.
// Set NEXT_PUBLIC_DEFAULT_APP_MODE=live in .env.local to override.
const DEFAULT_APP_MODE: "live" | "replay" =
  process.env.NEXT_PUBLIC_DEFAULT_APP_MODE === "live" ? "live" : "replay";

async function getInitialPayload(slug: string): Promise<BootstrapPayload | null> {
  const bootstrapPromise = buildBootstrapPayload({
    slug,
    providerMode: getDefaultProviderMode(),
    manualCrudePrice: null,
    strike: DEFAULT_STRIKE,
    spreadWidth: DEFAULT_SPREAD_WIDTH,
    impliedVol: DEFAULT_IMPLIED_VOL,
    riskFreeRate: DEFAULT_RISK_FREE_RATE,
    rollingWindow: DEFAULT_ROLLING_WINDOW,
    fairGapThreshold: DEFAULT_FAIR_GAP_THRESHOLD,
    deltaGapThreshold: DEFAULT_DELTA_GAP_THRESHOLD,
    expiryOverride: null
  }).catch(() => null);

  const timeoutPromise = new Promise<BootstrapPayload | null>((resolve) => {
    setTimeout(() => resolve(null), INITIAL_SNAPSHOT_TIMEOUT_MS);
  });

  return Promise.race([bootstrapPromise, timeoutPromise]);
}

export default async function HomePage() {
  const initialSlug = DEFAULT_MARKET_SLUG;
  const initialMode = DEFAULT_MONITOR_MODE;

  // Only pre-fetch live payload for SSR if defaulting to live mode,
  // to avoid unnecessary work when replay is the default.
  const initialPayload =
    DEFAULT_APP_MODE === "live"
      ? initialMode === "live"
        ? await readLiveSnapshotFromDisk()
        : initialSlug
          ? await getInitialPayload(initialSlug)
          : null
      : null;

  return (
    <main>
      <DashboardShell
        defaultAppMode={DEFAULT_APP_MODE}
        initialError={initialSlug ? null : "Missing default market slug."}
        initialMode={initialMode}
        initialPayload={initialPayload}
        initialSlug={initialSlug}
      />
    </main>
  );
}

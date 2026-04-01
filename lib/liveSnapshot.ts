import { readFile } from "node:fs/promises";
import path from "node:path";

import { LIVE_PRESENTATION_WINDOW_MS, LIVE_SNAPSHOT_RELATIVE_PATH } from "@/lib/constants";
import type { ApiErrorPayload, BootstrapPayload } from "@/lib/types";

const LIVE_SNAPSHOT_PATH = path.join(process.cwd(), LIVE_SNAPSHOT_RELATIVE_PATH);

function isLiveSnapshotPayload(value: unknown): value is BootstrapPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as BootstrapPayload).ok === true &&
      (value as BootstrapPayload).mode === "live" &&
      Array.isArray((value as BootstrapPayload).observations) &&
      typeof (value as BootstrapPayload).generatedAt === "string"
  );
}

export function buildMissingLiveSnapshotPayload(message?: string): ApiErrorPayload {
  return {
    ok: false,
    code: "LIVE_SNAPSHOT_MISSING",
    error:
      message ||
      "Live snapshot not available. Start `python3 services/live_ingestor/main.py` first."
  };
}

/**
 * Trims polyHistory, crudeHistory, and observations to the given window (ms from now).
 * This is the critical payload-size fix: the backend may store more history than the
 * frontend needs to display. We trim here so neither SSR nor the API route sends
 * stale data that the client will discard anyway.
 */
export function trimSnapshotToWindow(
  snapshot: BootstrapPayload,
  windowMs: number
): BootstrapPayload {
  const nowMs = Date.now();
  const cutoff = nowMs - windowMs;

  return {
    ...snapshot,
    polyHistory: snapshot.polyHistory.filter((p) => p.timestamp >= cutoff),
    crudeHistory: snapshot.crudeHistory.filter((p) => p.timestamp >= cutoff),
    observations: snapshot.observations.filter((o) => o.timestamp >= cutoff)
  };
}

export async function readLiveSnapshotFromDisk(): Promise<BootstrapPayload | null> {
  try {
    const raw = await readFile(LIVE_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isLiveSnapshotPayload(parsed)) {
      return null;
    }
    // Trim to the presentation window + 5 min safety margin so the server never
    // forwards stale history that the client will immediately discard anyway.
    return trimSnapshotToWindow(parsed, LIVE_PRESENTATION_WINDOW_MS + 5 * 60 * 1000);
  } catch {
    return null;
  }
}

export function getLiveSnapshotPath(): string {
  return LIVE_SNAPSHOT_PATH;
}

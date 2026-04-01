import { NextResponse } from "next/server";

import {
  buildMissingLiveSnapshotPayload,
  readLiveSnapshotFromDisk,
  trimSnapshotToWindow
} from "@/lib/liveSnapshot";
import { LIVE_PRESENTATION_WINDOW_MS } from "@/lib/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 5;

const LIVE_SNAPSHOT_CACHE_CONTROL = "no-store, max-age=0, must-revalidate";

export async function GET() {
  const snapshot = await readLiveSnapshotFromDisk();
  if (!snapshot) {
    return NextResponse.json(buildMissingLiveSnapshotPayload(), {
      status: 503,
      headers: {
        "Cache-Control": LIVE_SNAPSHOT_CACHE_CONTROL
      }
    });
  }

  const trimmed = trimSnapshotToWindow(snapshot, LIVE_PRESENTATION_WINDOW_MS + 5 * 60 * 1000);

  return NextResponse.json(trimmed, {
    headers: {
      "Cache-Control": LIVE_SNAPSHOT_CACHE_CONTROL
    }
  });
}

import { NextResponse } from "next/server";

import {
  buildMissingLiveSnapshotPayload,
  readLiveSnapshotFromDisk
} from "@/lib/liveSnapshot";

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

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": LIVE_SNAPSHOT_CACHE_CONTROL
    }
  });
}

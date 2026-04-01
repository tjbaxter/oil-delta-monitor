import { readFile } from "node:fs/promises";
import path from "node:path";

import { LIVE_SNAPSHOT_RELATIVE_PATH } from "@/lib/constants";
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

export async function readLiveSnapshotFromDisk(): Promise<BootstrapPayload | null> {
  try {
    const raw = await readFile(LIVE_SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isLiveSnapshotPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getLiveSnapshotPath(): string {
  return LIVE_SNAPSHOT_PATH;
}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import type { CuratedSession, SessionListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");
const CURATED_PATH = path.join(process.cwd(), "data", "curated.json");

// Session IDs explicitly hidden from the dropdown (too short, uninteresting, etc.)
const EXCLUDED_IDS = new Set(["20260401_143133"]);

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

export async function GET() {
  try {
    const [sessionDirs, curatedRaw] = await Promise.all([
      readdir(SESSIONS_DIR).catch(() => [] as string[]),
      readJsonFile<CuratedSession[]>(CURATED_PATH)
    ]);

    const curated = curatedRaw ?? [];
    const validDirs = new Set(
      sessionDirs.filter((id) => /^\d{8}_\d{6}$/.test(id))
    );

    // Fetch metadata + obs count once per unique session dir
    const dirMeta = new Map<string, { sessionStartedAt: string | null; obsCount: number }>();
    await Promise.all(
      Array.from(validDirs).map(async (id) => {
        const sessionDir = path.join(SESSIONS_DIR, id);
        const [metadata, obsCount] = await Promise.all([
          readJsonFile<Record<string, unknown>>(path.join(sessionDir, "metadata.json")),
          countLines(path.join(sessionDir, "observations.jsonl"))
        ]);
        dirMeta.set(id, {
          sessionStartedAt: typeof metadata?.sessionStartedAt === "string"
            ? metadata.sessionStartedAt
            : null,
          obsCount
        });
      })
    );

    // Curated entries come first — one dropdown item per curated entry (allows same
    // session ID with different clip windows to appear as separate dropdown options)
    const curatedIds = new Set(curated.map((c) => c.id));
    const curatedItems: SessionListItem[] = curated
      .filter((c) => validDirs.has(c.id) && (dirMeta.get(c.id)?.obsCount ?? 0) >= 300)
      .map((c): SessionListItem => ({
        id: c.id,
        label: c.label,
        curated: true,
        default: c.default ?? false,
        sessionStartedAt: dirMeta.get(c.id)?.sessionStartedAt ?? null,
        crudeRange: null,
        observationCount: dirMeta.get(c.id)?.obsCount ?? 0,
        startTs: c.startTs ?? null,
        endTs: c.endTs ?? null,
        animationStartTs: c.animationStartTs ?? null
      }));

    // Non-curated sessions (not mentioned in curated.json at all) appended after
    const uncuratedItems: SessionListItem[] = Array.from(validDirs)
      .filter((id) => !curatedIds.has(id) && !EXCLUDED_IDS.has(id) && (dirMeta.get(id)?.obsCount ?? 0) >= 300)
      .sort((a, b) => b.localeCompare(a))
      .map((id): SessionListItem => ({
        id,
        label: `Session ${id.slice(0, 8)} ${id.slice(9)}`,
        curated: false,
        default: false,
        sessionStartedAt: dirMeta.get(id)?.sessionStartedAt ?? null,
        crudeRange: null,
        observationCount: dirMeta.get(id)?.obsCount ?? 0,
        startTs: null,
        endTs: null,
        animationStartTs: null
      }));

    return NextResponse.json([...curatedItems, ...uncuratedItems]);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}

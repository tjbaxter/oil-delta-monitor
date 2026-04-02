import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import type { CuratedSession, SessionListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");
const CURATED_PATH = path.join(process.cwd(), "data", "curated.json");

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
    const curatedMap = new Map(curated.map((c) => [c.id, c]));
    const curatedIds = new Set(curated.map((c) => c.id));

    const sessions = await Promise.all(
      sessionDirs
        .filter((id) => /^\d{8}_\d{6}$/.test(id))
        .map(async (id): Promise<SessionListItem | null> => {
          try {
            const sessionDir = path.join(SESSIONS_DIR, id);
            const [metadata, obsCount] = await Promise.all([
              readJsonFile<Record<string, unknown>>(path.join(sessionDir, "metadata.json")),
              countLines(path.join(sessionDir, "observations.jsonl"))
            ]);

            const curatedEntry = curatedMap.get(id);

            return {
              id,
              label: curatedEntry?.label ?? `Session ${id.replace("_", " ")}`,
              curated: curatedIds.has(id),
              default: curatedEntry?.default ?? false,
              sessionStartedAt:
                typeof metadata?.sessionStartedAt === "string"
                  ? metadata.sessionStartedAt
                  : null,
              crudeRange: null,
              observationCount: obsCount
            };
          } catch {
            return null;
          }
        })
    );

    const validSessions = sessions
      .filter((s): s is SessionListItem => s !== null && s.observationCount >= 300)
      .sort((a, b) => {
        if (a.default && !b.default) return -1;
        if (!a.default && b.default) return 1;
        return b.id.localeCompare(a.id);
      });

    return NextResponse.json(validSessions);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500 }
    );
  }
}

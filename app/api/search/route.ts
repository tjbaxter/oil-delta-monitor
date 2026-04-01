import { NextResponse } from "next/server";

import { searchOilChildMarkets } from "@/lib/polymarket";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";

  if (!query) {
    return NextResponse.json({ ok: true, results: [] });
  }

  try {
    const results = await searchOilChildMarkets(query);
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        code: "SEARCH_FAILED",
        error:
          error instanceof Error ? error.message : "Search failed."
      },
      { status: 500 }
    );
  }
}

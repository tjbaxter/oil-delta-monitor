import { NextResponse } from "next/server";

import { getMarketMetaBySlug } from "@/lib/polymarket";
import type { ApiErrorPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;

  try {
    const market = await getMarketMetaBySlug(slug);
    return NextResponse.json({ ok: true, market });
  } catch (error) {
    const payload: ApiErrorPayload = {
      ok: false,
      code: "MARKET_NOT_FOUND",
      error:
        error instanceof Error ? error.message : "Market lookup failed."
    };

    return NextResponse.json(payload, { status: 404 });
  }
}

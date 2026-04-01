import { NextResponse } from "next/server";

import { fetchCrudeData } from "@/lib/crude";

export const dynamic = "force-dynamic";

function parseManualValue(raw: string | null): number | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const providerMode = url.searchParams.get("mode");
  const manualValue = parseManualValue(url.searchParams.get("manualValue"));

  try {
    const crude = await fetchCrudeData({ providerMode, manualValue });
    return NextResponse.json({ ok: true, ...crude });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        code: "CRUDE_PROVIDER_FAILED",
        error:
          error instanceof Error ? error.message : "Crude provider failed."
      },
      { status: 500 }
    );
  }
}

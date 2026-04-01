import {
  DATA_REVALIDATE_SECONDS,
  DATABENTO_DATASET,
  DATABENTO_HISTORICAL_URL,
  DATABENTO_LOOKBACK_HOURS,
  DATABENTO_METADATA_URL,
  DATABENTO_SCHEMA,
  DATABENTO_SYMBOL,
  DEFAULT_CRUDE_PROVIDER
} from "@/lib/constants";
import type { CrudePayload, ProviderMode } from "@/lib/types";

const DATABENTO_LABEL = "CME CL.c.0 (Databento)";
const DATABENTO_SUBLABEL = "T+1 Delayed Intraday";

interface DatabentoRange {
  windowStartTs: number | null;
  windowEndTs: number | null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDatabentoPrice(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null) {
    return null;
  }

  return Math.abs(parsed) >= 1_000_000 ? parsed / 1_000_000_000 : parsed;
}

function parseProviderMode(raw: string | null | undefined): ProviderMode {
  return raw === "manual" ? "manual" : "databento_cl_c_0_1m";
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e18) {
      return Math.floor(value / 1e6);
    }
    if (value > 1e15) {
      return Math.floor(value / 1e3);
    }
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }

  if (typeof value !== "string") {
    return null;
  }

  const clean = value.trim();
  if (!clean) {
    return null;
  }

  if (/^\d+$/.test(clean)) {
    try {
      const raw = BigInt(clean);
      if (raw > 1_000_000_000_000_000_000n) {
        return Number(raw / 1_000_000n);
      }
      if (raw > 1_000_000_000_000_000n) {
        return Number(raw / 1_000n);
      }
      if (raw > 1_000_000_000_000n) {
        return Number(raw);
      }
      return Number(raw) * 1000;
    } catch {
      return null;
    }
  }

  const normalizedIso = clean.replace(/\.(\d{3})\d+Z$/, ".$1Z");
  const parsed = Date.parse(normalizedIso);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildDatabentoHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    Accept: "application/json"
  };
}

function emptyCrudePayload(warnings: string[]): CrudePayload {
  return {
    providerMode: "databento_cl_c_0_1m",
    currentPrice: null,
    history: [],
    label: DATABENTO_LABEL,
    subLabel: DATABENTO_SUBLABEL,
    isProxy: false,
    windowStartTs: null,
    windowEndTs: null,
    warnings
  };
}

function buildDatabentoTimeseriesUrl(windowStartTs: number, windowEndTs: number): URL {
  const url = new URL(DATABENTO_HISTORICAL_URL);
  url.searchParams.set("dataset", DATABENTO_DATASET);
  url.searchParams.set("symbols", DATABENTO_SYMBOL);
  url.searchParams.set("stype_in", "continuous");
  url.searchParams.set("schema", DATABENTO_SCHEMA);
  url.searchParams.set("start", new Date(windowStartTs).toISOString());
  url.searchParams.set("end", new Date(windowEndTs).toISOString());
  url.searchParams.set("encoding", "json");
  return url;
}

function extractJsonLikeRows(
  payload: unknown,
  depth = 0
): Array<Record<string, unknown>> {
  if (depth > 4) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.filter(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object"
    );
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  if (
    ("ts_event" in record || ("hd" in record && typeof record.hd === "object")) &&
    "close" in record
  ) {
    return [record];
  }

  for (const key of ["data", "records", "result", "results", "items"]) {
    const rows = extractJsonLikeRows(record[key], depth + 1);
    if (rows.length) {
      return rows;
    }
  }

  return [];
}

function normalizeDatabentoRows(
  rows: Array<Record<string, unknown>>
): Array<{ timestamp: number; price: number }> {
  return rows
    .map((row) => {
      const header =
        row.hd && typeof row.hd === "object" ? (row.hd as Record<string, unknown>) : null;
      const timestamp = parseTimestampMs(header?.ts_event ?? row.ts_event);
      const price = normalizeDatabentoPrice(row.close);
      if (timestamp === null || price === null) {
        return null;
      }
      return { timestamp, price };
    })
    .filter((point): point is { timestamp: number; price: number } => point !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function parseJsonlRows(rawText: string): Array<Record<string, unknown>> {
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((row): row is Record<string, unknown> => row !== null);
}

function extractAvailableEnd(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const detail =
      parsed.detail && typeof parsed.detail === "object"
        ? (parsed.detail as Record<string, unknown>)
        : null;
    const payload =
      detail?.payload && typeof detail.payload === "object"
        ? (detail.payload as Record<string, unknown>)
        : null;
    const explicitEnd = payload?.available_end ?? detail?.available_end;
    return parseTimestampMs(explicitEnd);
  } catch {
    const messageMatch = text.match(/available up to '([^']+)'/);
    if (messageMatch) {
      return parseTimestampMs(messageMatch[1]);
    }
    const beforeMatch = text.match(/before ([0-9T:\-.+Z]+)/);
    return beforeMatch ? parseTimestampMs(beforeMatch[1]) : null;
  }
}

function extractRangeFromMetadata(payload: unknown): DatabentoRange {
  if (!payload || typeof payload !== "object") {
    return { windowStartTs: null, windowEndTs: null };
  }

  const record = payload as Record<string, unknown>;
  const schema =
    record.schema && typeof record.schema === "object"
      ? (record.schema as Record<string, unknown>)
      : null;
  const schemaRange =
    schema?.[DATABENTO_SCHEMA] && typeof schema[DATABENTO_SCHEMA] === "object"
      ? (schema[DATABENTO_SCHEMA] as Record<string, unknown>)
      : null;

  // Prefer the schema-specific timestamps because they are the most explicit
  // entitlement bounds for the exact `ohlcv-1m` query we are about to issue.
  const datasetStartTs = parseTimestampMs(schemaRange?.start ?? record.start);
  const datasetEndTs = parseTimestampMs(schemaRange?.end ?? record.end);

  if (datasetEndTs === null) {
    return { windowStartTs: null, windowEndTs: null };
  }

  const lookbackStartTs = datasetEndTs - DATABENTO_LOOKBACK_HOURS * 60 * 60 * 1000;
  return {
    windowStartTs:
      datasetStartTs !== null ? Math.max(datasetStartTs, lookbackStartTs) : lookbackStartTs,
    windowEndTs: datasetEndTs
  };
}

async function fetchEntitledDatabentoRange(apiKey: string): Promise<DatabentoRange | null> {
  const url = new URL(DATABENTO_METADATA_URL);
  url.searchParams.set("dataset", DATABENTO_DATASET);

  const response = await fetch(url, {
    next: { revalidate: DATA_REVALIDATE_SECONDS },
    headers: buildDatabentoHeaders(apiKey)
  });

  if (!response.ok) {
    return null;
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const range = extractRangeFromMetadata(payload);
  return range.windowStartTs !== null && range.windowEndTs !== null ? range : null;
}

async function fetchDatabentoHistory(apiKey: string): Promise<CrudePayload> {
  const initialRange = await fetchEntitledDatabentoRange(apiKey);
  if (!initialRange?.windowStartTs || !initialRange.windowEndTs) {
    return emptyCrudePayload([
      "CME Entitlement Error: verify API key and dataset range."
    ]);
  }

  let activeRange = {
    windowStartTs: initialRange.windowStartTs!,
    windowEndTs: initialRange.windowEndTs!
  };
  let url = buildDatabentoTimeseriesUrl(activeRange.windowStartTs, activeRange.windowEndTs);
  let response = await fetch(url, {
    next: { revalidate: DATA_REVALIDATE_SECONDS },
    headers: buildDatabentoHeaders(apiKey)
  });
  let responseBody = response.ok ? "" : (await response.text()).trim();

  if (!response.ok && response.status === 422) {
    const availableEndTs = extractAvailableEnd(responseBody);
    if (availableEndTs !== null) {
      activeRange = {
        windowEndTs: availableEndTs,
        windowStartTs:
          availableEndTs - DATABENTO_LOOKBACK_HOURS * 60 * 60 * 1000
      };
      url = buildDatabentoTimeseriesUrl(activeRange.windowStartTs, activeRange.windowEndTs);
      response = await fetch(url, {
        next: { revalidate: DATA_REVALIDATE_SECONDS },
        headers: buildDatabentoHeaders(apiKey)
      });
      responseBody = response.ok ? "" : (await response.text()).trim();
    }
  }

  if (!response.ok) {
    return emptyCrudePayload([
      `CME Historical Error: unable to load delayed CL.c.0 bars (${response.status}).`
    ]);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const rawText = await response.text();

  let history: Array<{ timestamp: number; price: number }> = [];
  if (contentType.includes("jsonl") || contentType.includes("ndjson")) {
    history = normalizeDatabentoRows(parseJsonlRows(rawText));
  } else {
    let payload: unknown = null;
    try {
      payload = JSON.parse(rawText) as unknown;
    } catch {
      payload = null;
    }
    history = normalizeDatabentoRows(extractJsonLikeRows(payload));
  }

  history = history.map((point) => ({
    ...point,
    midpoint: null,
    bid: null,
    ask: null,
    lastTrade: null,
    markSource: "close" as const,
    seededFrom: "historical_seed" as const
  }));

  if (!history.length) {
    return emptyCrudePayload([
      "CME Historical Error: delayed CL.c.0 window returned no bars."
    ]);
  }

  return {
    providerMode: "databento_cl_c_0_1m",
    currentPrice: history[history.length - 1].price,
    history,
    label: DATABENTO_LABEL,
    subLabel: DATABENTO_SUBLABEL,
    isProxy: false,
    windowStartTs: activeRange.windowStartTs,
    windowEndTs: activeRange.windowEndTs,
    warnings: []
  };
}

export function getDefaultProviderMode(): ProviderMode {
  return DEFAULT_CRUDE_PROVIDER;
}

export async function fetchCrudeData(params: {
  providerMode?: string | null;
  manualValue?: number | null;
}): Promise<CrudePayload> {
  const providerMode = parseProviderMode(params.providerMode);

  if (providerMode === "manual") {
    const currentPrice =
      typeof params.manualValue === "number" &&
      Number.isFinite(params.manualValue) &&
      params.manualValue > 0
        ? params.manualValue
        : null;

    return {
      providerMode,
      currentPrice,
      history: [],
      label: DATABENTO_LABEL,
      subLabel: DATABENTO_SUBLABEL,
      isProxy: false,
      windowStartTs: null,
      windowEndTs: null,
      warnings:
        currentPrice === null
          ? ["CME Entitlement Error: verify API key and dataset range."]
          : ["Manual crude input is disabled in delayed mode."]
    };
  }

  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    return emptyCrudePayload([
      "CME Entitlement Error: add DATABENTO_API_KEY to .env.local."
    ]);
  }

  return fetchDatabentoHistory(apiKey);
}

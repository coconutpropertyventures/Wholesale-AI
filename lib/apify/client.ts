// Apify REST client for listing data.
// NOTE: Actor access here uses Apify's REST run-sync endpoint; the same
// Actors are exposed to agents through Apify MCP (mcp.apify.com). Inside
// this web app the direct REST call is the stable transport — no MCP
// session to babysit per request.
// The token lives ONLY in process.env.APIFY_TOKEN (server-side). When it
// is absent, apifyConfigured() is false and callers must say so plainly —
// this client never fabricates listing data.
import { mapApifyRow, mapRedfinRow, type DealPrefill } from "@/lib/deals/prefill";

const APIFY_BASE = "https://api.apify.com/v2";
const RUN_TIMEOUT_MS = 110_000;

export function apifyConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN?.trim());
}

export function zillowActorId(): string {
  return process.env.APIFY_ZILLOW_ACTOR?.trim() || "maxcopell/zillow-detail-scraper";
}

export function redfinActorId(): string {
  return process.env.APIFY_REDFIN_ACTOR?.trim() || "tri_angle/redfin-search";
}

type RawRow = Record<string, unknown>;

/**
 * Run an Actor synchronously and return its dataset rows.
 * Actor IDs are "username/name"; the API path wants "username~name".
 * Inputs are merged defensively: different Actors read different keys
 * (locations / startUrls / search / url), and unknown keys are ignored.
 */
export async function runActorSync(
  actorId: string,
  input: Record<string, unknown>,
): Promise<RawRow[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error("Apify is not configured: APIFY_TOKEN is not set.");
  const pathId = actorId.replace("/", "~");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${APIFY_BASE}/acts/${pathId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: "no-store",
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Apify run failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? (parsed as RawRow[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Single-listing lookup for a pasted Zillow/Redfin link (or its address). */
export async function lookupListing(input: {
  url?: string;
  address?: string;
}): Promise<DealPrefill | null> {
  const merged: Record<string, unknown> = { maxItems: 1, propertyDetails: true };
  if (input.url) {
    merged.startUrls = [{ url: input.url }];
    merged.urls = [input.url];
    merged.url = input.url;
  }
  if (input.address) {
    merged.locations = [input.address];
    merged.addresses = [input.address];
    merged.search = input.address;
  }
  const rows = await runActorSync(zillowActorId(), merged);
  if (rows.length === 0) return null;
  const prefill = mapApifyRow(rows[0]);
  if (!prefill.sourceUrl && input.url) prefill.sourceUrl = input.url;
  return prefill;
}

/** Redfin search for a city / ZIP / address query. Returns mapped rows. */
export async function searchRedfin(
  query: string,
  maxItems = 20,
): Promise<DealPrefill[]> {
  const rows = await runActorSync(redfinActorId(), {
    search: query,
    query,
    keyword: query,
    maxItems,
    maxResults: maxItems,
  });
  return rows.map(mapRedfinRow).filter((p) => p.address || p.listPrice);
}

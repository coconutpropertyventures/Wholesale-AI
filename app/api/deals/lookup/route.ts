import { NextResponse, type NextRequest } from "next/server";
import { parseListingUrl } from "@/lib/deals/parse";
import { apifyConfigured, lookupListing } from "@/lib/apify/client";
import {
  getCachedPrefill,
  putCachedPrefill,
} from "@/lib/deals/cache";
import type { DealPrefill } from "@/lib/deals/prefill";

export const dynamic = "force-dynamic";

// POST /api/deals/lookup  { url }
// Parses the address out of a Zillow/Redfin link, then prefills listing
// data cache-first (7 days) and via Apify on a miss. RentCast is never
// used here. Without APIFY_TOKEN: { ok: true, configured: false,
// prefill: <address only from the URL> }.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, reason: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json(
      { ok: false, reason: "A listing url is required." },
      { status: 400 },
    );
  }
  const parsed = parseListingUrl(url);
  if (!parsed.address) {
    return NextResponse.json({
      ok: false,
      reason:
        "Could not read an address from that link. Paste a Zillow or Redfin listing URL.",
    });
  }

  const cached = await getCachedPrefill(parsed.address, 7);
  if (cached) {
    return NextResponse.json({
      ok: true,
      configured: apifyConfigured(),
      cached: true,
      prefill: cached.prefill,
    });
  }

  if (!apifyConfigured()) {
    const prefill: DealPrefill = {
      address: parsed.address,
      city: parsed.city,
      state: parsed.state,
      zip: parsed.zip,
      sourceUrl: url,
      source: parsed.source === "redfin" ? "redfin" : "zillow",
    };
    return NextResponse.json({ ok: true, configured: false, prefill });
  }

  try {
    const found = await lookupListing({ url, address: parsed.address });
    if (!found) {
      const prefill: DealPrefill = {
        address: parsed.address,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
        sourceUrl: url,
        source: parsed.source === "redfin" ? "redfin" : "zillow",
      };
      return NextResponse.json({ ok: true, configured: true, found: false, prefill });
    }
    const prefill: DealPrefill = {
      ...found,
      address: found.address ?? parsed.address,
      sourceUrl: found.sourceUrl ?? url,
    };
    await putCachedPrefill(parsed.address, prefill, "apify");
    return NextResponse.json({ ok: true, configured: true, found: true, prefill });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason: `Listing lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

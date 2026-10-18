import { NextResponse, type NextRequest } from "next/server";
import { apifyConfigured, searchRedfin } from "@/lib/apify/client";
import { putCachedPrefill } from "@/lib/deals/cache";
import {
  parseSearchFilters,
  selectSearchResults,
} from "@/lib/deals/searchFilters";

export const dynamic = "force-dynamic";

// POST /api/deals/search  { query, filters? }
// Runs the Redfin search Actor for a city / ZIP / address query and
// returns normalized result cards. Optional filters (min/max price,
// min DOM, min beds, min baths) are applied to the pulled rows HERE,
// before the display slice — filtering never costs another pull.
// Every displayed result is written into the property cache so "Run
// underwriting" on a card is an instant lookup, never a second paid
// pull. Without APIFY_TOKEN: configured:false.
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
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { ok: false, reason: "A search query (city, ZIP, or address) is required." },
      { status: 400 },
    );
  }
  if (!apifyConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      results: [],
      totalReturned: 0,
      totalMatched: 0,
    });
  }
  const filters = parseSearchFilters(body.filters);
  try {
    // A fresh Actor run is performed for the query itself so the list is
    // current; each displayed result is cached per property so loading
    // it into the workbench never costs a second pull. The Apify client
    // caps the run itself at MAX_APIFY_ITEMS_PER_RUN (500) rows.
    // Filters then narrow the pulled rows BEFORE the 100-row display
    // slice, and the response reports both honest totals:
    // `totalReturned` (rows actually pulled, post-cap) and
    // `totalMatched` (rows surviving the filters).
    const all = await searchRedfin(query);
    const { results, totalMatched, totalReturned } = selectSearchResults(
      all,
      filters,
    );
    await Promise.all(
      results
        .filter((r) => r.address)
        .map((r) => putCachedPrefill(r.address as string, r, "apify")),
    );
    return NextResponse.json({
      ok: true,
      configured: true,
      results,
      totalReturned,
      totalMatched,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason: `Redfin search failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

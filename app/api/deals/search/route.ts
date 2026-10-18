import { NextResponse, type NextRequest } from "next/server";
import { apifyConfigured, searchRedfin } from "@/lib/apify/client";
import { putCachedPrefill } from "@/lib/deals/cache";

export const dynamic = "force-dynamic";

// POST /api/deals/search  { query }
// Runs the Redfin search Actor for a city / ZIP / address query and
// returns normalized result cards. Every result is written into the
// property cache so "Run underwriting" on a card is an instant lookup,
// never a second paid pull. Without APIFY_TOKEN: configured:false.
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
    return NextResponse.json({ ok: true, configured: false, results: [] });
  }
  try {
    // A fresh Actor run is performed for the query itself so the list is
    // current; each result is cached per property so loading it into the
    // workbench never costs a second pull.
    const results = await searchRedfin(query);
    await Promise.all(
      results
        .filter((r) => r.address)
        .map((r) => putCachedPrefill(r.address as string, r, "apify")),
    );
    return NextResponse.json({ ok: true, configured: true, results });
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

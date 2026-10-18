import { NextResponse, type NextRequest } from "next/server";
import { getCachedPrefill } from "@/lib/deals/cache";

export const dynamic = "force-dynamic";

// GET /api/deals/photos?address=...
// Cache-ONLY read for the workbench hover preview: returns the
// listing photos stored on the property's cached record (written when
// a detail pull ran — Run Underwriting, blast enrichment, or an
// earlier hover). This route NEVER calls Apify: when no detail record
// with photos is cached it answers photos: [] and lets the client
// decide whether the property is worth its one on-demand detail pull
// (POST /api/deals/detail).
const PHOTOS_TTL_DAYS = 30;

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.trim() ?? "";
  if (!address) {
    return NextResponse.json(
      { ok: false, reason: "A property address is required." },
      { status: 400 },
    );
  }
  const hit = await getCachedPrefill(address, PHOTOS_TTL_DAYS);
  const photos = (hit?.prefill.photos ?? []).filter(
    (u): u is string => typeof u === "string" && u.startsWith("http"),
  );
  return NextResponse.json({
    ok: true,
    photos,
    // True only when a cached record actually carries photos — the
    // hover uses this to distinguish "known photos" from "not pulled
    // yet / pulled with none".
    cached: photos.length > 0,
  });
}

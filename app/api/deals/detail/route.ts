import { NextResponse, type NextRequest } from "next/server";
import {
  apifyConfigured,
  fetchRedfinDetailPrefill,
  lookupListing,
} from "@/lib/apify/client";
import { getCachedPrefill, putCachedPrefill } from "@/lib/deals/cache";
import {
  fillMissingPrefill,
  type DealPrefill,
} from "@/lib/deals/prefill";

export const dynamic = "force-dynamic";

// POST /api/deals/detail  { address, sourceUrl?, prefill? }
// The workbench's "fullest record" merge behind Run Underwriting:
//   1. Start from the record the client already has (the search card /
//      lookup prefill it passes in).
//   2. Merge the cached record for the address (fill-blanks only —
//      fresher values are never overwritten).
//   3. If key fields are STILL missing, pull the listing's DETAIL
//      record once — Redfin URLs via the memo23 detail Actor, other
//      (Zillow) URLs via the existing detail lookup — and merge again.
//   4. Cache the merged record with source tag "apify-detail" so the
//      detail pull is paid for once per property.
// Fields no source carries stay absent — nothing is invented here.

const KEY_DETAIL_FIELDS: (keyof DealPrefill)[] = [
  "yearBuilt",
  "sqft",
  "beds",
  "baths",
  "hoaMonthly",
  "annualTaxes",
  "rentEstimate",
  "valueEstimate",
];

const SUBJECT_TTL_DAYS = 30;

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
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address) {
    return NextResponse.json(
      { ok: false, reason: "A property address is required." },
      { status: 400 },
    );
  }
  const sourceUrl =
    typeof body.sourceUrl === "string" && body.sourceUrl.trim()
      ? body.sourceUrl.trim()
      : undefined;
  const passed =
    body.prefill && typeof body.prefill === "object" && !Array.isArray(body.prefill)
      ? (body.prefill as DealPrefill)
      : undefined;

  let merged: DealPrefill = passed
    ? { ...passed, address: passed.address ?? address }
    : {
        address,
        source: sourceUrl?.includes("redfin.com") ? "redfin" : "zillow",
        ...(sourceUrl ? { sourceUrl } : {}),
      };

  const cached = await getCachedPrefill(address, SUBJECT_TTL_DAYS);
  if (cached) merged = fillMissingPrefill(merged, cached.prefill);

  const missing = KEY_DETAIL_FIELDS.filter((k) => merged[k] === undefined);
  let detailFetched = false;
  const detailUrl = sourceUrl ?? merged.sourceUrl;
  if (missing.length > 0 && detailUrl && apifyConfigured()) {
    try {
      const detail = detailUrl.includes("redfin.com")
        ? await fetchRedfinDetailPrefill(detailUrl)
        : await lookupListing({ url: detailUrl, address });
      if (detail) {
        merged = fillMissingPrefill(merged, detail);
        detailFetched = true;
      }
    } catch {
      // A failed detail pull never blocks underwriting — the merged
      // search/cache record still fills most of the form.
    }
  }

  if (detailFetched) {
    await putCachedPrefill(address, merged, "apify-detail");
  }

  return NextResponse.json({
    ok: true,
    configured: apifyConfigured(),
    detailFetched,
    prefill: merged,
  });
}

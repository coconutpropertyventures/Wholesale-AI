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
//      record once — Redfin URLs via the memo23 detail Actor (with
//      the maxcopell listing lookup as fallback when that pull throws
//      or returns nothing), other (Zillow) URLs via the existing
//      detail lookup — and merge again. Pull failures never block
//      the response; they surface as `detailError`.
//   4. Cache the merged record with source tag "apify-detail" so the
//      detail pull is paid for once per property.
// Fields no source carries stay absent — nothing is invented here.
// Photos follow the same completeness rule with one nuance: `photos`
// is three-state — undefined = never mapped (incomplete, one backfill
// pull), [] = a detail pull ran and the listing had none (complete,
// never re-pulled), non-empty = present.

const KEY_DETAIL_FIELDS: (keyof DealPrefill)[] = [
  "yearBuilt",
  "sqft",
  "beds",
  "baths",
  "hoaMonthly",
  "annualTaxes",
  "rentEstimate",
  "valueEstimate",
  "photos",
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
  let detailError: string | undefined;
  const detailUrl = sourceUrl ?? merged.sourceUrl;
  if (missing.length > 0 && detailUrl && apifyConfigured()) {
    // A failed detail pull never blocks underwriting — the merged
    // search/cache record still fills most of the form — but the
    // failure is no longer silent: the first error is captured and
    // returned as `detailError` so a dead pull path is visible.
    const isRedfin = detailUrl.includes("redfin.com");
    let detail: DealPrefill | null = null;
    let pullError: unknown;
    if (isRedfin) {
      try {
        detail = await fetchRedfinDetailPrefill(detailUrl);
      } catch (err) {
        pullError = err;
      }
      if (!detail) {
        // Fallback: the maxcopell lookup path also reads Redfin
        // listing pages (verified live, 2026-10-18) — if the memo23
        // pull threw or came back empty, try it before settling for
        // the thinner search/cache record.
        try {
          detail = await lookupListing({ url: detailUrl, address });
        } catch (err) {
          pullError ??= err;
        }
      }
    } else {
      try {
        detail = await lookupListing({ url: detailUrl, address });
      } catch (err) {
        pullError = err;
      }
    }
    if (detail) {
      merged = fillMissingPrefill(merged, detail);
      // A completed detail pull is authoritative for photos: if it
      // carried none, stamp "known none" explicitly so the record
      // cached below reads complete and the pull is never repeated
      // for this property. Stamping happens ONLY on a successful
      // pull — if every path failed, photos stay undefined and the
      // record is not cached, so a later click can retry.
      if (merged.photos === undefined) merged = { ...merged, photos: [] };
      detailFetched = true;
    }
    if (pullError !== undefined) {
      detailError =
        pullError instanceof Error ? pullError.message : String(pullError);
    } else if (!detail) {
      detailError = "Detail pull returned no record for this listing.";
    }
  }

  if (detailFetched) {
    await putCachedPrefill(address, merged, "apify-detail");
  }

  return NextResponse.json({
    ok: true,
    configured: apifyConfigured(),
    detailFetched,
    ...(detailError ? { detailError } : {}),
    prefill: merged,
  });
}

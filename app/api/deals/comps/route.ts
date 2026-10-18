import { NextResponse, type NextRequest } from "next/server";
import { apifyConfigured, redfinActorId, runActorSync } from "@/lib/apify/client";
import {
  getCachedEntry,
  getCachedPrefill,
  putCachedEntry,
} from "@/lib/deals/cache";
import {
  buildCompsViewport,
  COMPS_RENT_MAX_ITEMS,
  COMPS_SOLD_MAX_ITEMS,
  rentCompsUrl,
  selectRentComps,
  selectSoldComps,
  soldCompsUrl,
  type CompsSubject,
  type RentComp,
  type SoldComp,
} from "@/lib/deals/comps";
import { geocodeCoordinates } from "@/lib/deals/redfinUrl";

export const dynamic = "force-dynamic";

// POST /api/deals/comps  { address }
// Turnkey auto-comps: pulls the Redfin SOLD (past 12 months) and FOR
// RENT feeds inside a 0.5-mile viewport around the subject and selects
// comps with lib/deals/comps.ts — sold comps suggest a market value,
// rentals suggest a rent. The subject comes from the property cache
// (a prior search / link lookup put it there); its coordinates anchor
// the viewport, falling back to a Nominatim geocode of the address.
// Results are cached per subject address (source "comps", 7 days) — a
// cached result returns cached:true and costs no Actor run. Without
// APIFY_TOKEN: configured:false, no invented numbers.

interface CompsPayload {
  soldComps: SoldComp[];
  rentComps: RentComp[];
  suggestedRent: number | null;
  suggestedMV: number | null;
  notes: string[];
}

const COMPS_CACHE_PREFIX = "comps:";
const COMPS_TTL_DAYS = 7;
const SUBJECT_TTL_DAYS = 30;

function zipFromAddress(address: string): string | undefined {
  const matches = address.match(/\b(\d{5})(?:-\d{4})?\b/g);
  if (!matches || matches.length === 0) return undefined;
  return matches[matches.length - 1].slice(0, 5);
}

function emptyPayload(notes: string[]): CompsPayload {
  return {
    soldComps: [],
    rentComps: [],
    suggestedRent: null,
    suggestedMV: null,
    notes,
  };
}

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

  const cached = await getCachedEntry<CompsPayload>(
    `${COMPS_CACHE_PREFIX}${address}`,
    COMPS_TTL_DAYS,
  );
  if (cached) {
    return NextResponse.json({
      ok: true,
      configured: apifyConfigured(),
      cached: true,
      ...cached.data,
    });
  }

  if (!apifyConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      ...emptyPayload([
        "Listing data is not configured on the server (no Apify token) — comps unavailable.",
      ]),
    });
  }

  // Subject: the cached listing record when one exists (it carries
  // beds / sqft / neighborhood / coordinates); otherwise a bare
  // subject from the address alone — nothing is invented either way.
  const subjectRecord = await getCachedPrefill(address, SUBJECT_TTL_DAYS);
  const subject: CompsSubject = {
    address,
    zip: subjectRecord?.prefill.zip ?? zipFromAddress(address),
    latitude: subjectRecord?.prefill.latitude,
    longitude: subjectRecord?.prefill.longitude,
    beds: subjectRecord?.prefill.beds,
    sqft: subjectRecord?.prefill.sqft,
    neighborhood: subjectRecord?.prefill.neighborhood,
    propertyId: subjectRecord?.prefill.propertyId,
  };

  // Coordinates anchor everything; geocode when the record lacks them.
  if (subject.latitude === undefined || subject.longitude === undefined) {
    const geo = await geocodeCoordinates(address);
    if (geo) {
      subject.latitude = geo.latitude;
      subject.longitude = geo.longitude;
      if (!subject.zip && geo.postcode) subject.zip = geo.postcode;
    }
  }
  if (subject.latitude === undefined || subject.longitude === undefined) {
    return NextResponse.json({
      ok: true,
      configured: true,
      ...emptyPayload([
        "Could not locate this property (no coordinates from the listing or the geocoder), so no comps could be pulled.",
      ]),
    });
  }
  if (!subject.zip) {
    return NextResponse.json({
      ok: true,
      configured: true,
      ...emptyPayload([
        "No ZIP code could be determined for this property, so the comp feeds could not be anchored.",
      ]),
    });
  }

  const viewport = buildCompsViewport(subject.latitude, subject.longitude);
  try {
    const actor = redfinActorId();
    const [soldRows, rentRows] = await Promise.all([
      runActorSync(
        actor,
        {
          searchUrls: [{ url: soldCompsUrl(subject.zip, viewport) }],
          zoomIn: true,
        },
        COMPS_SOLD_MAX_ITEMS,
      ),
      runActorSync(
        actor,
        {
          searchUrls: [{ url: rentCompsUrl(subject.zip, viewport) }],
          zoomIn: true,
        },
        COMPS_RENT_MAX_ITEMS,
      ),
    ]);
    const sold = selectSoldComps(subject, soldRows);
    const rent = selectRentComps(subject, rentRows);
    const payload: CompsPayload = {
      soldComps: sold.comps,
      rentComps: rent.comps,
      suggestedRent: rent.suggestedRent,
      suggestedMV: sold.suggestedMV,
      notes: [...sold.notes, ...rent.notes],
    };
    await putCachedEntry(`${COMPS_CACHE_PREFIX}${address}`, payload, "comps");
    return NextResponse.json({ ok: true, configured: true, ...payload });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason: `Comps pull failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

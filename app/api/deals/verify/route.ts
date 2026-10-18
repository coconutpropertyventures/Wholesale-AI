import { NextResponse, type NextRequest } from "next/server";
import {
  ghlConfigured,
  ghlLocationId,
  listOpenOpportunities,
} from "@/lib/ghl/client";
import { matchUnderContract } from "@/lib/deals/underContract";
import { rentcastConfigured, verifyAddress } from "@/lib/rentcast/client";
import {
  getCachedPrefill,
  putCachedPrefill,
} from "@/lib/deals/cache";
import type { DealPrefill } from "@/lib/deals/prefill";

export const dynamic = "force-dynamic";

// POST /api/deals/verify  { address }
// Bradley's rule: RentCast is spent ONLY on deals under contract. The
// server checks the address against open opportunities (Dispositions any
// stage, Wholesale Under Contract/Closed, Acquisitions MOVED TO DISPO)
// BEFORE any RentCast call. No match -> { ok: false,
// reason: "not_under_contract" } and RentCast is never called. Verified
// values are cached 30 days (tagged rentcast).
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
      { ok: false, reason: "An address is required." },
      { status: 400 },
    );
  }

  // 1) The gate. Without HighLevel we cannot prove under-contract status,
  // so the gate stays closed.
  if (!ghlConfigured() || !ghlLocationId()) {
    return NextResponse.json({ ok: false, reason: "not_under_contract" });
  }
  let matched = null;
  try {
    const opps = await listOpenOpportunities(ghlLocationId() as string);
    matched = matchUnderContract(opps, address);
  } catch {
    return NextResponse.json({ ok: false, reason: "not_under_contract" });
  }
  if (!matched) {
    return NextResponse.json({ ok: false, reason: "not_under_contract" });
  }

  // 2) Matched. Serve the 30-day rentcast cache before spending a call.
  const cacheKeyAddr = `rentcast:${address}`;
  const cached = await getCachedPrefill(cacheKeyAddr, 30);
  if (cached && cached.source === "rentcast") {
    return NextResponse.json({
      ok: true,
      matched: true,
      configured: rentcastConfigured(),
      cached: true,
      data: cached.prefill,
    });
  }

  if (!rentcastConfigured()) {
    return NextResponse.json({ ok: true, matched: true, configured: false });
  }

  try {
    const v = await verifyAddress(address);
    const prefill: DealPrefill = {
      address,
      valueEstimate: v.valueEstimate,
      rentEstimate: v.rentEstimate,
      beds: v.beds,
      baths: v.baths,
      sqft: v.sqft,
      yearBuilt: v.yearBuilt,
      source: "rentcast",
    };
    await putCachedPrefill(cacheKeyAddr, prefill, "rentcast");
    return NextResponse.json({
      ok: true,
      matched: true,
      configured: true,
      cached: false,
      data: {
        ...v,
        opportunityName: matched.name,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        reason: `RentCast verification failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

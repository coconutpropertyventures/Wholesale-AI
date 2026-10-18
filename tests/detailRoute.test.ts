import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// POST /api/deals/detail — the "fullest record" merge behind Run
// Underwriting — with the property cache and the Apify detail layer
// stubbed (vi.hoisted state, same pattern as blastEnrich.test.ts).
// Focus: photos completeness. `photos` is three-state on a record —
// undefined = never mapped (STALE: pre-photos-mapping records), [] =
// a detail pull ran and found none, non-empty = present. A stale
// record must trigger exactly one backfill pull; [] and non-empty
// must never re-pull.

const ADDRESS = "355 E Ohio St #223, Indianapolis, IN 46204";
const REDFIN_URL =
  "https://www.redfin.com/IN/Indianapolis/355-E-Ohio-St-46204/unit-223/home/82299654";
const DETAIL_PHOTOS = [
  "https://ssl.cdn-redfin.com/photo/147/mbphotov3/360/genMid.22112360_0.jpg",
  "https://ssl.cdn-redfin.com/photo/147/mbphotov3/360/genMid.22112360_1.jpg",
];

const hoisted = vi.hoisted(() => ({
  cached: null as { prefill: DealPrefill; source: string } | null,
  cachePuts: [] as { key: string; prefill: DealPrefill; source: string }[],
  detailResult: null as DealPrefill | null,
  lookupResult: null as DealPrefill | null,
  detailThrows: false,
  lookupThrows: false,
  detailCalls: 0,
  lookupCalls: 0,
}));

vi.mock("@/lib/deals/cache", () => ({
  getCachedPrefill: async () => hoisted.cached,
  putCachedPrefill: async (
    key: string,
    prefill: DealPrefill,
    source: string,
  ) => {
    hoisted.cachePuts.push({ key, prefill, source });
  },
}));

vi.mock("@/lib/apify/client", () => ({
  apifyConfigured: () => true,
  fetchRedfinDetailPrefill: async () => {
    hoisted.detailCalls += 1;
    if (hoisted.detailThrows) {
      throw new Error("Redfin detail run run-1 ended with status FAILED.");
    }
    return hoisted.detailResult;
  },
  lookupListing: async () => {
    hoisted.lookupCalls += 1;
    if (hoisted.lookupThrows) {
      throw new Error("Apify run failed (502): upstream boom");
    }
    return hoisted.lookupResult ?? hoisted.detailResult;
  },
}));

import { POST } from "@/app/api/deals/detail/route";
import type { DealPrefill } from "@/lib/deals/prefill";

/** A complete-except-photos record, as cached before photos mapping shipped. */
function staleRecord(extra: Partial<DealPrefill> = {}): DealPrefill {
  return {
    address: ADDRESS,
    source: "redfin",
    sourceUrl: REDFIN_URL,
    listPrice: 325000,
    beds: 2,
    baths: 2,
    sqft: 1210,
    hoaMonthly: 385,
    yearBuilt: 2005,
    annualTaxes: 3900,
    rentEstimate: 1950,
    valueEstimate: 330000,
    ...extra,
  } as DealPrefill;
}

async function callDetail() {
  const req = new NextRequest("http://localhost/api/deals/detail", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: ADDRESS, sourceUrl: REDFIN_URL }),
  });
  const res = await POST(req);
  return (await res.json()) as {
    ok: boolean;
    detailFetched: boolean;
    detailError?: string;
    prefill: DealPrefill;
  };
}

beforeEach(() => {
  hoisted.cached = null;
  hoisted.cachePuts = [];
  hoisted.detailResult = null;
  hoisted.lookupResult = null;
  hoisted.detailThrows = false;
  hoisted.lookupThrows = false;
  hoisted.detailCalls = 0;
  hoisted.lookupCalls = 0;
});

describe("POST /api/deals/detail photos completeness", () => {
  it("(a) cached record missing photos → one detail pull; photos land in response + cached record", async () => {
    hoisted.cached = { prefill: staleRecord(), source: "apify" };
    hoisted.detailResult = staleRecord({ photos: DETAIL_PHOTOS });

    const body = await callDetail();

    expect(body.ok).toBe(true);
    expect(hoisted.detailCalls).toBe(1);
    expect(body.detailFetched).toBe(true);
    expect(body.prefill.photos).toEqual(DETAIL_PHOTOS);
    expect(hoisted.cachePuts).toHaveLength(1);
    expect(hoisted.cachePuts[0].source).toBe("apify-detail");
    expect(hoisted.cachePuts[0].prefill.photos).toEqual(DETAIL_PHOTOS);
  });

  it("(a2) detail pull finds no photos → merged record is stamped photos: [] (known none)", async () => {
    hoisted.cached = { prefill: staleRecord(), source: "apify" };
    hoisted.detailResult = staleRecord(); // detail record, photos absent

    const body = await callDetail();

    expect(hoisted.detailCalls).toBe(1);
    expect(body.detailFetched).toBe(true);
    expect(body.prefill.photos).toEqual([]);
    expect(hoisted.cachePuts).toHaveLength(1);
    expect(hoisted.cachePuts[0].prefill.photos).toEqual([]);
  });

  it("(b) cached record with photos: [] → NO detail pull", async () => {
    hoisted.cached = {
      prefill: staleRecord({ photos: [] }),
      source: "apify-detail",
    };
    hoisted.detailResult = staleRecord({ photos: DETAIL_PHOTOS });

    const body = await callDetail();

    expect(body.ok).toBe(true);
    expect(hoisted.detailCalls).toBe(0);
    expect(hoisted.lookupCalls).toBe(0);
    expect(body.detailFetched).toBe(false);
    expect(body.prefill.photos).toEqual([]);
    expect(hoisted.cachePuts).toHaveLength(0);
  });

  it("(c) cached record with photos → NO detail pull, photos preserved", async () => {
    hoisted.cached = {
      prefill: staleRecord({ photos: DETAIL_PHOTOS }),
      source: "apify-detail",
    };

    const body = await callDetail();

    expect(body.ok).toBe(true);
    expect(hoisted.detailCalls).toBe(0);
    expect(hoisted.lookupCalls).toBe(0);
    expect(body.detailFetched).toBe(false);
    expect(body.prefill.photos).toEqual(DETAIL_PHOTOS);
    expect(hoisted.cachePuts).toHaveLength(0);
  });
});

describe("POST /api/deals/detail pull fallback + error surfacing", () => {
  it("(b) memo23 pull throws → falls back to lookupListing; filled prefill, detailFetched, cached", async () => {
    hoisted.cached = { prefill: staleRecord(), source: "apify" };
    hoisted.detailThrows = true;
    hoisted.lookupResult = staleRecord({ photos: DETAIL_PHOTOS });

    const body = await callDetail();

    expect(body.ok).toBe(true);
    expect(hoisted.detailCalls).toBe(1);
    expect(hoisted.lookupCalls).toBe(1);
    expect(body.detailFetched).toBe(true);
    expect(body.prefill.photos).toEqual(DETAIL_PHOTOS);
    // The memo23 failure is surfaced even though the fallback saved
    // the record — a dead primary pull path must stay visible.
    expect(body.detailError).toContain("FAILED");
    expect(hoisted.cachePuts).toHaveLength(1);
    expect(hoisted.cachePuts[0].source).toBe("apify-detail");
    expect(hoisted.cachePuts[0].prefill.photos).toEqual(DETAIL_PHOTOS);
  });

  it("(b2) memo23 pull returns nothing → lookupListing fallback fills the record, no error", async () => {
    hoisted.cached = { prefill: staleRecord(), source: "apify" };
    hoisted.detailResult = null; // memo23 came back empty
    hoisted.lookupResult = staleRecord({ photos: DETAIL_PHOTOS });

    const body = await callDetail();

    expect(body.ok).toBe(true);
    expect(hoisted.detailCalls).toBe(1);
    expect(hoisted.lookupCalls).toBe(1);
    expect(body.detailFetched).toBe(true);
    expect(body.detailError).toBeUndefined();
    expect(body.prefill.photos).toEqual(DETAIL_PHOTOS);
    expect(hoisted.cachePuts).toHaveLength(1);
  });

  it("(c) both paths fail → detailError present, detailFetched false, no cache write, photos unstamped", async () => {
    hoisted.cached = { prefill: staleRecord(), source: "apify" };
    hoisted.detailThrows = true;
    hoisted.lookupThrows = true;

    const body = await callDetail();

    expect(body.ok).toBe(true);
    expect(hoisted.detailCalls).toBe(1);
    expect(hoisted.lookupCalls).toBe(1);
    expect(body.detailFetched).toBe(false);
    expect(body.detailError).toContain("FAILED");
    // Nothing was pulled, so nothing is stamped "known none" and the
    // thinner record is NOT written to cache — a later click retries.
    expect(body.prefill.photos).toBeUndefined();
    expect(hoisted.cachePuts).toHaveLength(0);
  });
});

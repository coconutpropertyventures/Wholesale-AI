import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_APIFY_ITEMS_PER_RUN,
  clampApifyMaxItems,
  fetchRedfinDetailPrefill,
  lookupListing,
  runActorSync,
  searchRedfin,
} from "../lib/apify/client";
import {
  COMPS_RENT_MAX_ITEMS,
  COMPS_SOLD_MAX_ITEMS,
} from "../lib/deals/comps";

// Cost cap (Bradley, 2026-10-18): no Apify run may pull more than 500
// items. These tests pin the enforcement at the client — the maxItems
// query parameter on the run request, clamping of out-of-range
// budgets, the client-side slice of returned rows — and the per-call
// budgets the app's call sites pass (search 500; comps 300 + 200;
// detail pulls at the exact batch size requested).

const prevToken = process.env.APIFY_TOKEN;

beforeEach(() => {
  process.env.APIFY_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevToken === undefined) delete process.env.APIFY_TOKEN;
  else process.env.APIFY_TOKEN = prevToken;
});

function stubFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      typeof payload === "string" ? payload : JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calledUrl(fetchMock: ReturnType<typeof stubFetch>): URL {
  const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return new URL(url);
}

describe("clampApifyMaxItems", () => {
  it("defaults to the 500 ceiling", () => {
    expect(clampApifyMaxItems()).toBe(500);
    expect(clampApifyMaxItems(Number.NaN)).toBe(500);
    expect(MAX_APIFY_ITEMS_PER_RUN).toBe(500);
  });

  it("clamps into [1, 500]", () => {
    expect(clampApifyMaxItems(5000)).toBe(500);
    expect(clampApifyMaxItems(0)).toBe(1);
    expect(clampApifyMaxItems(-10)).toBe(1);
    expect(clampApifyMaxItems(250.9)).toBe(250);
    expect(clampApifyMaxItems(300)).toBe(300);
  });
});

describe("runActorSync maxItems enforcement", () => {
  it("sends the requested budget as the maxItems query parameter", async () => {
    const fetchMock = stubFetch([]);
    await runActorSync("tri_angle/redfin-search", { searchUrls: [] }, 300);
    const url = calledUrl(fetchMock);
    expect(url.pathname).toContain("run-sync-get-dataset-items");
    expect(url.searchParams.get("maxItems")).toBe("300");
  });

  it("defaults to maxItems=500 when no budget is passed", async () => {
    const fetchMock = stubFetch([]);
    await runActorSync("tri_angle/redfin-search", {});
    expect(calledUrl(fetchMock).searchParams.get("maxItems")).toBe("500");
  });

  it("clamps a 5000 budget down to 500 on the request", async () => {
    const fetchMock = stubFetch([]);
    await runActorSync("tri_angle/redfin-search", {}, 5000);
    expect(calledUrl(fetchMock).searchParams.get("maxItems")).toBe("500");
  });

  it("slices returned rows to the cap even when the Actor returns more", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ n: i }));
    stubFetch(rows);
    const out = await runActorSync("tri_angle/redfin-search", {});
    expect(out).toHaveLength(500);
  });

  it("slices returned rows to a smaller explicit budget", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    stubFetch(rows);
    const out = await runActorSync("tri_angle/redfin-search", {}, 3);
    expect(out).toHaveLength(3);
  });
});

describe("call-site budgets", () => {
  it("Redfin search passes the full 500 budget", async () => {
    const fetchMock = stubFetch([]);
    // ZIP queries resolve to a Redfin URL without any geocoder call,
    // so the only fetch is the Actor run.
    await searchRedfin("46204");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calledUrl(fetchMock).searchParams.get("maxItems")).toBe("500");
  });

  it("Redfin detail pull budgets exactly the one URL requested", async () => {
    const fetchMock = stubFetch([{ url: "https://www.redfin.com/x" }]);
    await fetchRedfinDetailPrefill("https://www.redfin.com/x");
    expect(calledUrl(fetchMock).searchParams.get("maxItems")).toBe("1");
  });

  it("Zillow single-listing lookup budgets exactly the batch requested", async () => {
    const fetchMock = stubFetch([{ streetAddress: "1 Main St" }]);
    await lookupListing({ url: "https://www.zillow.com/homedetails/1" });
    expect(calledUrl(fetchMock).searchParams.get("maxItems")).toBe("1");
  });

  it("comps budgets are 300 sold + 200 rent and sum to the 500 ceiling", () => {
    expect(COMPS_SOLD_MAX_ITEMS).toBe(300);
    expect(COMPS_RENT_MAX_ITEMS).toBe(200);
    expect(COMPS_SOLD_MAX_ITEMS + COMPS_RENT_MAX_ITEMS).toBeLessThanOrEqual(
      MAX_APIFY_ITEMS_PER_RUN,
    );
  });
});

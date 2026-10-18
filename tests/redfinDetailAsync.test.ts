import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchRedfinDetailPrefill } from "../lib/apify/client";

// fetchRedfinDetailPrefill pulls ONE Redfin listing through the
// memo23 detail Actor's ASYNC lifecycle — startActorRun → getActorRun
// poll → getDatasetItems — because the run-sync endpoint fails fast
// and empty for this Actor in production (diagnosed live 2026-10-18;
// the blast enrichment path over the same lifecycle works). These
// tests stub global fetch at the Apify REST boundary and pin the
// call sequence, the plain-string startUrls input, the mapping of
// the returned row (photos included), and the throw-on-failure
// contract the detail route relies on for its fallback.

const REDFIN_URL =
  "https://www.redfin.com/IN/Indianapolis/355-E-Ohio-St-46204/unit-223/home/82299654";
const PHOTO_1 =
  "https://ssl.cdn-redfin.com/photo/147/mbphotov3/360/genMid.22112360_0.jpg";
const PHOTO_2 =
  "https://ssl.cdn-redfin.com/photo/147/mbphotov3/360/genMid.22112360_1.jpg";

/** A memo23-shaped detail row (shapes pinned in lib/deals/prefill). */
const DETAIL_ROW = {
  url: REDFIN_URL,
  priceInfo: { amount: 325000 },
  numBeds: 2,
  numBaths: 2,
  sqFt: { value: 1210 },
  yearBuilt: 2005,
  city: "Indianapolis",
  state: "IN",
  zip: "46204",
  publicRecordsInfo: {
    addressInfo: { street: "355 E Ohio St #223" },
    taxInfo: {},
    mortgageCalculatorInfo: {
      monthlyHoaDues: 385,
      propertyTaxRate: 1.2,
      homeInsuranceData: { homeInsuranceYearlyEstimate: 1400 },
    },
  },
  mlsDisclaimerInfo: {
    listingAgentName: "Chuck Pennington",
    listingAgentNumber: "317-417-9757",
    listingBrokerName: "Victor & Valor Property Group",
  },
  photoTags: {
    tagsByPhotoId: {
      "102": { photoUrl: PHOTO_2 },
      "101": { photoUrl: PHOTO_1 },
    },
  },
};

const prevToken = process.env.APIFY_TOKEN;

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

interface StubOptions {
  /** Statuses returned by successive getActorRun polls. */
  pollStatuses: string[];
}

/** Stub the three Apify REST legs of the async lifecycle. */
function stubApifyLifecycle({ pollStatuses }: StubOptions) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let polls = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/acts/")) {
      return jsonResponse({
        data: { id: "run-1", status: "RUNNING", defaultDatasetId: "ds-1" },
      });
    }
    if (url.includes("/actor-runs/")) {
      const status = pollStatuses[Math.min(polls, pollStatuses.length - 1)];
      polls += 1;
      return jsonResponse({
        data: { id: "run-1", status, defaultDatasetId: "ds-1" },
      });
    }
    if (url.includes("/datasets/")) {
      return jsonResponse([DETAIL_ROW]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  process.env.APIFY_TOKEN = "test-token";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (prevToken === undefined) delete process.env.APIFY_TOKEN;
  else process.env.APIFY_TOKEN = prevToken;
});

describe("fetchRedfinDetailPrefill async lifecycle", () => {
  it("start → poll RUNNING → poll SUCCEEDED → dataset items → mapped prefill incl. photos", async () => {
    vi.useFakeTimers();
    const calls = stubApifyLifecycle({
      pollStatuses: ["RUNNING", "SUCCEEDED"],
    });

    const pending = fetchRedfinDetailPrefill(REDFIN_URL);
    await vi.advanceTimersByTimeAsync(11_000);
    const prefill = await pending;

    // Call sequence: one run start, two status polls, one dataset read.
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toContain("/acts/memo23~apify-redfin-cheerio/runs");
    expect(calls[0].url).not.toContain("run-sync");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      startUrls: [REDFIN_URL], // plain strings — {url} objects fail memo23
    });
    expect(calls[1].url).toContain("/actor-runs/run-1");
    expect(calls[2].url).toContain("/actor-runs/run-1");
    expect(calls[3].url).toContain("/datasets/ds-1/items");

    // The row is mapped with the detail mapper, photos included
    // (photoTags map, numeric-id order = gallery order).
    expect(prefill).not.toBeNull();
    expect(prefill?.address).toBe("355 E Ohio St #223, Indianapolis, IN 46204");
    expect(prefill?.listPrice).toBe(325000);
    expect(prefill?.beds).toBe(2);
    expect(prefill?.baths).toBe(2);
    expect(prefill?.sqft).toBe(1210);
    expect(prefill?.yearBuilt).toBe(2005);
    expect(prefill?.hoaMonthly).toBe(385);
    // Taxes derive from the record's own tax rate × list price.
    expect(prefill?.annualTaxes).toBe(3900);
    expect(prefill?.annualInsurance).toBe(1400);
    expect(prefill?.agentName).toBe("Chuck Pennington");
    expect(prefill?.agentPhone).toBe("317-417-9757");
    expect(prefill?.photos).toEqual([PHOTO_1, PHOTO_2]);
    expect(prefill?.sourceUrl).toBe(REDFIN_URL);
    expect(prefill?.source).toBe("redfin");
  });

  it("a FAILED run throws an error carrying the run status", async () => {
    vi.useFakeTimers();
    stubApifyLifecycle({ pollStatuses: ["FAILED"] });

    const pending = fetchRedfinDetailPrefill(REDFIN_URL);
    const assertion = expect(pending).rejects.toThrow(/FAILED/);
    await vi.advanceTimersByTimeAsync(6_000);
    await assertion;
  });
});

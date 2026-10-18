import { describe, expect, it } from "vitest";
import {
  applySearchFilters,
  hasActiveFilters,
  parseSearchFilters,
  selectSearchResults,
} from "../lib/deals/searchFilters";
import {
  extractDetailPhotos,
  fillMissingPrefill,
  mapRedfinDetailPrefill,
  MAX_DETAIL_PHOTOS,
  type DealPrefill,
} from "../lib/deals/prefill";

// ---------- Search filters ----------

function row(partial: Partial<DealPrefill>): DealPrefill {
  return { source: "redfin", ...partial };
}

const ROWS: DealPrefill[] = [
  row({ address: "A", listPrice: 90000, daysOnMarket: 120, beds: 3, baths: 2 }),
  row({ address: "B", listPrice: 150000, daysOnMarket: 45, beds: 4, baths: 2.5 }),
  row({ address: "C", listPrice: 240000, daysOnMarket: 200, beds: 2, baths: 1 }),
  row({ address: "D", listPrice: 60000, daysOnMarket: 95, beds: 3, baths: 1.5 }),
  // Sparse row: every filtered field absent — an active filter must
  // exclude it rather than wave it through unverified.
  row({ address: "E" }),
];

describe("parseSearchFilters", () => {
  it("keeps valid numbers and numeric strings", () => {
    expect(
      parseSearchFilters({ minPrice: 50000, maxPrice: "200000", minDom: 90 }),
    ).toEqual({ minPrice: 50000, maxPrice: 200000, minDom: 90 });
  });

  it("drops garbage, negatives, and non-objects", () => {
    expect(parseSearchFilters(null)).toEqual({});
    expect(parseSearchFilters("nope")).toEqual({});
    expect(parseSearchFilters({ minPrice: -5, minBeds: "abc", minDom: NaN })).toEqual({});
  });
});

describe("applySearchFilters", () => {
  it("no filters passes everything through", () => {
    expect(applySearchFilters(ROWS, {})).toHaveLength(5);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ minDom: 90 })).toBe(true);
  });

  it("min/max price", () => {
    expect(
      applySearchFilters(ROWS, { minPrice: 80000 }).map((r) => r.address),
    ).toEqual(["A", "B", "C"]);
    expect(
      applySearchFilters(ROWS, { maxPrice: 100000 }).map((r) => r.address),
    ).toEqual(["A", "D"]);
    expect(
      applySearchFilters(ROWS, { minPrice: 80000, maxPrice: 200000 }).map(
        (r) => r.address,
      ),
    ).toEqual(["A", "B"]);
  });

  it("min DOM", () => {
    expect(
      applySearchFilters(ROWS, { minDom: 90 }).map((r) => r.address),
    ).toEqual(["A", "C", "D"]);
  });

  it("min beds / baths", () => {
    expect(
      applySearchFilters(ROWS, { minBeds: 3 }).map((r) => r.address),
    ).toEqual(["A", "B", "D"]);
    expect(
      applySearchFilters(ROWS, { minBaths: 2 }).map((r) => r.address),
    ).toEqual(["A", "B"]);
  });

  it("combines filters (AND)", () => {
    expect(
      applySearchFilters(ROWS, { minDom: 90, minBeds: 3, maxPrice: 100000 }).map(
        (r) => r.address,
      ),
    ).toEqual(["A", "D"]);
  });
});

describe("selectSearchResults", () => {
  it("reports pulled vs matched vs shown", () => {
    const sel = selectSearchResults(ROWS, { minDom: 90 });
    expect(sel.totalReturned).toBe(5);
    expect(sel.totalMatched).toBe(3);
    expect(sel.results).toHaveLength(3);
  });

  it("filters BEFORE the display slice: matches past row 100 still surface", () => {
    const many: DealPrefill[] = Array.from({ length: 150 }, (_, i) =>
      row({
        address: `P${i}`,
        listPrice: 100000,
        // Only the last 30 rows are stale enough to match minDom.
        daysOnMarket: i >= 120 ? 300 : 5,
        beds: 3,
        baths: 2,
      }),
    );
    const sel = selectSearchResults(many, { minDom: 90 });
    expect(sel.totalReturned).toBe(150);
    expect(sel.totalMatched).toBe(30);
    expect(sel.results).toHaveLength(30);
    expect(sel.results[0].address).toBe("P120");
  });

  it("slices the matched set at the display limit", () => {
    const many: DealPrefill[] = Array.from({ length: 250 }, (_, i) =>
      row({ address: `P${i}`, listPrice: 100000, daysOnMarket: 10 }),
    );
    const sel = selectSearchResults(many, {});
    expect(sel.totalMatched).toBe(250);
    expect(sel.results).toHaveLength(100);
  });
});

// ---------- Detail photo mapping ----------

// memo23 detail-row photo shapes, copied from a verified live row
// (225 N New Jersey St, Indianapolis; dataset AaApW7NmuBmfM6neq,
// 2026-10-18): the full set lives in photoTags.tagsByPhotoId keyed by
// ascending photoId; preloadImageUrls carries only the first photo;
// agent headshots live under recommendedAgent / askAgent and must
// NEVER be mapped as listing photos.
const CDN = "https://ssl.cdn-redfin.com/photo/147/bigphoto/913";

function tagsByPhotoId(count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    out[String(3414983784 + i)] = {
      photoId: 3414983784 + i,
      photoUrl: `${CDN}/22128913_${i}.jpg`,
      thumbnailphotoUrl: `https://ssl.cdn-redfin.com/photo/147/midphoto/913/genMid.22128913_${i}.jpg`,
    };
  }
  return out;
}

const DETAIL_ROW = {
  url: "https://www.redfin.com/IN/Indianapolis/225-N-New-Jersey-St-46204/unit-27/home/199882420",
  priceInfo: { amount: 325000, level: 1 },
  numBeds: 2,
  numBaths: 2,
  photoTags: { listingId: 223979626, tagsByPhotoId: tagsByPhotoId(3) },
  preloadImageUrls: [
    "https://ssl.cdn-redfin.com/photo/147/mbphotov3/913/genMid.22128913_0.jpg",
  ],
  addressSectionInfo: { primaryPhotoUrl: `${CDN}/22128913_0.jpg` },
  recommendedAgent: {
    __root: {
      photoUrl: "https://ssl.cdn-redfin.com/system_files/images/15413/150x150/1_22.jpg",
    },
  },
  askAgent: {
    agent: {
      trading_photo_url_secure:
        "https://ssl.cdn-redfin.com/system_files/images/15413/150x150/1_22.jpg",
    },
  },
};

describe("extractDetailPhotos", () => {
  it("maps the photoTags set in listing order", () => {
    expect(extractDetailPhotos(DETAIL_ROW)).toEqual([
      `${CDN}/22128913_0.jpg`,
      `${CDN}/22128913_1.jpg`,
      `${CDN}/22128913_2.jpg`,
    ]);
  });

  it("caps at MAX_DETAIL_PHOTOS", () => {
    const big = { photoTags: { tagsByPhotoId: tagsByPhotoId(12) } };
    const photos = extractDetailPhotos(big);
    expect(photos).toHaveLength(MAX_DETAIL_PHOTOS);
    expect(photos[0]).toBe(`${CDN}/22128913_0.jpg`);
  });

  it("never includes agent headshots", () => {
    const photos = extractDetailPhotos(DETAIL_ROW);
    expect(photos.some((u) => u.includes("system_files"))).toBe(false);
  });

  it("falls back to preloadImageUrls, then the primary photo", () => {
    expect(
      extractDetailPhotos({ preloadImageUrls: DETAIL_ROW.preloadImageUrls }),
    ).toEqual(DETAIL_ROW.preloadImageUrls);
    expect(
      extractDetailPhotos({
        addressSectionInfo: DETAIL_ROW.addressSectionInfo,
      }),
    ).toEqual([`${CDN}/22128913_0.jpg`]);
    expect(extractDetailPhotos({})).toEqual([]);
  });
});

describe("mapRedfinDetailPrefill photos", () => {
  it("carries photos onto the detail prefill", () => {
    const prefill = mapRedfinDetailPrefill(DETAIL_ROW);
    expect(prefill.photos).toEqual([
      `${CDN}/22128913_0.jpg`,
      `${CDN}/22128913_1.jpg`,
      `${CDN}/22128913_2.jpg`,
    ]);
  });

  it("leaves photos absent when the row carries none", () => {
    const prefill = mapRedfinDetailPrefill({ url: DETAIL_ROW.url });
    expect(prefill.photos).toBeUndefined();
  });

  it("fillMissingPrefill flows photos from a detail record into a search record", () => {
    const search = row({ address: "A", listPrice: 325000 });
    const detail = mapRedfinDetailPrefill(DETAIL_ROW);
    const merged = fillMissingPrefill(search, detail);
    expect(merged.photos).toHaveLength(3);
    // …and an existing photos value is never overwritten.
    const withPhotos = row({ address: "A", photos: ["https://x/1.jpg"] });
    expect(fillMissingPrefill(withPhotos, detail).photos).toEqual([
      "https://x/1.jpg",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildCompsViewport,
  haversineMi,
  median,
  normalizeStreet,
  rentCompsUrl,
  selectRentComps,
  selectSoldComps,
  soldCompsUrl,
  type CompsSubject,
} from "../lib/deals/comps";

// Fixed "now" for every selection test: 2026-10-18.
const NOW = new Date("2026-10-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => NOW.getTime() - d * DAY;

// Subject: 100 Main St, Indianapolis — (39.7700, -86.1500).
// 0.001 deg latitude ≈ 0.069 mi; 0.01 deg latitude ≈ 0.69 mi (outside).
const SUBJECT: CompsSubject = {
  address: "100 Main St, Indianapolis, IN 46204",
  zip: "46204",
  latitude: 39.77,
  longitude: -86.15,
  beds: 3,
  sqft: 1500,
  neighborhood: "Downtown",
  propertyId: 111,
};

type RowOpts = {
  street: string;
  price: number;
  lat?: number;
  lng?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  neighborhood?: string;
  propertyId?: number;
  soldDateMs?: number;
};

/** A tri_angle-shaped row (wrapped scalars, flat beds/propertyId). */
function row(o: RowOpts): Record<string, unknown> {
  return {
    price: { value: o.price, level: 1 },
    streetLine: { value: o.street, level: 1 },
    city: "Indianapolis",
    state: "IN",
    zip: "46204",
    latLong:
      o.lat !== undefined
        ? { value: { latitude: o.lat, longitude: o.lng ?? -86.15 }, level: 1 }
        : { level: 1 },
    location: o.neighborhood
      ? { value: o.neighborhood, level: 1 }
      : { level: 1 },
    beds: o.beds,
    baths: o.baths ?? 2,
    sqFt: o.sqft !== undefined ? { value: o.sqft, level: 1 } : { level: 1 },
    propertyId: o.propertyId,
    soldDate: o.soldDateMs,
    url: "https://www.redfin.com/IN/Indianapolis/x",
  };
}

const NEAR_A = row({
  street: "110 Main St",
  price: 300000,
  lat: 39.771, // ~0.07 mi
  beds: 3,
  sqft: 1500,
  neighborhood: "Downtown",
  propertyId: 222,
  soldDateMs: daysAgo(30),
});
const MID_B = row({
  street: "120 Main St",
  price: 280000,
  lat: 39.773, // ~0.21 mi
  beds: 4,
  sqft: 1400,
  neighborhood: "Downtown",
  propertyId: 333,
  soldDateMs: daysAgo(60),
});

describe("haversineMi", () => {
  it("is zero for the same point", () => {
    expect(haversineMi(39.77, -86.15, 39.77, -86.15)).toBe(0);
  });
  it("computes a known latitude distance", () => {
    // 0.01 deg of latitude ≈ 0.691 mi.
    expect(haversineMi(39.77, -86.15, 39.78, -86.15)).toBeCloseTo(0.691, 2);
  });
  it("computes a known longitude distance (shrinks with latitude)", () => {
    // 0.01 deg of longitude at 39.77 deg ≈ 0.531 mi.
    expect(haversineMi(39.77, -86.15, 39.77, -86.14)).toBeCloseTo(0.531, 2);
  });
});

describe("median", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("buildCompsViewport + feed URLs", () => {
  const vp = buildCompsViewport(39.77, -86.15);
  it("builds a 0.5-mile box with latitude-corrected longitude span", () => {
    expect(vp.north - 39.77).toBeCloseTo(0.5 / 69, 6);
    expect(39.77 - vp.south).toBeCloseTo(0.5 / 69, 6);
    const expectedLng = 0.5 / (69 * Math.cos((39.77 * Math.PI) / 180));
    expect(vp.east - -86.15).toBeCloseTo(expectedLng, 6);
    expect(-86.15 - vp.west).toBeCloseTo(expectedLng, 6);
  });
  it("sold URL carries the viewport and the sold-1yr include", () => {
    const url = soldCompsUrl("46204", vp);
    expect(url).toContain("https://www.redfin.com/zipcode/46204/filter/viewport=");
    expect(url).toContain(",no-outline,include=sold-1yr");
  });
  it("rent URL carries include=rentals before the viewport", () => {
    const url = rentCompsUrl("46204", vp);
    expect(url).toContain(
      "https://www.redfin.com/zipcode/46204/filter/include=rentals,viewport=",
    );
    expect(url).toContain(",no-outline");
  });
});

describe("normalizeStreet", () => {
  it("drops the unit and expands suffixes so the same property matches", () => {
    expect(normalizeStreet("225 N New Jersey St #27, Indianapolis, IN 46204")).toBe(
      normalizeStreet("225 N New Jersey Street, Indianapolis, IN 46204"),
    );
    expect(normalizeStreet("100 Main St, Indianapolis, IN 46204")).toBe(
      "100 main street",
    );
  });
});

describe("selectSoldComps", () => {
  it("selects in-window, in-radius comps and suggests MV from median $/sqft", () => {
    const { comps, suggestedMV, notes } = selectSoldComps(
      SUBJECT,
      [NEAR_A, MID_B],
      NOW,
    );
    expect(comps).toHaveLength(2);
    expect(comps[0].address).toContain("110 Main St");
    expect(comps[0].soldPrice).toBe(300000);
    expect(comps[0].soldDate).toBe(new Date(daysAgo(30)).toISOString());
    expect(comps[0].distanceMi).toBeCloseTo(0.07, 1);
    // median $/sqft = 200 (300k/1500 and 280k/1400) x subject 1500 sqft.
    expect(suggestedMV).toBe(300000);
    expect(notes).toEqual([]);
  });

  it("excludes sales older than 365 days and sales in the future", () => {
    const old = row({
      street: "130 Main St",
      price: 290000,
      lat: 39.771,
      beds: 3,
      sqft: 1450,
      propertyId: 444,
      soldDateMs: daysAgo(400),
    });
    const future = row({
      street: "140 Main St",
      price: 290000,
      lat: 39.771,
      beds: 3,
      sqft: 1450,
      propertyId: 445,
      soldDateMs: NOW.getTime() + 5 * DAY,
    });
    const edge = row({
      street: "150 Main St",
      price: 290000,
      lat: 39.771,
      beds: 3,
      sqft: 1450,
      propertyId: 446,
      soldDateMs: daysAgo(365),
    });
    const { comps } = selectSoldComps(SUBJECT, [NEAR_A, MID_B, old, future, edge], NOW);
    const streets = comps.map((c) => c.address);
    expect(streets.some((a) => a.includes("130 Main"))).toBe(false);
    expect(streets.some((a) => a.includes("140 Main"))).toBe(false);
    expect(streets.some((a) => a.includes("150 Main"))).toBe(true); // exactly 365d counts
  });

  it("excludes comps outside the 0.5-mile radius and rows without coordinates", () => {
    const far = row({
      street: "900 Far Ave",
      price: 290000,
      lat: 39.78, // ~0.69 mi
      beds: 3,
      sqft: 1450,
      propertyId: 447,
      soldDateMs: daysAgo(10),
    });
    const noCoords = row({
      street: "160 Main St",
      price: 290000,
      beds: 3,
      sqft: 1450,
      propertyId: 448,
      soldDateMs: daysAgo(10),
    });
    const { comps } = selectSoldComps(SUBJECT, [NEAR_A, MID_B, far, noCoords], NOW);
    expect(comps.map((c) => c.address)).toEqual([
      expect.stringContaining("110 Main"),
      expect.stringContaining("120 Main"),
    ]);
  });

  it("excludes the subject itself — by propertyId and by street", () => {
    const byId = row({
      street: "999 Other St",
      price: 310000,
      lat: 39.7705,
      beds: 3,
      sqft: 1500,
      propertyId: 111, // == subject propertyId
      soldDateMs: daysAgo(15),
    });
    const byStreet = row({
      street: "100 Main St",
      price: 310000,
      lat: 39.7705,
      beds: 3,
      sqft: 1500,
      propertyId: 999,
      soldDateMs: daysAgo(15),
    });
    const { comps, suggestedMV } = selectSoldComps(
      SUBJECT,
      [NEAR_A, MID_B, byId, byStreet],
      NOW,
    );
    expect(comps).toHaveLength(2);
    expect(suggestedMV).toBe(300000);
  });

  it("drops distress-priced outliers via the $/sqft screen", () => {
    const distress = row({
      street: "170 Main St",
      price: 60000, // $40/sqft vs a $200/sqft candidate median
      lat: 39.7708,
      beds: 3,
      sqft: 1500,
      propertyId: 450,
      soldDateMs: daysAgo(20),
    });
    const { comps } = selectSoldComps(SUBJECT, [NEAR_A, MID_B, distress], NOW);
    expect(comps.map((c) => c.address)).not.toContain(
      expect.stringContaining("170 Main"),
    );
    expect(comps).toHaveLength(2);
  });

  it("ranks same-neighborhood comps ahead of closer ones elsewhere", () => {
    const closerElsewhere = row({
      street: "105 Main St",
      price: 290000,
      lat: 39.7705, // ~0.03 mi
      beds: 3,
      sqft: 1450,
      neighborhood: "Lockerbie Terrace",
      propertyId: 451,
      soldDateMs: daysAgo(10),
    });
    const fartherSameHood = row({
      street: "180 Main St",
      price: 295000,
      lat: 39.774, // ~0.28 mi
      beds: 3,
      sqft: 1475,
      neighborhood: "Downtown",
      propertyId: 452,
      soldDateMs: daysAgo(10),
    });
    const noHoodSubject: CompsSubject = { ...SUBJECT };
    const { comps } = selectSoldComps(
      noHoodSubject,
      [closerElsewhere, fartherSameHood],
      NOW,
    );
    expect(comps[0].address).toContain("180 Main");
    expect(comps[1].address).toContain("105 Main");
  });

  it("applies the beds ±1 preference only when it leaves at least 2 comps", () => {
    const bigClose = row({
      street: "190 Main St",
      price: 500000,
      lat: 39.7705,
      beds: 6,
      sqft: 2500,
      propertyId: 453,
      soldDateMs: daysAgo(10),
    });
    const bigClose2 = row({
      street: "195 Main St",
      price: 520000,
      lat: 39.7706,
      beds: 7,
      sqft: 2600,
      propertyId: 454,
      soldDateMs: daysAgo(10),
    });
    // Two beds-matching comps (A, B) exist -> the 6/7-bed houses go.
    const filtered = selectSoldComps(SUBJECT, [NEAR_A, MID_B, bigClose, bigClose2], NOW);
    expect(filtered.comps.map((c) => c.address)).not.toContain(
      expect.stringContaining("190 Main"),
    );
    // Only ONE beds-matching comp -> preference is not applied.
    const unfiltered = selectSoldComps(SUBJECT, [NEAR_A, bigClose, bigClose2], NOW);
    expect(unfiltered.comps).toHaveLength(3);
  });

  it("falls back to median sold price when $/sqft math is unavailable", () => {
    const noSqftSubject: CompsSubject = { ...SUBJECT, sqft: undefined };
    const { suggestedMV } = selectSoldComps(noSqftSubject, [NEAR_A, MID_B], NOW);
    expect(suggestedMV).toBe(290000); // median(300000, 280000)
  });

  it("returns null + a note with fewer than 2 usable comps", () => {
    const { comps, suggestedMV, notes } = selectSoldComps(SUBJECT, [NEAR_A], NOW);
    expect(comps).toHaveLength(1); // the one comp still shows
    expect(suggestedMV).toBeNull();
    expect(notes.join(" ")).toMatch(/Only 1 usable sold comp/);
    const empty = selectSoldComps(SUBJECT, [], NOW);
    expect(empty.suggestedMV).toBeNull();
    expect(empty.notes.join(" ")).toMatch(/Only 0 usable sold comps/);
  });
});

describe("selectRentComps", () => {
  const RENT_1 = row({
    street: "210 Main St",
    price: 1550, // monthly rent lives in `price` on genuine rentals
    lat: 39.771,
    beds: 2,
    propertyId: 501,
  });
  const RENT_2 = row({
    street: "220 Main St",
    price: 1700,
    lat: 39.772,
    beds: 3,
    propertyId: 502,
  });

  it("selects in-radius rentals and suggests the median rent", () => {
    const { comps, suggestedRent, notes } = selectRentComps(SUBJECT, [
      RENT_1,
      RENT_2,
    ]);
    expect(comps).toHaveLength(2);
    expect(comps[0].rent).toBe(1550);
    expect(suggestedRent).toBe(1625); // median(1550, 1700)
    expect(notes).toEqual([]);
  });

  it("ignores for-sale rows the mixed rentals feed carries", () => {
    const saleRow = row({
      street: "230 Main St",
      price: 250000, // a list price, not a rent — outside the band
      lat: 39.771,
      beds: 3,
      propertyId: 503,
    });
    const pricey = row({
      street: "240 Main St",
      price: 9000, // above the plausible monthly-rent band
      lat: 39.771,
      beds: 3,
      propertyId: 504,
    });
    const { comps } = selectRentComps(SUBJECT, [RENT_1, RENT_2, saleRow, pricey]);
    expect(comps.map((c) => c.address)).toEqual([
      expect.stringContaining("210 Main"),
      expect.stringContaining("220 Main"),
    ]);
  });

  it("excludes rentals outside the radius and the subject itself", () => {
    const far = row({
      street: "950 Far Ave",
      price: 1500,
      lat: 39.78,
      beds: 3,
      propertyId: 505,
    });
    const selfRow = row({
      street: "100 Main St",
      price: 1600,
      lat: 39.7702,
      beds: 3,
      propertyId: 506,
    });
    const { comps } = selectRentComps(SUBJECT, [RENT_1, RENT_2, far, selfRow]);
    expect(comps).toHaveLength(2);
  });

  it("returns null + a note with fewer than 2 usable rentals", () => {
    const { suggestedRent, notes } = selectRentComps(SUBJECT, [RENT_1]);
    expect(suggestedRent).toBeNull();
    expect(notes.join(" ")).toMatch(/Only 1 usable rental comp/);
  });
});

import { describe, it, expect } from "vitest";
import { underwrite, motivationDiscount, gradeForFee } from "../lib/underwriting/model";

describe("motivation discount tiers", () => {
  it("300+ DOM -> 15%", () => expect(motivationDiscount(320, 0)).toBe(0.15));
  it("4+ cuts -> 15%", () => expect(motivationDiscount(10, 4)).toBe(0.15));
  it("200+ DOM -> 12%", () => expect(motivationDiscount(210, 0)).toBe(0.12));
  it("120+ DOM -> 8%", () => expect(motivationDiscount(120, 0)).toBe(0.08));
  it("1 cut -> 8%", () => expect(motivationDiscount(30, 1)).toBe(0.08));
  it("fresh listing -> 4%", () => expect(motivationDiscount(10, 0)).toBe(0.04));
});

describe("turnkey model v3.1", () => {
  // Meridian-like: rent $2,150, list $154,900, MV $215,000, taxes $2,400, insurance $1,500
  const r = underwrite({ mode: "turnkey", listPrice: 154900, monthlyRent: 2150, annualTaxes: 2400, annualInsurance: 1500, marketValue: 215000, dom: 100, priceCuts: 1 });
  it("computes NOI with 34% expense load", () => {
    // gross 25,800 * 0.66 = 17,028 - 2,400 - 1,500 = 13,128
    expect(r.noi).toBe(13128);
  });
  it("ceiling = min(NOI/5%, MV)", () => {
    // 13,128 / 0.05 = 262,560 -> capped by MV 215,000
    expect(r.buyerCeiling).toBe(215000);
  });
  it("MAO = min(ceiling - 15k, list)", () => {
    expect(r.mao).toBe(154900); // 200,000 vs list -> list cap binds
  });
  it("suggested contract below list with 8% discount (1 cut)", () => {
    expect(r.discountRate).toBe(0.08);
    expect(r.suggestedContract).toBe(142508);
  });
  it("fee is ceiling - contract", () => {
    expect(r.assignmentFee).toBe(215000 - 142508);
    expect(r.grade).toBe("A");
  });
  it("nothing unverified when all inputs supplied", () => {
    expect(r.unverified).toEqual([]);
  });
  it("flags missing inputs as unverified", () => {
    const bare = underwrite({ mode: "turnkey", listPrice: 100000 });
    expect(bare.unverified).toContain("monthlyRent");
    expect(bare.unverified).toContain("marketValue");
  });
  it("negative fee grades F", () => {
    const bad = underwrite({ mode: "turnkey", listPrice: 300000, monthlyRent: 1200, annualTaxes: 5000, annualInsurance: 1800, marketValue: 200000, dom: 5, priceCuts: 0 });
    expect(bad.grade).toBe("F");
  });
});

describe("flip + land", () => {
  it("flip MAO = 70% ARV - repairs - fee", () => {
    const f = underwrite({ mode: "flip", listPrice: 120000, arv: 200000, repairEstimate: 30000 });
    expect(f.mao).toBe(95000);
  });
  it("land MAO = 50% comp - fee, capped at list", () => {
    const l = underwrite({ mode: "land", listPrice: 60000, landCompValue: 90000 });
    expect(l.mao).toBe(30000);
  });
  it("grade thresholds", () => {
    expect(gradeForFee(15000)).toBe("A");
    expect(gradeForFee(10000)).toBe("B");
    expect(gradeForFee(5000)).toBe("C");
    expect(gradeForFee(4999)).toBe("D");
    expect(gradeForFee(-1)).toBe("F");
  });
});

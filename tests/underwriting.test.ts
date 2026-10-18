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

describe("turnkey model v3.2", () => {
  // Meridian-like: rent $2,150, list $154,900, MV $215,000, taxes $2,400, insurance $1,500
  const r = underwrite({ mode: "turnkey", listPrice: 154900, monthlyRent: 2150, annualTaxes: 2400, annualInsurance: 1500, marketValue: 215000, dom: 100, priceCuts: 1 });
  it("computes NOI with 34% expense load", () => {
    // gross 25,800 * 0.66 = 17,028 - 2,400 - 1,500 = 13,128
    expect(r.noi).toBe(13128);
  });
  it("ceiling = min(NOI/5%, list - 5%) — list-bound case", () => {
    // NOI/5% = 262,560; list - 5% = 147,155 -> the list term binds.
    // (Under v3.1 the ceiling was MV 215,000; MV is reference-only now.)
    expect(r.buyerCeiling).toBe(147155);
    expect(r.ceilingBinding).toBe("List − 5%");
  });
  it("MAO = min(ceiling - 15k, list) flows from the new ceiling", () => {
    expect(r.mao).toBe(132155); // 147,155 - 15,000
  });
  it("modeled contract uses the 8% motivation discount (1 cut)", () => {
    expect(r.discountRate).toBe(0.08);
    expect(r.modeledContract).toBe(142508);
  });
  it("initial offer is list - 10%; suggested contract caps at MAO when the opener exceeds it", () => {
    expect(r.initialOffer).toBe(139410); // 154,900 x 0.90
    expect(r.suggestedContract).toBe(132155); // opener 139,410 > MAO -> capped
  });
  it("fee is ceiling - initial offer", () => {
    expect(r.assignmentFee).toBe(147155 - 139410); // 7,745
    expect(r.grade).toBe("C");
  });
  it("ceiling NOI-bound case: NOI/5% below 0.95 x list binds", () => {
    const n = underwrite({ mode: "turnkey", listPrice: 200000, monthlyRent: 1300, annualTaxes: 3000, annualInsurance: 1500 });
    // NOI = 1300*12*0.66 - 4,500 = 5,796 -> NOI/5% = 115,920 < 190,000
    expect(n.buyerCeiling).toBe(115920);
    expect(n.ceilingBinding).toBe("NOI / 5%");
  });
  it("MV is no longer a ceiling term, even when MV is the lowest number", () => {
    const withMv = underwrite({ mode: "turnkey", listPrice: 200000, monthlyRent: 1300, annualTaxes: 3000, annualInsurance: 1500, marketValue: 100000 });
    // v3.1 would have capped the ceiling at MV 100,000; v3.2 ignores MV.
    expect(withMv.buyerCeiling).toBe(115920);
  });
  it("invariant: ceiling never exceeds list even when NOI/5% towers over it", () => {
    const hot = underwrite({ mode: "turnkey", listPrice: 100000, monthlyRent: 5000, annualTaxes: 1800, annualInsurance: 1500, marketValue: 500000 });
    // NOI = 60,000 x 0.66 - 3,300 = 36,300 -> NOI/5% = 726,000
    expect(hot.buyerCeiling).toBe(95000); // list - 5%
    expect(hot.buyerCeiling!).toBeLessThanOrEqual(100000);
    expect(hot.ceilingBinding).toBe("List − 5%");
  });
  it("suggested contract never exceeds MAO even when the opener does", () => {
    const tight = underwrite({ mode: "turnkey", listPrice: 200000, monthlyRent: 1300, annualTaxes: 3000, annualInsurance: 1500 });
    // ceiling = (1300*12*0.66 - 4500)/0.05 = 115,920 -> MAO 100,920 < list-10% 180,000
    expect(tight.initialOffer).toBe(180000);
    expect(tight.suggestedContract).toBe(tight.mao);
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

describe("turnkey editable expense rates", () => {
  const base = {
    mode: "turnkey" as const,
    listPrice: 154900,
    monthlyRent: 2150,
    annualTaxes: 2400,
    annualInsurance: 1500,
    marketValue: 215000,
  };

  it("defaults reproduce the standing 8/10/8/8 expense load", () => {
    const r = underwrite(base);
    expect(r.assumptions.vacancy).toBe(0.08);
    expect(r.assumptions.management).toBe(0.1);
    expect(r.assumptions.maintenance).toBe(0.08);
    expect(r.assumptions.capex).toBe(0.08);
    expect(r.noi).toBe(13128);
  });

  it("zeroed rates remove the whole expense load from NOI", () => {
    const r = underwrite({
      ...base,
      vacancyRate: 0,
      managementRate: 0,
      maintenanceRate: 0,
      capexRate: 0,
    });
    // gross 25,800 - 2,400 taxes - 1,500 insurance = 21,900
    expect(r.noi).toBe(21900);
    expect(r.assumptions.vacancy).toBe(0);
    expect(r.assumptions.management).toBe(0);
  });

  it("a partial override changes only that rate", () => {
    const r = underwrite({ ...base, managementRate: 0.05 });
    // load = 8 + 5 + 8 + 8 = 29% -> NOI = 25,800 x 0.71 - 3,900 = 14,418
    expect(r.noi).toBe(14418);
    expect(r.assumptions.management).toBe(0.05);
    expect(r.assumptions.vacancy).toBe(0.08);
    expect(r.explanation[0]).toContain("5% management");
    expect(r.explanation[0]).toContain("8% vacancy");
  });

  it("edited taxes / insurance / HOA flow through as supplied dollars", () => {
    const r = underwrite({
      ...base,
      annualTaxes: 5000,
      annualInsurance: 2400,
      monthlyHoa: 100,
    });
    // NOI = 17,028 - 5,000 - 2,400 - 1,200 = 8,428
    expect(r.noi).toBe(8428);
    expect(r.assumptions.annualTaxes).toBe(5000);
    expect(r.assumptions.annualInsurance).toBe(2400);
    expect(r.unverified).not.toContain("annualTaxes");
    expect(r.unverified).not.toContain("annualInsurance");
  });
});

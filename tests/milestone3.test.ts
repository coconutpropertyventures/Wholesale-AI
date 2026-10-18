import { describe, it, expect } from "vitest";
import { underwrite } from "../lib/underwriting/model";
import {
  DISTRESSED_OPENER,
  LAND_OPENER,
  TURNKEY_OPENER,
  firstMessageTemplate,
  offerMessage,
} from "../lib/comms/scripts";
import { parseListingUrl } from "../lib/deals/parse";
import { mapApifyRow, mapRedfinRow } from "../lib/deals/prefill";
import {
  buildPipelineMap,
  isDealEntry,
  shortStageName,
  stageCounts,
  ACQUISITIONS_ID,
  DISPOSITIONS_ID,
  PRE_SCREENING_ID,
  WHOLESALE_ID,
} from "../lib/ghl/pipelineMap";
import type { GhlOpportunity } from "../lib/ghl/client";
import {
  isUnderContractOpp,
  matchUnderContract,
  streetKey,
} from "../lib/deals/underContract";
import {
  mapRentcastProperty,
  mapRentcastRent,
  mapRentcastValue,
} from "../lib/rentcast/client";
import {
  assignedUsesByDraftId,
  winningExamples,
} from "../lib/learning";
import {
  buildDraftPrompt,
  estimateCostUsd,
  monthCostUsd,
  pricingFor,
  selectDraftModel,
  withinBudget,
} from "../lib/ai/draft";
import type { AiUsageEntry, MessageOutcome } from "../lib/types";

// ---------- Traditional wholesale math ----------

describe("traditional wholesale model", () => {
  it("ceiling = 70% of ARV; MAO = ceiling - repairs - fee; fee is the output", () => {
    const r = underwrite({
      mode: "traditional",
      listPrice: 130000,
      arv: 200000,
      repairEstimate: 20000,
    });
    expect(r.buyerCeiling).toBe(140000);
    expect(r.mao).toBe(105000);
    expect(r.assignmentFee).toBe(15000);
    expect(r.initialOffer).toBe(105000);
    expect(r.grade).toBe("A");
    expect(r.unverified).toEqual([]);
  });

  it("caps MAO at list price, which raises the realized fee", () => {
    const r = underwrite({
      mode: "traditional",
      listPrice: 100000,
      arv: 200000,
      repairEstimate: 0,
    });
    // raw MAO = 140,000 - 0 - 15,000 = 125,000 -> capped at list 100,000
    expect(r.mao).toBe(100000);
    expect(r.assignmentFee).toBe(40000);
    expect(r.grade).toBe("A");
  });

  it("floors MAO at 0 and grades F when repairs eat the ceiling", () => {
    const r = underwrite({
      mode: "traditional",
      listPrice: 90000,
      arv: 100000,
      repairEstimate: 80000,
    });
    expect(r.mao).toBe(0);
    expect(r.assignmentFee).toBe(-10000);
    expect(r.grade).toBe("F");
  });

  it("grades B when the floored MAO leaves a mid fee", () => {
    const r = underwrite({
      mode: "traditional",
      listPrice: 90000,
      arv: 150000,
      repairEstimate: 78000,
      wholesalePercent: 0.6,
    });
    // ceiling 90,000; raw MAO negative -> 0; fee = 90,000 - 78,000 = 12,000
    expect(r.assignmentFee).toBe(12000);
    expect(r.grade).toBe("B");
  });

  it("honors a wholesalePercent override and flags missing inputs", () => {
    const r = underwrite({ mode: "traditional", listPrice: 50000 });
    expect(r.unverified).toContain("arv");
    expect(r.unverified).toContain("repairEstimate");
  });
});

// ---------- Exact first-message strings ----------

describe("approved first-message scripts (exact)", () => {
  it("turnkey opener is character-for-character", () => {
    expect(TURNKEY_OPENER).toBe(
      "Hi {first}, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I work with a network of buyers across the U.S. I saw your listing at {street} has been on the market for a while. Is the seller open to negotiating? Reply STOP to unsubscribe.",
    );
  });
  it("distressed opener is character-for-character", () => {
    expect(DISTRESSED_OPENER).toBe(
      "Hi {first}, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I buy houses as-is for cash, even ones needing major work. I saw your listing at {street} — would the seller consider a cash as-is offer below list? I cover all repairs and can close fast. Reply STOP to unsubscribe.",
    );
  });
  it("land opener is character-for-character", () => {
    expect(LAND_OPENER).toBe(
      "Hi {first}, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I saw your land listing at {street} — is the seller open to negotiating? I can close quickly with cash. Reply STOP to unsubscribe.",
    );
  });
  it("mode mapping picks the right template", () => {
    expect(firstMessageTemplate("turnkey")).toBe(TURNKEY_OPENER);
    expect(firstMessageTemplate("traditional")).toBe(DISTRESSED_OPENER);
    expect(firstMessageTemplate("land")).toBe(LAND_OPENER);
  });
  it("offer message fills first/street/offer and carries the number", () => {
    expect(offerMessage("Debra", "2309 S Meridian St", "$142,000")).toBe(
      "Hi Debra, Bradley Post with Coconut Property Ventures. I ran the numbers on 2309 S Meridian St with my partners — we could do $142,000 and close quickly. Let me know if that works for the seller and I'll get paperwork over.",
    );
  });
});

// ---------- URL parsing ----------

describe("parseListingUrl", () => {
  it("parses a Zillow homedetails URL", () => {
    const p = parseListingUrl(
      "https://www.zillow.com/homedetails/2309-S-Meridian-St-Indianapolis-IN-46225/22674623_zpid/",
    );
    expect(p.source).toBe("zillow");
    expect(p.address).toBe("2309 S Meridian St, Indianapolis, IN 46225");
    expect(p.city).toBe("Indianapolis");
    expect(p.state).toBe("IN");
    expect(p.zip).toBe("46225");
    expect(p.externalId).toBe("22674623");
  });

  it("parses a Redfin URL with state/city segments", () => {
    const p = parseListingUrl(
      "https://www.redfin.com/IN/Indianapolis/2309-S-Meridian-St-46225/home/98765432",
    );
    expect(p.source).toBe("redfin");
    expect(p.address).toBe("2309 S Meridian St, Indianapolis, IN 46225");
    expect(p.city).toBe("Indianapolis");
    expect(p.state).toBe("IN");
    expect(p.zip).toBe("46225");
    expect(p.externalId).toBe("98765432");
  });

  it("does not mistake a trailing St suffix for a state", () => {
    const p = parseListingUrl(
      "https://www.redfin.com/IN/Indianapolis/4118-Seabreeze-Rd/home/123",
    );
    expect(p.state).toBe("IN");
    expect(p.address).toContain("4118 Seabreeze Rd");
  });

  it("returns other for non-listing input", () => {
    expect(parseListingUrl("not a url").source).toBe("other");
    expect(parseListingUrl("https://example.com/foo").source).toBe("other");
  });
});

// ---------- Actor row mapping ----------

describe("mapApifyRow / mapRedfinRow", () => {
  it("maps a Zillow detail row with nested address and string price", () => {
    const p = mapApifyRow({
      address: {
        streetAddress: "2309 S Meridian St",
        city: "Indianapolis",
        state: "IN",
        zipcode: "46225",
      },
      price: "$154,900",
      bedrooms: 3,
      bathrooms: 2,
      livingArea: 1450,
      zestimate: 215000,
      rentZestimate: 2150,
      daysOnZillow: 100,
      yearBuilt: 1910,
      url: "https://www.zillow.com/homedetails/x",
    });
    expect(p.address).toBe("2309 S Meridian St, Indianapolis, IN 46225");
    expect(p.listPrice).toBe(154900);
    expect(p.valueEstimate).toBe(215000);
    expect(p.rentEstimate).toBe(2150);
    expect(p.sqft).toBe(1450);
    expect(p.daysOnMarket).toBe(100);
    expect(p.source).toBe("zillow");
  });

  it("maps a Redfin search row", () => {
    const p = mapRedfinRow({
      address: "3426 Lancing Ct, Macon, GA 31206",
      price: 79000,
      beds: 3,
      baths: 1.5,
      sqft: "1,280",
      daysOnMarket: 267,
      redfinEstimate: 85000,
      url: "https://www.redfin.com/GA/Macon/x/home/1",
    });
    expect(p.address).toBe("3426 Lancing Ct, Macon, GA 31206");
    expect(p.listPrice).toBe(79000);
    expect(p.beds).toBe(3);
    expect(p.baths).toBe(1.5);
    expect(p.sqft).toBe(1280);
    expect(p.daysOnMarket).toBe(267);
    expect(p.valueEstimate).toBe(85000);
    expect(p.source).toBe("redfin");
  });

  it("leaves missing fields undefined instead of inventing them", () => {
    const p = mapRedfinRow({ url: "https://www.redfin.com/x" });
    expect(p.listPrice).toBeUndefined();
    expect(p.valueEstimate).toBeUndefined();
    expect(p.rentEstimate).toBeUndefined();
  });
});

// ---------- Pipeline map ----------

const OPP = (
  partial: Partial<GhlOpportunity>,
): GhlOpportunity => ({
  id: "o1",
  name: "2309 S Meridian St",
  contactId: "c1",
  pipelineId: PRE_SCREENING_ID,
  pipelineStageId: "b6db489b-8214-4f32-8cdc-3d2404747b3b",
  status: "open",
  ...partial,
});

describe("pipelineMap helpers", () => {
  it("shortens decorated stage names", () => {
    expect(shortStageName("🚨 NEW PROSPECT 🚨")).toBe("New Prospect");
    expect(shortStageName("CALLED BACK / REPLIED 📲")).toBe("Called Back / Replied");
    expect(shortStageName("30-90 DAY FOLLOW-UPS 🥶")).toBe("30-90 Day Follow-ups");
    expect(shortStageName("Under Contract")).toBe("Under Contract");
  });

  it("flags deal entries by pipeline and by stage", () => {
    expect(isDealEntry(DISPOSITIONS_ID, "241ead91-e3c7-49e2-ba0c-be46d8e7a60f")).toBe(true);
    expect(isDealEntry(WHOLESALE_ID, "096e7186-19ef-43dc-b78a-f4ba11f1de2c")).toBe(true);
    expect(isDealEntry(ACQUISITIONS_ID, "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902")).toBe(true);
    expect(isDealEntry(PRE_SCREENING_ID, "b6db489b-8214-4f32-8cdc-3d2404747b3b")).toBe(false);
    expect(isDealEntry(ACQUISITIONS_ID, "d6e2ace3-8388-496e-8a3b-a0848d06ebdc")).toBe(false);
  });

  it("builds a per-contact map, deal entries first", () => {
    const map = buildPipelineMap([
      OPP({ id: "o1" }),
      OPP({
        id: "o2",
        pipelineId: DISPOSITIONS_ID,
        pipelineStageId: "241ead91-e3c7-49e2-ba0c-be46d8e7a60f",
      }),
    ]);
    const entries = map["c1"];
    expect(entries).toHaveLength(2);
    expect(entries[0].pipelineName).toBe("Dispositions");
    expect(entries[0].isDeal).toBe(true);
    expect(entries[1].pipelineName).toBe("Pre-Screening");
    expect(entries[1].stageName).toBe("🚨 NEW PROSPECT 🚨");
  });

  it("counts open opps per pipeline:stage", () => {
    const counts = stageCounts([OPP({ id: "o1" }), OPP({ id: "o2" }), OPP({ id: "o3", contactId: "c2" })]);
    expect(counts[`${PRE_SCREENING_ID}:b6db489b-8214-4f32-8cdc-3d2404747b3b`]).toBe(3);
  });
});

// ---------- Under-contract matcher ----------

describe("under-contract matcher", () => {
  it("derives street keys, skipping directionals", () => {
    expect(streetKey("2309 S Meridian St, Indianapolis, IN 46225")).toBe("2309 meridian");
    expect(streetKey("4118 Seabreeze Rd N, Mobile, AL")).toBe("4118 seabreeze");
    expect(streetKey("No number in this string")).toBeNull();
  });

  it("matches Dispositions opps (any stage) by address", () => {
    const opps = [
      OPP({
        pipelineId: DISPOSITIONS_ID,
        pipelineStageId: "241ead91-e3c7-49e2-ba0c-be46d8e7a60f",
        name: "2309 S Meridian St, Indianapolis, IN 46225",
      }),
    ];
    expect(matchUnderContract(opps, "2309 S Meridian St")?.id).toBe("o1");
  });

  it("does not match acquisition-stage or pre-screening opps", () => {
    const acqLead = OPP({
      pipelineId: ACQUISITIONS_ID,
      pipelineStageId: "d6e2ace3-8388-496e-8a3b-a0848d06ebdc",
    });
    expect(isUnderContractOpp(acqLead)).toBe(false);
    expect(matchUnderContract([acqLead], "2309 S Meridian St")).toBeNull();
    expect(matchUnderContract([OPP({})], "2309 S Meridian St")).toBeNull();
  });

  it("matches Wholesale Under Contract and Acquisitions MOVED TO DISPO", () => {
    const wholesale = OPP({
      id: "w1",
      pipelineId: WHOLESALE_ID,
      pipelineStageId: "3091dd5c-b4a1-481d-8d37-a62ff4ea247f",
      name: "2309 Meridian St",
    });
    expect(matchUnderContract([wholesale], "2309 S Meridian St, Indianapolis")?.id).toBe("w1");
    const moved = OPP({
      id: "a1",
      pipelineId: ACQUISITIONS_ID,
      pipelineStageId: "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902",
    });
    expect(matchUnderContract([moved], "2309 S Meridian St")?.id).toBe("a1");
  });

  it("does not match a different house number on the same street", () => {
    const opps = [
      OPP({
        pipelineId: DISPOSITIONS_ID,
        pipelineStageId: "241ead91-e3c7-49e2-ba0c-be46d8e7a60f",
        name: "2311 S Meridian St",
      }),
    ];
    expect(matchUnderContract(opps, "2309 S Meridian St")).toBeNull();
  });
});

// ---------- RentCast mappers ----------

describe("rentcast mappers", () => {
  it("maps value, rent, and property payloads", () => {
    expect(
      mapRentcastValue({ price: 215000, priceRangeLow: 200000, priceRangeHigh: 230000 }),
    ).toEqual({ valueEstimate: 215000, valueLow: 200000, valueHigh: 230000 });
    expect(mapRentcastRent({ rent: 2150, rentRangeLow: 2000, rentRangeHigh: 2300 })).toEqual({
      rentEstimate: 2150,
      rentLow: 2000,
      rentHigh: 2300,
    });
    expect(
      mapRentcastProperty({ bedrooms: 3, bathrooms: 2, squareFootage: 1280, yearBuilt: 1972 }),
    ).toEqual({ beds: 3, baths: 2, sqft: 1280, yearBuilt: 1972 });
  });
});

// ---------- Learning loop ----------

const OUTCOME = (partial: Partial<MessageOutcome>): MessageOutcome => ({
  id: "oc1",
  organizationId: "org",
  draftId: "d1",
  address: "2309 S Meridian St, Indianapolis, IN 46225",
  mode: "turnkey",
  variant: "first",
  body: "Hi Debra, opener…",
  createdAt: "2026-10-10T00:00:00.000Z",
  ...partial,
});

describe("learning loop v1", () => {
  const assigned = OPP({
    id: "deal1",
    pipelineId: DISPOSITIONS_ID,
    pipelineStageId: "d1fe69fc-c8c7-4c9e-88dc-5eae4a2e8323",
    name: "2309 S Meridian St, Indianapolis, IN 46225",
  });

  it("counts a pattern only when its address reached an assigned deal", () => {
    const uses = assignedUsesByDraftId(
      [OUTCOME({}), OUTCOME({ id: "oc2", draftId: "d2", address: "999 Other St" })],
      [assigned],
    );
    expect(uses["d1"]).toBe(1);
    expect(uses["d2"]).toBeUndefined();
  });

  it("returns winning examples for the matching variant only", () => {
    const wins = winningExamples(
      [OUTCOME({}), OUTCOME({ id: "oc3", draftId: "d3", variant: "offer" })],
      [assigned],
      "offer",
    );
    expect(wins).toHaveLength(1);
    expect(wins[0].draftId).toBe("d3");
  });

  it("no assigned deals -> no wins, no labels", () => {
    expect(assignedUsesByDraftId([OUTCOME({})], [])).toEqual({});
    expect(winningExamples([OUTCOME({})], [], "first")).toEqual([]);
  });
});

// ---------- AI drafting cost control ----------

describe("ai draft cost control", () => {
  it("prices the two model families", () => {
    expect(pricingFor("claude-haiku-4-5")).toEqual({
      inputPerM: 1,
      outputPerM: 5,
      cacheReadPerM: 0.1,
    });
    expect(pricingFor("claude-sonnet-5")).toEqual({
      inputPerM: 2,
      outputPerM: 10,
      cacheReadPerM: 0.2,
    });
  });

  it("estimates a call's cost from its token usage", () => {
    // 1,000 fresh in ($1/M) + 5,000 cached ($0.10/M) + 100 out ($5/M)
    // = (1000 + 500 + 500) / 1e6 = $0.002
    expect(
      estimateCostUsd("claude-haiku-4-5", {
        inputTokens: 1000,
        cachedTokens: 5000,
        outputTokens: 100,
      }),
    ).toBeCloseTo(0.002, 9);
  });

  it("sums only this month's usage", () => {
    const mk = (createdAt: string): AiUsageEntry => ({
      id: createdAt,
      organizationId: "org",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
      purpose: "draft-offer",
      createdAt,
    });
    const now = new Date("2026-10-18T12:00:00.000Z");
    expect(
      monthCostUsd([mk("2026-10-02T00:00:00.000Z"), mk("2026-09-30T23:00:00.000Z")], now),
    ).toBeCloseTo(1, 9);
  });

  it("budget gate refuses at or over budget", () => {
    expect(withinBudget(24.99, 25)).toBe(true);
    expect(withinBudget(25, 25)).toBe(false);
    expect(withinBudget(30, 25)).toBe(false);
  });

  it("escalates at the fee threshold or on request", () => {
    expect(selectDraftModel(1000).escalated).toBe(false);
    expect(selectDraftModel(25000).escalated).toBe(true);
    expect(selectDraftModel(1000, true).escalated).toBe(true);
  });

  it("prompt assembly caps winning examples at 3 and includes the avoid example", () => {
    const examples = [1, 2, 3, 4, 5].map((i) =>
      OUTCOME({ id: `e${i}`, draftId: `dx${i}`, body: `winning body ${i}` }),
    );
    const prompt = buildDraftPrompt({
      first: "Debra",
      street: "2309 S Meridian St",
      address: "2309 S Meridian St, Indianapolis, IN 46225",
      offerFormatted: "$142,000",
      mode: "turnkey",
      fee: 9500,
      examples,
      avoidExample: OUTCOME({ id: "bad", draftId: "dbad", body: "rejected body" }),
    });
    expect(prompt.exampleCount).toBe(3);
    expect(prompt.userText).toContain("winning body 1");
    expect(prompt.userText).toContain("winning body 3");
    expect(prompt.userText).not.toContain("winning body 4");
    expect(prompt.userText).toContain("rejected body");
    expect(prompt.userText).toContain("$142,000");
    expect(prompt.systemText).toContain("NEVER say wholesaler");
    expect(prompt.systemText).toContain("{offer}");
  });
});

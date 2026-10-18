import { describe, expect, it } from "vitest";
import {
  mapApifyRow,
  mapRedfinDetailRow,
  mapRedfinRow,
  unwrap,
} from "../lib/deals/prefill";

// tri_angle/redfin-search returns Redfin's NATIVE row shape: scalar
// fields wrapped as { value: X, level: n } (price, streetLine, sqFt,
// hoa, dom, yearBuilt, postalCode, unitNumber, latLong) mixed with flat
// fields (beds, baths, city, state, zip, url, listingRemarks). The
// fixture below is copied from a verified live row (ZIP 46204 search,
// 2026-10-18). Before the unwrap fix every wrapped field read as
// undefined and the search route's (address || listPrice) filter
// dropped all 61 rows.
const TRIANGLE_ROW = {
  price: { value: 325000, level: 1 },
  streetLine: { value: "225 N New Jersey St #27", level: 1 },
  unitNumber: { value: "#27", level: 1 },
  sqFt: { value: 1237, level: 1 },
  hoa: { value: 485, level: 1 },
  pricePerSqFt: { value: 263, level: 1 },
  dom: { value: 17, level: 1 },
  yearBuilt: { value: 2003, level: 1 },
  postalCode: { value: "46204", level: 1 },
  latLong: { value: { latitude: 39.7705817, longitude: -86.1500539 }, level: 1 },
  lotSize: { level: 1 }, // wrapper with NO value key -> stays absent
  beds: 2,
  baths: 2,
  fullBaths: 2,
  city: "Indianapolis",
  state: "IN",
  zip: "46204",
  url: "https://www.redfin.com/IN/Indianapolis/225-N-New-Jersey-St-46204/unit-27/home/199882420",
  listingRemarks:
    "Freshly updated  &  ready for its next chapter, this stylish Lockerbie Terrace condo pairs modern finishes with an unbeatable downtown lifestyle.",
  mlsStatus: "Active",
  propertyId: 199882420,
  listingId: 223979626,
  numPictures: 32,
  // Encoded photo ranges, NOT usable URLs — must never land anywhere.
  photos: { value: "0-22:0,23:1,24-31:0", level: 1 },
};

describe("unwrap", () => {
  it("unwraps a { value } wrapper one level", () => {
    expect(unwrap({ value: 325000, level: 1 })).toBe(325000);
    expect(unwrap({ value: "46204", level: 1 })).toBe("46204");
    expect(unwrap({ value: { latitude: 1 }, level: 1 })).toEqual({
      latitude: 1,
    });
  });

  it("passes flat values through unchanged", () => {
    expect(unwrap(325000)).toBe(325000);
    expect(unwrap("46204")).toBe("46204");
    expect(unwrap(undefined)).toBeUndefined();
    expect(unwrap(null)).toBeNull();
    // A plain nested object (Zillow address) is NOT a wrapper.
    expect(unwrap({ streetAddress: "1 Main St" })).toEqual({
      streetAddress: "1 Main St",
    });
  });

  it("treats a wrapper without a value key as absent downstream", () => {
    // { level: 1 } has no value to unwrap to; it passes through as an
    // object and the numeric/string readers reject it.
    const p = mapRedfinRow({ sqFt: { level: 1 }, price: { level: 1 } });
    expect(p.sqft).toBeUndefined();
    expect(p.listPrice).toBeUndefined();
  });
});

describe("mapRedfinRow with the wrapped tri_angle shape", () => {
  const p = mapRedfinRow(TRIANGLE_ROW);

  it("maps the wrapped core fields", () => {
    expect(p.listPrice).toBe(325000);
    expect(p.sqft).toBe(1237);
    expect(p.daysOnMarket).toBe(17);
    expect(p.yearBuilt).toBe(2003);
    expect(p.hoaMonthly).toBe(485);
    expect(p.source).toBe("redfin");
  });

  it("composes the address from streetLine + city/state/zip", () => {
    expect(p.address).toBe("225 N New Jersey St #27, Indianapolis, IN 46204");
    expect(p.city).toBe("Indianapolis");
    expect(p.state).toBe("IN");
    expect(p.zip).toBe("46204");
  });

  it("does not duplicate the unit already inside streetLine", () => {
    expect(p.address?.match(/#27/g)).toHaveLength(1);
  });

  it("maps the flat fields and the source URL / remarks", () => {
    expect(p.beds).toBe(2);
    expect(p.baths).toBe(2);
    expect(p.sourceUrl).toBe(TRIANGLE_ROW.url);
    expect(p.description).toContain("Freshly updated");
  });

  it("never invents agent details — the search rows carry none", () => {
    expect(p.agentName).toBeUndefined();
    expect(p.agentPhone).toBeUndefined();
    expect(p.agentEmail).toBeUndefined();
  });

  it("appends the unit when streetLine does not already include it", () => {
    const q = mapRedfinRow({
      streetLine: { value: "333 Massachusetts Ave", level: 1 },
      unitNumber: { value: "#902", level: 1 },
      city: "Indianapolis",
      state: "IN",
      zip: "46204",
    });
    expect(q.address).toBe("333 Massachusetts Ave #902, Indianapolis, IN 46204");
  });

  it("falls back to the wrapped postalCode when flat zip is absent", () => {
    const q = mapRedfinRow({
      streetLine: { value: "10 W Ohio St", level: 1 },
      city: "Indianapolis",
      state: "IN",
      postalCode: { value: "46204", level: 1 },
    });
    expect(q.zip).toBe("46204");
    expect(q.address).toBe("10 W Ohio St, Indianapolis, IN 46204");
  });
});

describe("mapApifyRow flat-row regression (maxcopell Zillow shape)", () => {
  it("maps a flat row exactly as before the unwrap change", () => {
    const p = mapApifyRow({
      address: "3119 Cold Spring Rd, Indianapolis, IN 46222",
      price: 119000,
      beds: 3,
      baths: 1,
      sqft: 1056,
      yearBuilt: 1925,
      daysOnMarket: 140,
      zestimate: 121000,
      rentZestimate: 1250,
      url: "https://www.zillow.com/homedetails/x",
    });
    expect(p.address).toBe("3119 Cold Spring Rd, Indianapolis, IN 46222");
    expect(p.listPrice).toBe(119000);
    expect(p.beds).toBe(3);
    expect(p.baths).toBe(1);
    expect(p.sqft).toBe(1056);
    expect(p.yearBuilt).toBe(1925);
    expect(p.daysOnMarket).toBe(140);
    expect(p.valueEstimate).toBe(121000);
    expect(p.rentEstimate).toBe(1250);
    expect(p.sourceUrl).toBe("https://www.zillow.com/homedetails/x");
    expect(p.source).toBe("zillow");
  });

  it("still coerces string prices on flat rows", () => {
    const p = mapApifyRow({ price: "$154,900", livingArea: "1,450 sqft" });
    expect(p.listPrice).toBe(154900);
    expect(p.sqft).toBe(1450);
  });
});

// memo23/apify-redfin-cheerio dumps the whole Redfin detail page.
// The fixture mirrors the verified live row for 225 N New Jersey St
// (dataset AaApW7NmuBmfM6neq, 2026-10-18): the listing agent lives in
// the MLS disclaimer block, surrounded by Redfin's OWN agents
// (askAgent / recommendedAgent / offerInsights) who must never be
// picked up, and empty row-level contact fields.
const MEMO23_DETAIL_ROW = {
  url: "https://www.redfin.com/IN/Indianapolis/225-N-New-Jersey-St-46204/unit-27/home/199882420",
  streetAddress: "225 N New Jersey St #27",
  city: "Indianapolis",
  stateOrProvinceCode: "IN",
  postalCode: "46204",
  primaryListingAgentName: "Timothy Birky",
  primaryListingAgentFirstName: "Timothy",
  primaryListingAgentLastName: "Birky",
  mlsDisclaimerInfo: {
    listingAgentName: "Timothy Birky",
    listingAgentNumber: "317-550-0700",
    listingBrokerName: "F.C. Tucker Company",
    listingBrokerNumber: "317-843-7766",
  },
  mainHouseInfo: {
    listingAgents: [
      {
        agentInfo: { agentName: "Timothy Birky", fullName: "Timothy Birky" },
        brokerName: "F.C. Tucker Company",
      },
      {
        agentInfo: { agentName: "Nicholas McNeely", fullName: "Nicholas McNeely" },
        brokerName: "F.C. Tucker Company",
      },
    ],
  },
  // Decoys — Redfin's touring / partner agents, NOT the listing agent.
  askAgent: {
    agent: { name: "Craig McLaurin", first_name: "Craig", last_name: "McLaurin" },
    phoneNumber: "(317) 854-4904",
    profilePhoneNumber: "(317) 743-3137",
  },
  askAgentFullName: "Craig McLaurin",
  recommendedAgent: { phoneNumber: "317-625-2649", brokerageName: "Redfin" },
  offerInsights: {
    sections: [{ agentInfoDisplay: { agentName: "Dru Cornett" } }],
  },
  contactName: "",
  contactPhone: "",
  contactEmail: "",
};

describe("mapRedfinDetailRow (memo23 Redfin detail)", () => {
  it("reads the listing agent from the MLS disclaimer block", () => {
    const d = mapRedfinDetailRow(MEMO23_DETAIL_ROW);
    expect(d.agentName).toBe("Timothy Birky");
    expect(d.agentPhone).toBe("317-550-0700");
    expect(d.agentBrokerage).toBe("F.C. Tucker Company");
  });

  it("never maps Redfin's own agents or the broker office line", () => {
    const d = mapRedfinDetailRow(MEMO23_DETAIL_ROW);
    expect(d.agentName).not.toBe("Craig McLaurin");
    expect(d.agentName).not.toBe("Dru Cornett");
    expect(d.agentPhone).not.toBe("317-843-7766"); // broker office number
    expect(d.agentPhone).not.toBe("(317) 854-4904"); // askAgent (Redfin)
    expect(d.agentPhone).not.toBe("317-625-2649"); // recommendedAgent (Redfin)
  });

  it("composes the address and carries the listing URL", () => {
    const d = mapRedfinDetailRow(MEMO23_DETAIL_ROW);
    expect(d.address).toBe("225 N New Jersey St #27, Indianapolis, IN 46204");
    expect(d.sourceUrl).toBe(MEMO23_DETAIL_ROW.url);
  });

  it("falls back to primaryListingAgentName, then mainHouseInfo, for the name", () => {
    const noDisclaimer = { ...MEMO23_DETAIL_ROW, mlsDisclaimerInfo: undefined };
    expect(mapRedfinDetailRow(noDisclaimer).agentName).toBe("Timothy Birky");
    const onlyMainHouse = {
      mainHouseInfo: MEMO23_DETAIL_ROW.mainHouseInfo,
    };
    expect(mapRedfinDetailRow(onlyMainHouse).agentName).toBe("Timothy Birky");
  });

  it("yields no phone when listingAgentNumber is absent — the broker number is not a substitute", () => {
    const d = mapRedfinDetailRow({
      mlsDisclaimerInfo: {
        listingAgentName: "No Phone Nancy",
        listingBrokerName: "Some Broker LLC",
        listingBrokerNumber: "317-843-7766",
      },
      primaryListingAgentName: "No Phone Nancy",
    });
    expect(d.agentName).toBe("No Phone Nancy");
    expect(d.agentPhone).toBeUndefined();
    expect(d.agentBrokerage).toBe("Some Broker LLC");
  });

  it("returns an empty detail for an empty row", () => {
    expect(mapRedfinDetailRow({})).toEqual({
      agentName: undefined,
      agentPhone: undefined,
      agentBrokerage: undefined,
      address: undefined,
      sourceUrl: undefined,
    });
  });
});

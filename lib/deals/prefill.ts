// Normalized listing data used to prefill the underwriting workbench.
// Mappers are defensive by design: Apify Actors (third-party, many
// authors) return differently-shaped rows, so every field is read from
// several candidate keys and anything absent stays undefined — values are
// never invented. Redfin-native Actors (tri_angle/redfin-search) wrap
// scalar fields as { value: X, level: n }; the shared readers below
// unwrap one level so wrapped and flat rows map identically.

export interface DealPrefill {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  listPrice?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  /** HOA dues as reported by the listing (Redfin's `hoa` field, monthly
   *  on listing pages). Mapped verbatim; not auto-applied to the
   *  underwriting form, whose HOA input stays operator-entered. */
  hoaMonthly?: number;
  yearBuilt?: number;
  /** Coordinates from the listing row (tri_angle `latLong`), when the
   *  Actor reports them. The turnkey comps engine anchors its 0.5-mile
   *  viewport on these; absent → the address is geocoded instead. */
  latitude?: number;
  longitude?: number;
  /** Neighborhood name (tri_angle `location`), when reported. The
   *  comps engine ranks same-neighborhood comps first. */
  neighborhood?: string;
  /** Redfin property id, when the row carries one. Used by the comps
   *  engine to exclude the subject property from its own comp set. */
  propertyId?: number;
  /** Annual property taxes, when a (detail) source reports them.
   *  Read defensively; absent stays absent and the calculator flags
   *  its estimate UNVERIFIED rather than inventing a figure. */
  annualTaxes?: number;
  /** Annual homeowners insurance, when a source reports it. */
  annualInsurance?: number;
  valueEstimate?: number;
  rentEstimate?: number;
  daysOnMarket?: number;
  sourceUrl?: string;
  /** Listing description / remarks text, when the Actor returns it. */
  description?: string;
  /** Listing agent details, when the Actor's detail data carries them.
   *  Read defensively from many candidate keys; absent stays absent —
   *  the blast queue treats a missing phone as "missing_phone" and
   *  never invents one. */
  agentName?: string;
  agentPhone?: string;
  agentEmail?: string;
  /** Listing brokerage (e.g. "F.C. Tucker Company") when a detail
   *  source reports one. Context only — never dialed. */
  agentBrokerage?: string;
  source: "zillow" | "redfin" | "apify" | "rentcast";
}

type Raw = Record<string, unknown>;

function asRecord(v: unknown): Raw | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Raw)
    : null;
}

/** Coerce a number out of numbers / "$215,000" / "1,280 sqft" strings. */
export function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.]/g, "");
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Redfin-native rows wrap scalars as { value: X, level: n }. Unwrap one
 * level; anything else (flat numbers/strings, plain nested objects like
 * a Zillow address) passes through unchanged. A wrapper with no `value`
 * key at all (e.g. lotSize: { level: 1 }) unwraps to undefined.
 */
export function unwrap(v: unknown): unknown {
  const rec = asRecord(v);
  if (rec && "value" in rec) return rec.value;
  return v;
}

function dig(row: Raw, key: string): unknown {
  if (!key.includes(".")) return unwrap(row[key]);
  let cur: unknown = row;
  for (const part of key.split(".")) {
    const rec = asRecord(unwrap(cur));
    if (!rec) return undefined;
    cur = rec[part];
  }
  return unwrap(cur);
}

function firstNum(row: Raw, keys: string[]): number | undefined {
  for (const key of keys) {
    const n = toNum(dig(row, key));
    if (n !== undefined) return n;
  }
  return undefined;
}

function firstStr(row: Raw, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = dig(row, key);
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Address may be a flat string or a nested { streetAddress, city, ... }. */
function extractAddress(row: Raw): {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
} {
  const nested = asRecord(row.address);
  if (nested) {
    const street =
      firstStr(nested, ["streetAddress", "street", "line1"]) ?? undefined;
    const city = firstStr(nested, ["city"]) ?? undefined;
    const state = firstStr(nested, ["state"]) ?? undefined;
    const zip =
      firstStr(nested, ["zipcode", "zipCode", "zip", "postalCode"]) ??
      (toNum(nested.zipcode)?.toString() ?? undefined);
    const parts = [street, city, state].filter(Boolean).join(", ");
    const address = parts
      ? zip
        ? `${parts} ${zip}`
        : parts
      : undefined;
    return { address, city, state, zip };
  }
  const city = firstStr(row, ["city"]);
  const state = firstStr(row, ["state"]);
  const zip = firstStr(row, ["zip", "zipcode", "zipCode", "postalCode"]);
  const full = firstStr(row, ["address", "fullAddress", "streetAddress"]);
  if (full) return { address: full, city, state, zip };
  // Redfin-native rows carry the street in `streetLine` with a separate
  // `unitNumber`; Redfin usually already includes the unit in streetLine
  // ("225 N New Jersey St #27"), so append it only when missing.
  const streetLine = firstStr(row, ["streetLine"]);
  if (!streetLine) return { city, state, zip };
  const unit = firstStr(row, ["unitNumber", "unit"]);
  const street =
    unit && !streetLine.toLowerCase().includes(unit.toLowerCase())
      ? `${streetLine} ${unit}`
      : streetLine;
  const parts = [street, city, state].filter(Boolean).join(", ");
  const address = parts ? (zip ? `${parts} ${zip}` : parts) : undefined;
  return { address, city, state, zip };
}

/** Agent details may sit at the top level or under an agent/listingAgent object. */
function extractAgent(row: Raw): {
  agentName?: string;
  agentPhone?: string;
  agentEmail?: string;
} {
  const agentObj = asRecord(row.agent) ?? asRecord(row.listingAgent) ?? {};
  const name =
    firstStr(row, [
      "agentName",
      "listingAgentName",
      "listingAgent",
      "agent",
    ]) ?? firstStr(agentObj, ["name", "agentName", "fullName"]);
  const phone =
    firstStr(row, [
      "agentPhone",
      "listingAgentPhone",
      "agentPhoneNumber",
      "phone",
    ]) ?? firstStr(agentObj, ["phone", "phoneNumber", "mobile"]);
  const email =
    firstStr(row, ["agentEmail", "listingAgentEmail", "email"]) ??
    firstStr(agentObj, ["email", "emailAddress"]);
  return { agentName: name, agentPhone: phone, agentEmail: email };
}

function baseFromRow(row: Raw, source: DealPrefill["source"]): DealPrefill {
  const addr = extractAddress(row);
  return {
    ...addr,
    ...extractAgent(row),
    listPrice: firstNum(row, [
      "price",
      "listPrice",
      "askingPrice",
      "priceInfo.amount",
    ]),
    beds: firstNum(row, ["beds", "bedrooms", "numBeds", "bedroomCount"]),
    baths: firstNum(row, ["baths", "bathrooms", "numBaths", "bathroomCount"]),
    sqft: firstNum(row, [
      "sqft",
      "squareFeet",
      "livingArea",
      "sqFt",
      "livingAreaValue",
    ]),
    hoaMonthly: firstNum(row, ["hoa", "monthlyHoa", "hoaFee", "hoaDues"]),
    annualTaxes: firstNum(row, [
      "annualTaxes",
      "taxAnnual",
      "annualTax",
      "propertyTaxes",
      "taxesAnnual",
    ]),
    annualInsurance: firstNum(row, [
      "annualInsurance",
      "insuranceAnnual",
      "homeInsurance",
      "insurance",
    ]),
    description: firstStr(row, ["description", "listingRemarks", "remarks"]),
    yearBuilt: firstNum(row, ["yearBuilt", "year_built"]),
    daysOnMarket: firstNum(row, [
      "daysOnMarket",
      "dom",
      "daysOnZillow",
      "daysOnRedfin",
    ]),
    sourceUrl: firstStr(row, ["url", "detailUrl", "link", "hdpUrl"]),
    source,
  };
}

/** Zillow Actor row (search or detail): Zestimate + Rent Zestimate. */
export function mapApifyRow(row: Raw): DealPrefill {
  const out = baseFromRow(row, "zillow");
  out.valueEstimate = firstNum(row, [
    "zestimate",
    "zEstimate",
    "valueEstimate",
    "estimate",
  ]);
  out.rentEstimate = firstNum(row, [
    "rentZestimate",
    "rentEstimate",
    "rentZest",
  ]);
  return out;
}

/** Redfin Actor row: Redfin Estimate where the Actor returns one.
 *  Also maps the geo fields the comps engine needs — coordinates from
 *  the wrapped `latLong` object, the neighborhood from the wrapped
 *  `location` string, and the flat Redfin `propertyId`. */
export function mapRedfinRow(row: Raw): DealPrefill {
  const out = baseFromRow(row, "redfin");
  out.valueEstimate = firstNum(row, [
    "redfinEstimate",
    "estimate",
    "valueEstimate",
    "avm",
  ]);
  out.rentEstimate = firstNum(row, ["rentEstimate", "rentZestimate"]);
  out.latitude = firstNum(row, ["latLong.latitude", "latitude", "lat"]);
  out.longitude = firstNum(row, ["latLong.longitude", "longitude", "lng", "lon"]);
  out.neighborhood = firstStr(row, ["location", "neighborhood"]);
  out.propertyId = firstNum(row, ["propertyId"]);
  return out;
}

/**
 * Fill-blanks merge: returns a copy of `base` where every field that is
 * undefined takes the first defined value from `fills` (in order).
 * Existing values in `base` always win — a fresher search row is never
 * overwritten by a staler cached/detail record; the detail record only
 * supplies what the base record lacks.
 */
const PREFILL_KEYS: (keyof DealPrefill)[] = [
  "address",
  "city",
  "state",
  "zip",
  "listPrice",
  "beds",
  "baths",
  "sqft",
  "hoaMonthly",
  "yearBuilt",
  "latitude",
  "longitude",
  "neighborhood",
  "propertyId",
  "annualTaxes",
  "annualInsurance",
  "valueEstimate",
  "rentEstimate",
  "daysOnMarket",
  "sourceUrl",
  "description",
  "agentName",
  "agentPhone",
  "agentEmail",
  "agentBrokerage",
  "source",
];

export function fillMissingPrefill(
  base: DealPrefill,
  ...fills: DealPrefill[]
): DealPrefill {
  const out = { ...base } as Record<string, unknown>;
  for (const fill of fills) {
    const rec = fill as unknown as Record<string, unknown>;
    for (const key of PREFILL_KEYS) {
      if (out[key] === undefined && rec[key] !== undefined) {
        out[key] = rec[key];
      }
    }
  }
  return out as unknown as DealPrefill;
}

// ---------- Redfin DETAIL rows (memo23/apify-redfin-cheerio) ----------

/**
 * What the blast agent lookup takes from one Redfin listing DETAIL row.
 * The detail Actor dumps the whole Redfin page payload, which is full
 * of agent-shaped decoys — this mapper reads ONLY the MLS attribution
 * block, verified live on 2026-10-18 (225 N New Jersey St,
 * Indianapolis; dataset AaApW7NmuBmfM6neq):
 *
 *   mlsDisclaimerInfo.listingAgentName   "Timothy Birky"  — the agent
 *   mlsDisclaimerInfo.listingAgentNumber "317-550-0700"   — his number
 *   mlsDisclaimerInfo.listingBrokerName  "F.C. Tucker Company"
 *
 * Corroboration/fallback for the NAME only: `primaryListingAgentName`,
 * then mainHouseInfo.listingAgents[0].agentInfo.agentName.
 *
 * NEVER mapped as the listing agent: `askAgent.*`, `recommendedAgent.*`
 * and `offerInsights.*.agentInfoDisplay` are Redfin's OWN touring /
 * partner agents — different people who do not hold the listing. The
 * row-level `contactPhone`/`contactEmail` are empty strings on real
 * rows. The phone comes from `listingAgentNumber` ONLY: the broker
 * number (`listingBrokerNumber`) is an office line and is never
 * substituted — no agent number means no phone, full stop.
 */
export interface RedfinDetail {
  agentName?: string;
  /** The listing agent's own number (mlsDisclaimerInfo.listingAgentNumber). */
  agentPhone?: string;
  agentBrokerage?: string;
  /** Full address composed from the row's address fields, when present. */
  address?: string;
  /** The Redfin listing URL the detail page was pulled for (row.url). */
  sourceUrl?: string;
}

export function mapRedfinDetailRow(row: Raw): RedfinDetail {
  const disclaimerName = firstStr(row, ["mlsDisclaimerInfo.listingAgentName"]);
  let fallbackName = firstStr(row, ["primaryListingAgentName"]);
  if (!fallbackName) {
    const mainHouse = asRecord(row.mainHouseInfo);
    const agents = Array.isArray(mainHouse?.listingAgents)
      ? mainHouse.listingAgents
      : [];
    const first = agents.length > 0 ? asRecord(agents[0]) : null;
    const info = first ? asRecord(first.agentInfo) : null;
    if (info) {
      fallbackName = firstStr(info, ["agentName", "fullName"]);
    }
  }
  const street = firstStr(row, ["streetAddress", "streetLine"]);
  const city = firstStr(row, ["city", "cityName"]);
  const state = firstStr(row, ["state", "stateOrProvinceCode"]);
  const zip = firstStr(row, ["zip", "postalCode", "zipcode", "zipCode"]);
  const parts = [street, city, state].filter(Boolean).join(", ");
  const address = parts ? (zip ? `${parts} ${zip}` : parts) : undefined;
  return {
    agentName: disclaimerName ?? fallbackName,
    agentPhone: firstStr(row, ["mlsDisclaimerInfo.listingAgentNumber"]),
    agentBrokerage: firstStr(row, ["mlsDisclaimerInfo.listingBrokerName"]),
    address,
    sourceUrl: firstStr(row, ["url"]),
  };
}

/** Street line for a memo23 detail row: the public-records composed
 *  string when present, else composed from the structured
 *  `streetAddress` object (the raw page payload carries an object,
 *  not a string). */
function detailStreet(row: Raw): string | undefined {
  const composed = firstStr(row, [
    "publicRecordsInfo.addressInfo.street",
    "streetAddress",
    "streetLine",
  ]);
  if (composed) return composed;
  const parts = asRecord(row.streetAddress);
  if (!parts) return undefined;
  const head = [
    firstStr(parts, ["streetNumber"]),
    firstStr(parts, ["directionalPrefix"]),
    firstStr(parts, ["streetName"]),
    firstStr(parts, ["streetType"]),
    firstStr(parts, ["directionalSuffix"]),
  ]
    .filter(Boolean)
    .join(" ");
  const unitValue = firstStr(parts, ["unitValue"]);
  const unitType = firstStr(parts, ["unitType"]);
  const unit = unitValue ? `${unitType ?? "#"}${unitValue}` : "";
  const street = [head, unit].filter(Boolean).join(" ");
  return street || undefined;
}

/**
 * Full property prefill from a memo23 Redfin DETAIL row — the record
 * behind the workbench's "fullest record" merge. Field shapes pinned
 * from a verified live row (225 N New Jersey St, Indianapolis;
 * dataset AaApW7NmuBmfM6neq, 2026-10-18):
 *
 *   priceInfo.amount .................... 325000 (list price)
 *   listingPrice .......................... "325000_US_DOLLAR" (fallback)
 *   numBeds / numBaths .................... 2 / 2 (flat)
 *   sqFt .................................. { value: 1237 } (wrapped)
 *   publicRecordsInfo.latestListingInfo ... { beds, baths, totalSqFt, yearBuilt } fallbacks
 *   publicRecordsInfo.mortgageCalculatorInfo.monthlyHoaDues ... 485
 *   ....homeInsuranceData.homeInsuranceYearlyEstimate ......... 1588
 *   ....propertyTaxRate ................... 2.2024 (% of price)
 *   publicRecordsInfo.taxInfo ............. {} — NO assessed amount on
 *     the verified row (allTaxInfo also []), so annual taxes are
 *     derived from the record's own county tax rate × list price —
 *     a record-sourced estimate, never a made-up figure. A direct
 *     amount key wins when a row carries one.
 *   rentalEstimateInfo .................... { displayLevel, propertyId,
 *     shouldShow } — NO rent amount on the verified row, so
 *     rentEstimate stays absent (amount keys are read defensively for
 *     rows that carry them). The comps engine's suggested rent is the
 *     usual filler.
 *   Redfin Estimate ....................... `hasAvm: true` only — the
 *     AVM amount is not in this payload at all, so valueEstimate
 *     stays absent (defensive keys read anyway).
 *   latitude / longitude .................. flat numbers + latLong obj
 */
export function mapRedfinDetailPrefill(row: Raw): DealPrefill {
  const detail = mapRedfinDetailRow(row);
  const listPrice = firstNum(row, [
    "priceInfo.amount",
    "listingPrice",
    "price",
  ]);
  const taxAmount = firstNum(row, [
    "publicRecordsInfo.taxInfo.taxAnnualAmount",
    "publicRecordsInfo.taxInfo.annualTaxAmount",
    "publicRecordsInfo.taxInfo.taxAmount",
    "publicRecordsInfo.taxInfo.amount",
    "taxAnnualAmount",
  ]);
  const taxRate = firstNum(row, [
    "publicRecordsInfo.mortgageCalculatorInfo.propertyTaxRate",
  ]);
  const annualTaxes =
    taxAmount ??
    (taxRate !== undefined && listPrice !== undefined
      ? Math.round((taxRate / 100) * listPrice)
      : undefined);
  const insurance = firstNum(row, [
    "publicRecordsInfo.mortgageCalculatorInfo.homeInsuranceData.homeInsuranceYearlyEstimate",
  ]);
  const street = detailStreet(row);
  const city = firstStr(row, ["city", "cityName"]);
  const state = firstStr(row, ["state", "stateOrProvinceCode"]);
  const zip = firstStr(row, ["zip", "postalCode", "zipcode", "zipCode"]);
  const addressParts = [street, city, state].filter(Boolean).join(", ");
  const address = addressParts
    ? zip
      ? `${addressParts} ${zip}`
      : addressParts
    : detail.address;
  return {
    address,
    city,
    state,
    zip,
    listPrice,
    beds: firstNum(row, [
      "numBeds",
      "beds",
      "publicRecordsInfo.latestListingInfo.beds",
    ]),
    baths: firstNum(row, [
      "numBaths",
      "baths",
      "publicRecordsInfo.latestListingInfo.baths",
    ]),
    sqft: firstNum(row, [
      "sqFt",
      "sqft",
      "publicRecordsInfo.latestListingInfo.totalSqFt",
    ]),
    hoaMonthly: firstNum(row, [
      "publicRecordsInfo.mortgageCalculatorInfo.monthlyHoaDues",
      "hoa",
      "monthlyHoa",
    ]),
    yearBuilt: firstNum(row, [
      "yearBuilt",
      "publicRecordsInfo.latestListingInfo.yearBuilt",
      "publicRecordsInfo.mortgageCalculatorInfo.homeInsuranceData.yearBuilt",
    ]),
    latitude: firstNum(row, ["latitude", "latLong.latitude"]),
    longitude: firstNum(row, ["longitude", "latLong.longitude"]),
    propertyId: firstNum(row, ["propertyId"]),
    annualTaxes,
    annualInsurance: insurance !== undefined && insurance > 0 ? insurance : undefined,
    valueEstimate: firstNum(row, [
      "avmInfo.predictedValue",
      "avmInfo.value",
      "predictedValue",
      "redfinEstimate",
      "estimate",
    ]),
    rentEstimate: firstNum(row, [
      "rentalEstimateInfo.predictedRent",
      "rentalEstimateInfo.predictedMonthlyRent",
      "rentalEstimateInfo.rentAmount",
      "rentalEstimateInfo.amount",
      "rentEstimate",
    ]),
    agentName: detail.agentName,
    agentPhone: detail.agentPhone,
    agentBrokerage: detail.agentBrokerage,
    sourceUrl: detail.sourceUrl,
    source: "redfin",
  };
}

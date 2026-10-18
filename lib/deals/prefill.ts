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

/** Redfin Actor row: Redfin Estimate where the Actor returns one. */
export function mapRedfinRow(row: Raw): DealPrefill {
  const out = baseFromRow(row, "redfin");
  out.valueEstimate = firstNum(row, [
    "redfinEstimate",
    "estimate",
    "valueEstimate",
    "avm",
  ]);
  out.rentEstimate = firstNum(row, ["rentEstimate", "rentZestimate"]);
  return out;
}

// Normalized listing data used to prefill the underwriting workbench.
// Mappers are defensive by design: Apify Actors (third-party, many
// authors) return differently-shaped rows, so every field is read from
// several candidate keys and anything absent stays undefined — values are
// never invented.

export interface DealPrefill {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  listPrice?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  valueEstimate?: number;
  rentEstimate?: number;
  daysOnMarket?: number;
  sourceUrl?: string;
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

function dig(row: Raw, key: string): unknown {
  if (!key.includes(".")) return row[key];
  let cur: unknown = row;
  for (const part of key.split(".")) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[part];
  }
  return cur;
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
    const v = row[key];
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
      firstStr(nested, ["zipcode", "zipCode", "zip"]) ??
      (toNum(nested.zipcode)?.toString() ?? undefined);
    const parts = [street, city, state].filter(Boolean).join(", ");
    const address = parts
      ? zip
        ? `${parts} ${zip}`
        : parts
      : undefined;
    return { address, city, state, zip };
  }
  const flat = firstStr(row, ["address", "fullAddress", "streetAddress"]);
  const city = firstStr(row, ["city"]);
  const state = firstStr(row, ["state"]);
  const zip = firstStr(row, ["zip", "zipcode", "zipCode"]);
  return { address: flat, city, state, zip };
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

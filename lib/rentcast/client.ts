// RentCast client — used ONLY for under-contract verification
// (see lib/deals/underContract.ts and POST /api/deals/verify, which
// enforces the gate server-side before any call reaches here).
// Key lives ONLY in process.env.RENTCAST_API_KEY (server-side).
import { toNum } from "@/lib/deals/prefill";

const BASE_URL = "https://api.rentcast.io/v1";

export function rentcastConfigured(): boolean {
  return Boolean(process.env.RENTCAST_API_KEY?.trim());
}

export interface RentcastVerification {
  valueEstimate?: number;
  valueLow?: number;
  valueHigh?: number;
  rentEstimate?: number;
  rentLow?: number;
  rentHigh?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
}

type Raw = Record<string, unknown>;

function num(v: unknown): number | undefined {
  return toNum(v);
}

/** Pure mapper for GET /avm/value responses. */
export function mapRentcastValue(raw: Raw): Partial<RentcastVerification> {
  return {
    valueEstimate: num(raw.price),
    valueLow: num(raw.priceRangeLow),
    valueHigh: num(raw.priceRangeHigh),
  };
}

/** Pure mapper for GET /avm/rent/long-term responses. */
export function mapRentcastRent(raw: Raw): Partial<RentcastVerification> {
  return {
    rentEstimate: num(raw.rent),
    rentLow: num(raw.rentRangeLow),
    rentHigh: num(raw.rentRangeHigh),
  };
}

/** Pure mapper for GET /properties records (first match wins upstream). */
export function mapRentcastProperty(raw: Raw): Partial<RentcastVerification> {
  return {
    beds: num(raw.bedrooms),
    baths: num(raw.bathrooms),
    sqft: num(raw.squareFootage),
    yearBuilt: num(raw.yearBuilt),
  };
}

async function rentcastFetch(path: string): Promise<unknown> {
  const key = process.env.RENTCAST_API_KEY?.trim();
  if (!key) throw new Error("RentCast is not configured: RENTCAST_API_KEY is not set.");
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "X-Api-Key": key, Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RentCast error ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Value + rent estimates (and property facts when available) for one address. */
export async function verifyAddress(
  address: string,
): Promise<RentcastVerification> {
  const q = `address=${encodeURIComponent(address)}`;
  const [valueRaw, rentRaw, propsRaw] = await Promise.all([
    rentcastFetch(`/avm/value?${q}`),
    rentcastFetch(`/avm/rent/long-term?${q}`),
    rentcastFetch(`/properties?${q}`).catch(() => null),
  ]);
  const out: RentcastVerification = {
    ...mapRentcastValue((valueRaw ?? {}) as Raw),
    ...mapRentcastRent((rentRaw ?? {}) as Raw),
  };
  const firstProp = Array.isArray(propsRaw)
    ? (propsRaw[0] as Raw | undefined)
    : undefined;
  if (firstProp) Object.assign(out, mapRentcastProperty(firstProp));
  return out;
}

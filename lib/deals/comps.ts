// Turnkey auto-comps: pure selection logic over tri_angle/redfin-search
// rows. The route (app/api/deals/comps) pulls two extra feeds — recently
// SOLD and FOR RENT — inside a 0.5-mile viewport around the subject and
// hands the raw rows here; everything in this module is deterministic
// and unit-tested.
//
// Field contracts, pinned from live datasets on 2026-10-18:
//
// SOLD feed (dataset DiSlJZ6G6M7j1yged, 254 rows):
//   - `price` ({value}) is the SOLD price; there is no separate
//     sold-price field.
//   - `soldDate` is epoch MILLISECONDS (int); cross-checked against
//     sashes[].lastSaleDate ("JUN 22, 2026" == 1782111600000).
//   - Sold rows carry searchStatus 4 / mlsStatus "Closed"; 3 of 254
//     rows lack soldDate/status entirely and drop out via the date
//     requirement below.
//
// RENT feed (dataset FQUxgZyQFdCOVJ9Z0, 61 rows):
//   - There is NO rent-specific field anywhere in the rows, and the
//     feed is a MIX: `include=rentals` adds rentals on top of the
//     for-sale set (58 of 61 rows are ordinary sale listings). No
//     structural flag identifies a rental — `listingType: 2` is FSBO,
//     not rental (its sash reads "For Sale By Owner").
//   - When a row IS a genuine rental, its monthly rent sits in
//     `price` ({value}) — e.g. the one true rental in the verified
//     set, 302 S Alabama St at $1,550/mo ("apartment available for
//     rent … $1550 rent" in its remarks).
//   - Therefore rent candidates are identified by the only honest
//     signal available: a price inside a plausible monthly-rent band
//     (RENT_BAND_MIN..RENT_BAND_MAX). Redfin rental coverage through
//     this Actor is thin, so <2 usable rent comps is a normal outcome
//     and surfaces as a note, never a fabricated number.
import {
  mapRedfinRow,
  toNum,
  unwrap,
  type DealPrefill,
} from "@/lib/deals/prefill";

type RawRow = Record<string, unknown>;

export interface CompsSubject {
  address?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  beds?: number;
  sqft?: number;
  neighborhood?: string;
  propertyId?: number;
}

export interface SoldComp {
  address: string;
  soldPrice: number;
  /** ISO date of the sale. */
  soldDate: string;
  distanceMi: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  neighborhood?: string;
}

export interface RentComp {
  address: string;
  /** Monthly rent in dollars. */
  rent: number;
  distanceMi: number;
  beds?: number;
  baths?: number;
  sqft?: number;
}

export interface SoldSelection {
  comps: SoldComp[];
  suggestedMV: number | null;
  notes: string[];
}

export interface RentSelection {
  comps: RentComp[];
  suggestedRent: number | null;
  notes: string[];
}

export const COMPS_RADIUS_MI = 0.5;
export const SOLD_WINDOW_DAYS = 365;
/** A "turnkey" screen: sold comps priced (per sqft) far below the
 *  local median are treated as distressed/teardown sales and dropped. */
export const DISTRESS_FLOOR = 0.45;
/** Plausible monthly-rent band — the rent feed's only rental signal. */
export const RENT_BAND_MIN = 300;
export const RENT_BAND_MAX = 6000;

const EARTH_RADIUS_MI = 3958.8;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Geography ----------

export function haversineMi(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface CompsViewport {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * The 0.5-mile box around a point: dLat = 0.5/69 degrees; longitude
 * degrees shrink with latitude, so dLng = 0.5 / (69 × cos(lat)).
 */
export function buildCompsViewport(
  latitude: number,
  longitude: number,
): CompsViewport {
  const dLat = COMPS_RADIUS_MI / 69;
  const dLng =
    COMPS_RADIUS_MI / (69 * Math.cos((latitude * Math.PI) / 180));
  return {
    north: latitude + dLat,
    south: latitude - dLat,
    east: longitude + dLng,
    west: longitude - dLng,
  };
}

function fmtCoord(n: number): string {
  return String(Number(n.toFixed(5)));
}

/** Sold feed URL (form verified live, 2026-10-18: 254 rows). */
export function soldCompsUrl(zip: string, vp: CompsViewport): string {
  return `https://www.redfin.com/zipcode/${zip}/filter/viewport=${fmtCoord(vp.north)}:${fmtCoord(vp.south)}:${fmtCoord(vp.east)}:${fmtCoord(vp.west)},no-outline,include=sold-1yr`;
}

/** Rentals feed URL (form verified live, 2026-10-18: 61 rows). */
export function rentCompsUrl(zip: string, vp: CompsViewport): string {
  return `https://www.redfin.com/zipcode/${zip}/filter/include=rentals,viewport=${fmtCoord(vp.north)}:${fmtCoord(vp.south)}:${fmtCoord(vp.east)}:${fmtCoord(vp.west)},no-outline`;
}

// ---------- Helpers ----------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const STREET_SUFFIXES: Record<string, string> = {
  st: "street",
  ave: "avenue",
  rd: "road",
  dr: "drive",
  ln: "lane",
  ct: "court",
  blvd: "boulevard",
  pl: "place",
  cir: "circle",
  ter: "terrace",
  hwy: "highway",
};

/**
 * Street-identity comparison key: the part before the first comma,
 * unit designator dropped, punctuation stripped, common street
 * suffixes expanded — so the subject's own sale ("225 N New Jersey
 * St #27") matches the same property in a comp feed.
 */
export function normalizeStreet(address: string | undefined): string {
  if (!address) return "";
  const street = (address.split(",")[0] ?? "")
    .toLowerCase()
    .replace(/#.*$/, " ")
    .replace(/\b(unit|apt|apartment|suite|ste|no)\b.*$/, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!street) return "";
  const tokens = street.split(" ");
  const last = tokens[tokens.length - 1];
  if (STREET_SUFFIXES[last]) tokens[tokens.length - 1] = STREET_SUFFIXES[last];
  return tokens.join(" ");
}

interface Candidate {
  prefill: DealPrefill;
  soldDateMs?: number;
}

function candidateFromRow(row: RawRow): Candidate {
  return {
    prefill: mapRedfinRow(row),
    soldDateMs: toNum(unwrap(row.soldDate)),
  };
}

function isSubject(subject: CompsSubject, p: DealPrefill): boolean {
  if (
    subject.propertyId !== undefined &&
    p.propertyId !== undefined &&
    subject.propertyId === p.propertyId
  ) {
    return true;
  }
  const a = normalizeStreet(subject.address);
  const b = normalizeStreet(p.address);
  return a !== "" && a === b;
}

type Distanced = Candidate & { distanceMi: number };

/** Attach haversine distances and keep only rows inside the radius.
 *  Rows without coordinates cannot be verified inside 0.5 mi and drop. */
function withinRadius(subject: CompsSubject, pool: Candidate[]): Distanced[] {
  if (subject.latitude === undefined || subject.longitude === undefined) {
    return [];
  }
  const out: Distanced[] = [];
  for (const c of pool) {
    const { latitude, longitude } = c.prefill;
    if (latitude === undefined || longitude === undefined) continue;
    const d = haversineMi(subject.latitude, subject.longitude, latitude, longitude);
    if (d <= COMPS_RADIUS_MI + 1e-9) out.push({ ...c, distanceMi: d });
  }
  return out;
}

function sameNeighborhood(subject: CompsSubject, p: DealPrefill): boolean {
  if (!subject.neighborhood || !p.neighborhood) return false;
  return (
    subject.neighborhood.trim().toLowerCase() ===
    p.neighborhood.trim().toLowerCase()
  );
}

/** Beds within ±1 of the subject is a soft preference: it filters the
 *  pool only when at least 2 comps survive the filter. */
function applyBedsPreference(
  subject: CompsSubject,
  pool: Distanced[],
): Distanced[] {
  if (subject.beds === undefined) return pool;
  const subjectBeds = subject.beds;
  const near = pool.filter(
    (c) =>
      c.prefill.beds !== undefined &&
      Math.abs(c.prefill.beds - subjectBeds) <= 1,
  );
  return near.length >= 2 ? near : pool;
}

function byRank(subject: CompsSubject) {
  return (a: Distanced, b: Distanced): number => {
    const na = sameNeighborhood(subject, a.prefill) ? 0 : 1;
    const nb = sameNeighborhood(subject, b.prefill) ? 0 : 1;
    if (na !== nb) return na - nb;
    return a.distanceMi - b.distanceMi;
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- Sold comps ----------

export function selectSoldComps(
  subject: CompsSubject,
  rows: RawRow[],
  now: Date = new Date(),
): SoldSelection {
  const notes: string[] = [];
  const cutoff = now.getTime() - SOLD_WINDOW_DAYS * DAY_MS;
  let pool = rows
    .map(candidateFromRow)
    .filter(
      (c) =>
        (c.prefill.listPrice ?? 0) > 0 &&
        c.soldDateMs !== undefined &&
        c.soldDateMs >= cutoff &&
        c.soldDateMs <= now.getTime(),
    );
  pool = pool.filter((c) => !isSubject(subject, c.prefill));
  let distanced = withinRadius(subject, pool);

  // Distress screen: drop rows whose $/sqft is far below the candidate
  // median $/sqft (teardowns / distress sales are not turnkey comps).
  // Rows without sqft cannot be screened and stay.
  const ppsfValues = distanced
    .map((c) =>
      c.prefill.sqft && c.prefill.listPrice
        ? c.prefill.listPrice / c.prefill.sqft
        : undefined,
    )
    .filter((n): n is number => n !== undefined && n > 0);
  const medianPpsf = median(ppsfValues);
  if (medianPpsf !== null) {
    distanced = distanced.filter((c) => {
      if (!c.prefill.sqft || !c.prefill.listPrice) return true;
      return c.prefill.listPrice / c.prefill.sqft >= DISTRESS_FLOOR * medianPpsf;
    });
  }

  const preferred = applyBedsPreference(subject, distanced);
  const ranked = [...preferred].sort((a, b) => {
    const r = byRank(subject)(a, b);
    if (r !== 0) return r;
    return (b.soldDateMs ?? 0) - (a.soldDateMs ?? 0);
  });
  const selected = ranked.slice(0, 3);
  const comps: SoldComp[] = selected.map((c) => ({
    address: c.prefill.address ?? "",
    soldPrice: c.prefill.listPrice ?? 0,
    soldDate: new Date(c.soldDateMs ?? 0).toISOString(),
    distanceMi: round2(c.distanceMi),
    beds: c.prefill.beds,
    baths: c.prefill.baths,
    sqft: c.prefill.sqft,
    neighborhood: c.prefill.neighborhood,
  }));

  let suggestedMV: number | null = null;
  if (selected.length < 2) {
    notes.push(
      `Only ${selected.length} usable sold comp${selected.length === 1 ? "" : "s"} within 0.5 mi in the past 12 months — not enough to suggest a market value.`,
    );
  } else {
    const withSqft = selected.filter(
      (c) => c.prefill.sqft && c.prefill.listPrice,
    );
    if (subject.sqft && withSqft.length >= 2) {
      const medPpsf = median(
        withSqft.map((c) => (c.prefill.listPrice as number) / (c.prefill.sqft as number)),
      );
      suggestedMV = medPpsf !== null ? Math.round(medPpsf * subject.sqft) : null;
    } else {
      const medPrice = median(
        selected.map((c) => c.prefill.listPrice).filter((n): n is number => n !== undefined),
      );
      suggestedMV = medPrice !== null ? Math.round(medPrice) : null;
    }
  }
  return { comps, suggestedMV, notes };
}

// ---------- Rent comps ----------

export function selectRentComps(
  subject: CompsSubject,
  rows: RawRow[],
): RentSelection {
  const notes: string[] = [];
  let pool = rows.map(candidateFromRow).filter((c) => {
    const rent = c.prefill.listPrice;
    return rent !== undefined && rent >= RENT_BAND_MIN && rent <= RENT_BAND_MAX;
  });
  pool = pool.filter((c) => !isSubject(subject, c.prefill));
  const distanced = withinRadius(subject, pool);
  const preferred = applyBedsPreference(subject, distanced);
  const ranked = [...preferred].sort(byRank(subject));
  const selected = ranked.slice(0, 3);
  const comps: RentComp[] = selected.map((c) => ({
    address: c.prefill.address ?? "",
    rent: c.prefill.listPrice ?? 0,
    distanceMi: round2(c.distanceMi),
    beds: c.prefill.beds,
    baths: c.prefill.baths,
    sqft: c.prefill.sqft,
  }));

  let suggestedRent: number | null = null;
  if (selected.length < 2) {
    notes.push(
      `Only ${selected.length} usable rental comp${selected.length === 1 ? "" : "s"} within 0.5 mi — not enough to suggest a rent.`,
    );
  } else {
    const med = median(
      selected.map((c) => c.prefill.listPrice).filter((n): n is number => n !== undefined),
    );
    suggestedRent = med !== null ? Math.round(med) : null;
  }
  return { comps, suggestedRent, notes };
}

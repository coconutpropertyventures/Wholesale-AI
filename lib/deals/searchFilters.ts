// Workbench search filters for Redfin results.
//
// Filters are applied SERVER-SIDE to the rows an Apify search already
// pulled — they never trigger another pull. Bradley's cost rule: a
// search run is capped at 500 items, and filtering the pulled set is
// free; re-searching to change a filter is a fresh (capped) pull the
// operator explicitly asks for.
//
// A row whose filtered field is ABSENT never matches an active filter:
// the app cannot verify what the data does not carry, and silently
// keeping unverifiable rows would make the counts lie.
//
// NOTE on "price reduced": across 315 real tri_angle rows inspected
// 2026-10-18 (61 active + 254 sold), there is NO per-row reduction
// signal — no previous-price field, no price-change field, no
// price-cut count, and no "Price Reduced" sash among the sash types
// present (Sold, Bought, 3D/Video Tour, Floor Plan, For Sale By
// Owner, Open House, Short Sale). Detection would need a detail pull
// per row, which the cost rules forbid. There is deliberately NO
// price-reduced filter here — shipping one would mean fabricating
// the signal it claims to filter on.
import type { DealPrefill } from "@/lib/deals/prefill";

export interface SearchFilters {
  minPrice?: number;
  maxPrice?: number;
  /** Minimum days on market (DealPrefill.daysOnMarket). */
  minDom?: number;
  minBeds?: number;
  minBaths?: number;
}

function cleanNum(v: unknown): number | undefined {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Defensive parse of a client-supplied filters object. Anything that
 *  is not a non-negative finite number is dropped, so a malformed
 *  filter can only ever mean "no filter", never a broken search. */
export function parseSearchFilters(raw: unknown): SearchFilters {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const rec = raw as Record<string, unknown>;
  const out: SearchFilters = {};
  const minPrice = cleanNum(rec.minPrice);
  const maxPrice = cleanNum(rec.maxPrice);
  const minDom = cleanNum(rec.minDom);
  const minBeds = cleanNum(rec.minBeds);
  const minBaths = cleanNum(rec.minBaths);
  if (minPrice !== undefined) out.minPrice = minPrice;
  if (maxPrice !== undefined) out.maxPrice = maxPrice;
  if (minDom !== undefined) out.minDom = minDom;
  if (minBeds !== undefined) out.minBeds = minBeds;
  if (minBaths !== undefined) out.minBaths = minBaths;
  return out;
}

export function hasActiveFilters(f: SearchFilters): boolean {
  return (
    f.minPrice !== undefined ||
    f.maxPrice !== undefined ||
    f.minDom !== undefined ||
    f.minBeds !== undefined ||
    f.minBaths !== undefined
  );
}

/** Keep the rows that satisfy every active filter. */
export function applySearchFilters(
  rows: DealPrefill[],
  f: SearchFilters,
): DealPrefill[] {
  return rows.filter((r) => {
    if (f.minPrice !== undefined && (r.listPrice === undefined || r.listPrice < f.minPrice)) return false;
    if (f.maxPrice !== undefined && (r.listPrice === undefined || r.listPrice > f.maxPrice)) return false;
    if (f.minDom !== undefined && (r.daysOnMarket === undefined || r.daysOnMarket < f.minDom)) return false;
    if (f.minBeds !== undefined && (r.beds === undefined || r.beds < f.minBeds)) return false;
    if (f.minBaths !== undefined && (r.baths === undefined || r.baths < f.minBaths)) return false;
    return true;
  });
}

export interface SearchSelection {
  /** The post-filter slice the UI displays (at most `limit` rows). */
  results: DealPrefill[];
  /** Rows surviving the filters, before the display slice. */
  totalMatched: number;
  /** Rows the search actually pulled (post 500-cap), before filters. */
  totalReturned: number;
}

/** Filter first, THEN slice for display — a filtered search must show
 *  up to `limit` MATCHING rows, not the matches that happened to fall
 *  inside the first `limit` unfiltered rows. */
export function selectSearchResults(
  all: DealPrefill[],
  filters: SearchFilters,
  limit = 100,
): SearchSelection {
  const matched = applySearchFilters(all, filters);
  return {
    results: matched.slice(0, limit),
    totalMatched: matched.length,
    totalReturned: all.length,
  };
}

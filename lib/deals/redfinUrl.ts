// Builds the Redfin MAP search URL that tri_angle/redfin-search consumes.
//
// That Actor's verified input schema (checked with fetch-actor-details,
// 2026-10-18) has exactly one way in: `searchUrls: [{ url }]` where each
// url is a Redfin map search URL — either a ZIP page
// (https://www.redfin.com/zipcode/46225) or a ZIP page with a viewport
// filter (https://www.redfin.com/zipcode/46225/filter/viewport=N:S:E:W,no-outline).
// There is NO search/query/keyword field on the Actor; sending one is
// silently ignored and the run fails (production run p6c7cmHm6VG8SGtHq).
//
// ZIP queries map straight onto the zipcode URL. Anything else (a city
// or place name) is geocoded server-side with the OpenStreetMap
// Nominatim API. Verified live 2026-10-18: a BARE viewport URL (no place
// path, /filter/viewport=...) returns ZERO items from the Actor, so the
// city URL is anchored on the geocoded result's centroid postcode —
// /zipcode/{postcode}/filter/viewport=... — with the viewport clamped
// (see clampBoundingBox) because a whole-city bounding box is
// county-sized and returns 1,000+ rows. A city-level forward result
// carries no postcode in its address (only city/state/country), so the
// postcode is hunted by reverse-geocoding several points in the place
// (its anchor point, the bounding-box center, then the quadrant
// centers) — any one of them may land on a highway or other address
// with no postcode (the Savannah, GA failure), but the postcode only
// anchors the URL path while the clamped viewport does the geographic
// work, so the first point that yields one wins. City searches
// therefore cover the CENTRAL area of the searched place.

export interface RedfinBoundingBox {
  south: string;
  north: string;
  west: string;
  east: string;
}

/** "46225" or "46225-1234" (after trimming) -> "46225"; anything else -> null. */
export function zipFromQuery(query: string): string | null {
  const m = /^(\d{5})(?:-\d{4})?$/.exec(query.trim());
  return m ? m[1] : null;
}

export function redfinZipUrl(zip: string): string {
  return `https://www.redfin.com/zipcode/${zip}`;
}

function fmtCoord(n: number): string {
  return String(Number(n.toFixed(6)));
}

// Viewport span caps for city searches. A whole-city Nominatim bounding
// box is county-sized (Indianapolis spans ~0.30 x ~0.39 degrees and
// larger metros far more); the Actor returned 210 items for a small
// downtown box vs 1,000+ rows for an unclamped metro box, which also
// risks the sync-run timeout. The viewport is clamped around the
// bounding-box CENTER, so a city search covers its central area.
export const MAX_VIEWPORT_LAT_SPAN = 0.3;
export const MAX_VIEWPORT_LNG_SPAN = 0.4;

/** Clamp a bounding box's span around its center to the caps above.
 *  Boxes already inside the caps pass through (reformatted); unparsable
 *  input is returned unchanged. */
export function clampBoundingBox(bb: RedfinBoundingBox): RedfinBoundingBox {
  const south = Number(bb.south);
  const north = Number(bb.north);
  const west = Number(bb.west);
  const east = Number(bb.east);
  if (![south, north, west, east].every(Number.isFinite)) return bb;
  const centerLat = (south + north) / 2;
  const centerLng = (west + east) / 2;
  const halfLat = Math.min((north - south) / 2, MAX_VIEWPORT_LAT_SPAN / 2);
  const halfLng = Math.min((east - west) / 2, MAX_VIEWPORT_LNG_SPAN / 2);
  return {
    south: fmtCoord(centerLat - halfLat),
    north: fmtCoord(centerLat + halfLat),
    west: fmtCoord(centerLng - halfLng),
    east: fmtCoord(centerLng + halfLng),
  };
}

/**
 * ZIP-anchored viewport filter URL. Redfin's viewport order is
 * latN:latS:lngE:lngW — north, south, east, west. The zipcode path
 * segment is required: the Actor returns zero items for a bare
 * /filter/viewport= URL (verified live 2026-10-18).
 */
export function redfinViewportUrl(
  postcode: string,
  bb: RedfinBoundingBox,
): string {
  return `https://www.redfin.com/zipcode/${postcode}/filter/viewport=${bb.north}:${bb.south}:${bb.east}:${bb.west},no-outline`;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
// Nominatim's usage policy requires a descriptive User-Agent identifying
// the application and a contact.
const NOMINATIM_USER_AGENT =
  "WholesaleAI/1.0 (offers@coconutpropertyventures.com)";
const GEOCODE_TIMEOUT_MS = 10_000;

export function unresolvablePlaceError(query: string): Error {
  return new Error(
    `Could not resolve "${query.trim()}" to a place. Try searching by ZIP code instead.`,
  );
}

/**
 * One Nominatim GET (descriptive User-Agent, 10s timeout). Returns the
 * parsed JSON body, or null on any failure — non-OK response, network
 * error, abort, or unparseable body. Never throws.
 */
async function nominatimJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": NOMINATIM_USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface GeocodedPlace {
  latitude: number;
  longitude: number;
  /** Centroid postcode (5-digit ZIP) when Nominatim reports one. */
  postcode?: string;
}

/**
 * Forward-geocode a free-form address/place to coordinates via
 * Nominatim (same endpoint, User-Agent, and failure posture as the
 * search-URL resolver: null on any failure, never throws). Used by the
 * turnkey comps engine when a cached listing carries no coordinates of
 * its own. `fetchImpl` is injectable for tests.
 */
export async function geocodeCoordinates(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeocodedPlace | null> {
  const q = query.trim();
  if (!q) return null;
  const parsed = await nominatimJson(
    `${NOMINATIM_URL}?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`,
    fetchImpl,
  );
  const first = Array.isArray(parsed)
    ? (parsed[0] as
        | { lat?: unknown; lon?: unknown; address?: unknown }
        | undefined)
    : undefined;
  if (!first) return null;
  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    postcode: postcodeFromAddress(first.address) ?? undefined,
  };
}

/** Pull a usable postcode out of a Nominatim `address` object. A ZIP+4
 *  postcode is reduced to its first 5 digits, like a typed ZIP query. */
function postcodeFromAddress(address: unknown): string | null {
  const raw = (address as { postcode?: unknown } | null | undefined)
    ?.postcode;
  if (typeof raw === "string" && raw.trim() !== "") {
    return zipFromQuery(raw) ?? raw.trim();
  }
  return null;
}

/**
 * Resolve a search query to the Redfin map URL the search Actor needs.
 * ZIP (or ZIP+4) queries never touch the network. Other queries are
 * geocoded via Nominatim (addressdetails=1): a postcode from the result
 * anchors a zipcode URL, narrowed by the clamped viewport when a
 * bounding box is present. A city-level forward result carries NO
 * postcode in its address (only city/state/country), so when it lacks
 * one, candidate points are reverse-geocoded in order — the forward
 * result's anchor point, the bounding-box center, then the four
 * quadrant centers (at most 6 reverse calls) — and the first postcode
 * found wins; any single point may resolve to a road or other address
 * with no postcode. A place that yields no postcode anywhere throws an
 * error telling the caller to try a ZIP code (a bare viewport URL
 * returns zero items, so there is no usable fallback). `fetchImpl` is
 * injectable for tests.
 */
export async function resolveRedfinSearchUrl(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const q = query.trim();
  const zip = zipFromQuery(q);
  if (zip) return redfinZipUrl(zip);
  if (!q) throw unresolvablePlaceError(query);

  let postcode: string | null = null;
  let bb: RedfinBoundingBox | null = null;
  let anchor: { lat: number; lon: number } | null = null;
  const parsed = await nominatimJson(
    `${NOMINATIM_URL}?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`,
    fetchImpl,
  );
  const first = Array.isArray(parsed)
    ? (parsed[0] as
        | { boundingbox?: unknown; address?: unknown; lat?: unknown; lon?: unknown }
        | undefined)
    : undefined;
  if (first) {
    postcode = postcodeFromAddress(first.address);
    const anchorLat = Number(first.lat);
    const anchorLon = Number(first.lon);
    if (Number.isFinite(anchorLat) && Number.isFinite(anchorLon)) {
      anchor = { lat: anchorLat, lon: anchorLon };
    }
    const raw = first.boundingbox;
    if (
      Array.isArray(raw) &&
      raw.length === 4 &&
      raw.every(
        (v) =>
          typeof v === "string" &&
          v.trim() !== "" &&
          Number.isFinite(Number(v)),
      )
    ) {
      // Nominatim boundingbox order: [south, north, west, east].
      bb = { south: raw[0], north: raw[1], west: raw[2], east: raw[3] };
    }
  }
  // No forward postcode: reverse-geocode candidate points until one
  // yields a postcode. Order: the place's anchor point (its forward
  // lat/lon), the bounding-box center, then the four quadrant centers.
  // A single point is not reliable — a center can land on a highway
  // whose reverse result is a road address with no postcode (Savannah,
  // GA) while the anchor sits on an addressed building — but the
  // postcode only anchors the URL path, so any postcode inside the
  // place is acceptable. A failed/empty reverse just moves to the
  // next point; nominatimJson never throws.
  if (!postcode) {
    const points: { lat: number; lon: number }[] = [];
    if (anchor) points.push(anchor);
    if (bb) {
      const south = Number(bb.south);
      const north = Number(bb.north);
      const west = Number(bb.west);
      const east = Number(bb.east);
      points.push({ lat: (south + north) / 2, lon: (west + east) / 2 });
      const lat25 = south + 0.25 * (north - south);
      const lat75 = south + 0.75 * (north - south);
      const lon25 = west + 0.25 * (east - west);
      const lon75 = west + 0.75 * (east - west);
      points.push(
        { lat: lat25, lon: lon25 },
        { lat: lat25, lon: lon75 },
        { lat: lat75, lon: lon25 },
        { lat: lat75, lon: lon75 },
      );
    }
    for (const point of points.slice(0, 6)) {
      const reverse = await nominatimJson(
        `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${fmtCoord(point.lat)}&lon=${fmtCoord(point.lon)}`,
        fetchImpl,
      );
      postcode = postcodeFromAddress(
        (reverse as { address?: unknown } | null)?.address,
      );
      if (postcode) break;
    }
  }
  if (!postcode) throw unresolvablePlaceError(q);
  if (!bb) return redfinZipUrl(postcode);
  return redfinViewportUrl(postcode, clampBoundingBox(bb));
}

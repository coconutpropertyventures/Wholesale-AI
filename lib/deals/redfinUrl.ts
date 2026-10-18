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
// county-sized and returns 1,000+ rows. City searches therefore cover
// the CENTRAL area of the searched place.

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
 * Resolve a search query to the Redfin map URL the search Actor needs.
 * ZIP (or ZIP+4) queries never touch the network. Other queries are
 * geocoded via Nominatim (addressdetails=1): the result's centroid
 * postcode anchors a zipcode URL, narrowed by the clamped viewport when
 * a bounding box is present. A place that cannot be resolved — or that
 * resolves without a postcode — throws an error telling the caller to
 * try a ZIP code (a bare viewport URL returns zero items, so there is
 * no usable fallback). `fetchImpl` is injectable for tests.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${NOMINATIM_URL}?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`,
      {
        headers: {
          "User-Agent": NOMINATIM_USER_AGENT,
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (res.ok) {
      const parsed: unknown = await res.json();
      const first = Array.isArray(parsed)
        ? (parsed[0] as
            | {
                boundingbox?: unknown;
                address?: { postcode?: unknown };
              }
            | undefined)
        : undefined;
      const rawPostcode = first?.address?.postcode;
      if (typeof rawPostcode === "string" && rawPostcode.trim() !== "") {
        postcode = zipFromQuery(rawPostcode) ?? rawPostcode.trim();
      }
      const raw = first?.boundingbox;
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
  } catch {
    postcode = null;
    bb = null;
  } finally {
    clearTimeout(timer);
  }
  if (!postcode) throw unresolvablePlaceError(q);
  if (!bb) return redfinZipUrl(postcode);
  return redfinViewportUrl(postcode, clampBoundingBox(bb));
}

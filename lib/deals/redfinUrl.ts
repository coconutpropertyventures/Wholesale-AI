// Builds the Redfin MAP search URL that tri_angle/redfin-search consumes.
//
// That Actor's verified input schema (checked with fetch-actor-details,
// 2026-10-18) has exactly one way in: `searchUrls: [{ url }]` where each
// url is a Redfin map search URL — either a ZIP page
// (https://www.redfin.com/zipcode/46225) or a viewport filter
// (https://www.redfin.com/filter/viewport=<latN>:<latS>:<lngE>:<lngW>,no-outline).
// There is NO search/query/keyword field on the Actor; sending one is
// silently ignored and the run fails (production run p6c7cmHm6VG8SGtHq).
//
// ZIP queries map straight onto the zipcode URL. Anything else (a city
// or place name) is geocoded server-side with the OpenStreetMap
// Nominatim API and turned into a viewport URL from its bounding box.

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

/**
 * Viewport filter URL from a bounding box. Redfin's viewport order is
 * latN:latS:lngE:lngW — north, south, east, west.
 */
export function redfinViewportUrl(bb: RedfinBoundingBox): string {
  return `https://www.redfin.com/filter/viewport=${bb.north}:${bb.south}:${bb.east}:${bb.west},no-outline`;
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
 * geocoded via Nominatim; an unresolvable place — or a failed geocode
 * request — throws an error telling the caller to try a ZIP code.
 * `fetchImpl` is injectable for tests.
 */
export async function resolveRedfinSearchUrl(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const q = query.trim();
  const zip = zipFromQuery(q);
  if (zip) return redfinZipUrl(zip);
  if (!q) throw unresolvablePlaceError(query);

  let bb: RedfinBoundingBox | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${NOMINATIM_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
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
        ? (parsed[0] as { boundingbox?: unknown } | undefined)
        : undefined;
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
    bb = null;
  } finally {
    clearTimeout(timer);
  }
  if (!bb) throw unresolvablePlaceError(q);
  return redfinViewportUrl(bb);
}

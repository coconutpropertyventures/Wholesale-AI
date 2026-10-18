// Pure parsing of listing URLs into a structured address.
// Zillow:  /homedetails/2309-S-Meridian-St-Indianapolis-IN-46225/12345678_zpid/
// Redfin:  /IN/Indianapolis/2309-S-Meridian-St-46225/home/12345678
//          /home/12345678 with a slug in earlier segments on some shares.
// Only what the URL itself carries is extracted — nothing is invented;
// fields the slug does not contain stay undefined.

export interface ParsedListingUrl {
  source: "zillow" | "redfin" | "other";
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  externalId?: string;
}

// State codes appear in slugs as two UPPERCASE letters ("IN"); requiring
// uppercase keeps street suffixes like "St" from being eaten as a state.
const US_STATE = /^[A-Z]{2}$/;
const ZIP = /^\d{5}$/;

function titleWord(word: string): string {
  if (US_STATE.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** "2309-s-meridian-st-indianapolis-in-46225" segments -> readable parts. */
function slugToParts(slug: string): {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
} {
  const tokens = slug
    .split("-")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return {};
  // Work from the end: [.., state, zip] or [.., zip] tails are common.
  let rest = [...tokens];
  let zip: string | undefined;
  let state: string | undefined;
  if (rest.length > 1 && ZIP.test(rest[rest.length - 1])) {
    zip = rest.pop();
  }
  if (rest.length > 1 && US_STATE.test(rest[rest.length - 1])) {
    state = rest.pop()?.toUpperCase();
  }
  // The street is everything up to the first token that cannot be part of
  // a street: we approximate by taking tokens until the remaining tail
  // looks like a city (>= 1 token left). Street tokens are the leading run
  // that starts with the house number when present.
  let streetTokens = rest;
  let cityTokens: string[] = [];
  const numberIdx = rest.findIndex((t) => /^\d+$/.test(t));
  if (numberIdx === 0 && rest.length > 2) {
    // Heuristic: street = number + following tokens up to a suffix word
    // (St/Ave/Blvd/...) when one appears early; otherwise number + 2 tokens.
    const SUFFIXES = new Set([
      "st", "street", "ave", "avenue", "blvd", "boulevard", "dr", "drive",
      "ln", "lane", "ct", "court", "rd", "road", "pl", "place", "way",
      "cir", "circle", "trl", "ter", "hwy", "pkwy",
    ]);
    let end = Math.min(rest.length - 1, 3);
    for (let i = 1; i < rest.length; i++) {
      if (SUFFIXES.has(rest[i].toLowerCase())) {
        end = i + 1;
        break;
      }
    }
    streetTokens = rest.slice(0, end);
    cityTokens = rest.slice(end);
  }
  const street =
    streetTokens.length > 0
      ? streetTokens.map(titleWord).join(" ")
      : undefined;
  const city =
    cityTokens.length > 0 ? cityTokens.map(titleWord).join(" ") : undefined;
  return { street, city, state, zip };
}

function joinAddress(parts: {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}): string | undefined {
  const segments = [parts.street, parts.city, parts.state]
    .filter((s): s is string => Boolean(s && s.length > 0))
    .join(", ");
  const full = parts.zip
    ? segments
      ? `${segments} ${parts.zip}`
      : parts.zip
    : segments;
  return full.length > 0 ? full : undefined;
}

export function parseListingUrl(rawUrl: string): ParsedListingUrl {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { source: "other" };
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  if (host.includes("zillow")) {
    const idx = segments.indexOf("homedetails");
    const slug = idx >= 0 ? segments[idx + 1] : undefined;
    const idSeg = idx >= 0 ? segments[idx + 2] : undefined;
    const externalId = idSeg?.replace(/_zpid$/i, "") || undefined;
    if (!slug) return { source: "zillow", externalId };
    const parts = slugToParts(slug);
    return {
      source: "zillow",
      address: joinAddress(parts),
      city: parts.city,
      state: parts.state,
      zip: parts.zip,
      externalId,
    };
  }

  if (host.includes("redfin")) {
    // /IN/Indianapolis/<slug>/home/<id> or /<state>/<city>/<slug>/home/<id>
    const homeIdx = segments.indexOf("home");
    const idSeg = homeIdx >= 0 ? segments[homeIdx + 1] : undefined;
    const externalId = idSeg && /^\d+$/.test(idSeg) ? idSeg : undefined;
    const slug = homeIdx >= 1 ? segments[homeIdx - 1] : undefined;
    const stateSeg =
      segments.length > 0 && US_STATE.test(segments[0])
        ? segments[0]
        : undefined;
    const citySeg =
      segments.length > 1 && stateSeg ? segments[1] : undefined;
    if (!slug) return { source: "redfin", externalId, state: stateSeg };
    const parts = slugToParts(slug);
    const city = parts.city ?? (citySeg ? titleWord(citySeg) : undefined);
    const state = parts.state ?? stateSeg;
    return {
      source: "redfin",
      address: joinAddress({ ...parts, city, state }),
      city,
      state,
      zip: parts.zip,
      externalId,
    };
  }

  return { source: "other" };
}

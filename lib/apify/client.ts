// Apify REST client for listing data.
// NOTE: Actor access here uses Apify's REST run-sync endpoint; the same
// Actors are exposed to agents through Apify MCP (mcp.apify.com). Inside
// this web app the direct REST call is the stable transport — no MCP
// session to babysit per request.
// The token lives ONLY in process.env.APIFY_TOKEN (server-side). When it
// is absent, apifyConfigured() is false and callers must say so plainly —
// this client never fabricates listing data.
import { mapApifyRow, mapRedfinRow, type DealPrefill } from "@/lib/deals/prefill";
import { resolveRedfinSearchUrl } from "@/lib/deals/redfinUrl";

const APIFY_BASE = "https://api.apify.com/v2";
const RUN_TIMEOUT_MS = 110_000;

export function apifyConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN?.trim());
}

export function zillowActorId(): string {
  return process.env.APIFY_ZILLOW_ACTOR?.trim() || "maxcopell/zillow-detail-scraper";
}

export function redfinActorId(): string {
  return process.env.APIFY_REDFIN_ACTOR?.trim() || "tri_angle/redfin-search";
}

/** Redfin listing DETAIL Actor (agent lookup for blast enrichment).
 *  memo23's schema takes `startUrls` as plain URL STRINGS — {url}
 *  objects fail its validation (verified live, 2026-10-18). A run
 *  costs roughly $0.009 per property pulled. */
export function redfinDetailActorId(): string {
  return (
    process.env.APIFY_REDFIN_DETAIL_ACTOR?.trim() ||
    "memo23/apify-redfin-cheerio"
  );
}

type RawRow = Record<string, unknown>;

/**
 * Run an Actor synchronously and return its dataset rows.
 * Actor IDs are "username/name"; the API path wants "username~name".
 * Inputs must match each Actor's verified schema EXACTLY (checked with
 * fetch-actor-details, 2026-10-18): Apify Actors silently ignore keys
 * outside their schema, so a "merged, send-every-plausible-key" input
 * looks accepted while the Actor never sees the values it needs — that
 * is exactly how the Redfin search broke (production run
 * p6c7cmHm6VG8SGtHq FAILED in 2.3s). Each caller below sends only the
 * keys its Actor actually defines.
 */
export async function runActorSync(
  actorId: string,
  input: Record<string, unknown>,
): Promise<RawRow[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error("Apify is not configured: APIFY_TOKEN is not set.");
  const pathId = actorId.replace("/", "~");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${APIFY_BASE}/acts/${pathId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: "no-store",
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Apify run failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? (parsed as RawRow[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Single-listing lookup for a pasted Zillow/Redfin link (or its address). */
export async function lookupListing(input: {
  url?: string;
  address?: string;
}): Promise<DealPrefill | null> {
  // maxcopell/zillow-detail-scraper's verified schema (fetch-actor-details,
  // 2026-10-18): `startUrls` (home detail URLs) and/or `addresses`
  // ("123 Main St, City, State"). Its optional `propertyStatus` enum
  // defaults to RECENTLY_SOLD, but per the Actor's docs it determines
  // the status itself — do NOT send it. Send only these two keys.
  const actorInput: Record<string, unknown> = {};
  if (input.url) {
    actorInput.startUrls = [{ url: input.url }];
  }
  if (input.address) {
    actorInput.addresses = [input.address];
  }
  const rows = await runActorSync(zillowActorId(), actorInput);
  if (rows.length === 0) return null;
  const prefill = mapApifyRow(rows[0]);
  if (!prefill.sourceUrl && input.url) prefill.sourceUrl = input.url;
  return prefill;
}

/**
 * Redfin search for a city / ZIP query. Returns mapped rows.
 * tri_angle/redfin-search's verified schema (fetch-actor-details,
 * 2026-10-18) accepts ONLY `searchUrls` — an array of {url} holding
 * Redfin MAP search URLs — plus an optional `zoomIn` boolean. It has no
 * search/query/keyword/maxItems fields. The map URL is built by
 * lib/deals/redfinUrl.ts: a /zipcode/{zip} URL for ZIP queries, or a
 * geocoded /zipcode/{postcode}/filter/viewport= URL (clamped to the
 * place's central area) for city queries.
 */
export async function searchRedfin(query: string): Promise<DealPrefill[]> {
  const url = await resolveRedfinSearchUrl(query);
  const rows = await runActorSync(redfinActorId(), {
    searchUrls: [{ url }],
    zoomIn: true,
  });
  return rows.map(mapRedfinRow).filter((p) => p.address || p.listPrice);
}

// ---------- Async runs (start / poll / fetch) ----------
//
// The Redfin detail Actor takes ~50s for one property — far too slow
// for run-sync inside a web request (Vercel kills the function first).
// Callers with slow Actors use the async REST lifecycle instead:
// start the run, poll its status in short requests, then read the
// dataset once it succeeds. The blast enrichment step machine
// (lib/blast/service.ts) is built on these three helpers.

const ASYNC_CALL_TIMEOUT_MS = 30_000;

export interface ActorRunRef {
  runId: string;
  /** Apify run status: READY | RUNNING | SUCCEEDED | FAILED |
   *  TIMED-OUT | ABORTED (plus transient ABORTING / TIMING-OUT). */
  status: string;
  datasetId?: string;
}

function requireToken(): string {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error("Apify is not configured: APIFY_TOKEN is not set.");
  return token;
}

async function apifyFetch(
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const token = requireToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASYNC_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${APIFY_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
      { ...init, signal: controller.signal, cache: "no-store" },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Apify request failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed: unknown = text ? JSON.parse(text) : {};
    return (parsed ?? {}) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function runRefFrom(payload: Record<string, unknown>): ActorRunRef {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  return {
    runId: String(data.id ?? ""),
    status: String(data.status ?? ""),
    datasetId:
      typeof data.defaultDatasetId === "string"
        ? data.defaultDatasetId
        : undefined,
  };
}

/** Start an Actor run without waiting for it. POST /v2/acts/{id}/runs. */
export async function startActorRun(
  actorId: string,
  input: Record<string, unknown>,
): Promise<ActorRunRef> {
  const pathId = actorId.replace("/", "~");
  const payload = await apifyFetch(`/acts/${pathId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const ref = runRefFrom(payload);
  if (!ref.runId) throw new Error("Apify did not return a run id.");
  return ref;
}

/** Poll one run's status. GET /v2/actor-runs/{id}. */
export async function getActorRun(runId: string): Promise<ActorRunRef> {
  const payload = await apifyFetch(`/actor-runs/${encodeURIComponent(runId)}`);
  return runRefFrom(payload);
}

/** Read a finished run's dataset rows. GET /v2/datasets/{id}/items. */
export async function getDatasetItems(datasetId: string): Promise<RawRow[]> {
  const token = requireToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASYNC_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}`,
      { signal: controller.signal, cache: "no-store" },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Apify dataset read failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    const parsed: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? (parsed as RawRow[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

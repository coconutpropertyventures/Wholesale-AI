// Blast IO: queue building from HighLevel / the property cache, and
// the shared send engine. The engine is the ONLY way blast items send —
// the manual step route and the background tick both call stepBlastRun,
// so the rails in lib/blast/pacing.ts are enforced server-side no
// matter who drives. All sends go through lib/comms/send.ts
// (sendApprovedDraft) — suppression check, live DND re-check, and the
// audit log happen there, never here.
import {
  addContactNote,
  createContact,
  createOpportunity,
  findContactByPhone,
  getContact,
  ghlConfigured,
  ghlLocationId,
  listOpenOpportunities,
  normalizePhoneDigits,
  updateOpportunityStage,
  type GhlOpportunity,
} from "@/lib/ghl/client";
import { PRE_SCREENING_ID } from "@/lib/ghl/pipelineMap";
import { cacheKey, getCachedPrefill, putCachedPrefill } from "@/lib/deals/cache";
import {
  mapRedfinDetailRow,
  type DealPrefill,
  type RedfinDetail,
} from "@/lib/deals/prefill";
import {
  apifyConfigured,
  getActorRun,
  getDatasetItems,
  redfinDetailActorId,
  startActorRun,
} from "@/lib/apify/client";
import { sendApprovedDraft } from "@/lib/comms/send";
import {
  addAudit,
  createBlastItems,
  createBlastRun,
  createDraft,
  getBlastRun,
  listAllBlastItems,
  listBlastItems,
  listBlastRuns,
  listMessageOutcomes,
  listSuppressions,
  updateBlastItem,
  updateBlastRun,
  updateDraft,
} from "@/lib/store/store";
import {
  CONTACTED_STAGE_ID,
  LISTING_STREET_FIELD_ID,
  contactStreetKey,
  personalizedBody,
  planBlastItems,
  streetFromListingName,
  streetKey,
  type BlastCandidate,
  type BlastPlanContext,
} from "@/lib/blast/build";
import {
  afterSend,
  decidePacing,
  nextWaitAfterSend,
  planTick,
  type TickPlanEntry,
} from "@/lib/blast/pacing";
import type {
  BlastItem,
  BlastRun,
  BlastScriptKey,
  BlastSource,
} from "@/lib/types";

/** Pre-Screening · 🚨 NEW PROSPECT 🚨 (verified in lib/ghl/pipelineMap.ts). */
const NEW_PROSPECT_STAGE_ID = "b6db489b-8214-4f32-8cdc-3d2404747b3b";
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LIVE_RUN_STATUSES: BlastRun["status"][] = [
  "draft",
  "approved",
  "sending",
  "paused",
];

export class BlastError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BlastError";
    this.code = code;
  }
}

// ---------- Shared serialization / counts ----------

export interface BlastCounts {
  total: number;
  enriching: number;
  queued: number;
  sending: number;
  sent: number;
  skippedDnd: number;
  failed: number;
  noPhone: number;
  suppressed: number;
  recent: number;
  active: number;
}

export function blastCounts(items: BlastItem[]): BlastCounts {
  const counts: BlastCounts = {
    total: items.length,
    enriching: 0,
    queued: 0,
    sending: 0,
    sent: 0,
    skippedDnd: 0,
    failed: 0,
    noPhone: 0,
    suppressed: 0,
    recent: 0,
    active: 0,
  };
  for (const item of items) {
    switch (item.status) {
      case "enriching": counts.enriching += 1; break;
      case "queued": counts.queued += 1; break;
      case "sending": counts.sending += 1; break;
      case "sent": counts.sent += 1; break;
      case "skipped_dnd": counts.skippedDnd += 1; break;
      case "failed": counts.failed += 1; break;
      case "missing_phone": counts.noPhone += 1; break;
      case "skipped_suppressed": counts.suppressed += 1; break;
      case "skipped_recent": counts.recent += 1; break;
      case "skipped_active": counts.active += 1; break;
    }
  }
  return counts;
}

export interface BlastRunDetail {
  run: BlastRun;
  items: BlastItem[];
  counts: BlastCounts;
  sentToday: number;
}

function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Sends today (America/New_York) for THIS run — the daily cap is a
 *  per-run field, so the count is per run too. */
export function countSentToday(items: BlastItem[], now = new Date()): number {
  const today = etDate(now);
  return items.filter(
    (i) =>
      i.status === "sent" && i.sentAt && etDate(new Date(i.sentAt)) === today,
  ).length;
}

export async function getBlastRunDetail(
  runId: string,
): Promise<BlastRunDetail | null> {
  const run = await getBlastRun(runId);
  if (!run) return null;
  const items = await listBlastItems(runId);
  return { run, items, counts: blastCounts(items), sentToday: countSentToday(items) };
}

// ---------- Queue building ----------

async function pool<T, R>(
  inputs: T[],
  size: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(inputs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, inputs.length) },
    async () => {
      while (next < inputs.length) {
        const i = next;
        next += 1;
        out[i] = await fn(inputs[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function firstNameOf(name?: string, firstName?: string): string | undefined {
  if (firstName?.trim()) return firstName.trim();
  const word = name?.trim().split(/\s+/)[0];
  return word && word.length > 0 ? word : undefined;
}

// ---------- Shared build context + agent resolution ----------

/** The pure-plan context (suppression / active / recent sets) plus the
 *  open opportunities both queue building and enrichment resolution
 *  work against. Loaded fresh by each operation so exclusions always
 *  reflect the latest store state. */
interface PlanContextBundle {
  planCtx: BlastPlanContext;
  openOpps: GhlOpportunity[];
}

async function loadPlanContext(
  locationId: string,
): Promise<PlanContextBundle> {
  const [suppressions, allRuns, allItems, outcomes, openOpps] =
    await Promise.all([
      listSuppressions(),
      listBlastRuns(),
      listAllBlastItems(),
      listMessageOutcomes(),
      listOpenOpportunities(locationId),
    ]);
  const suppressedPhones = new Set(
    suppressions
      .map((s) => normalizePhoneDigits(s.value))
      .filter((d) => d.length >= 7),
  );
  const liveRunIds = new Set(
    allRuns.filter((r) => LIVE_RUN_STATUSES.includes(r.status)).map((r) => r.id),
  );
  const activeKeys = new Set<string>();
  const recentKeys = new Set<string>();
  const nowMs = Date.now();
  for (const item of allItems) {
    if (!item.contactId) continue;
    const key = contactStreetKey(item.contactId, item.street);
    if (
      liveRunIds.has(item.runId) &&
      (item.status === "queued" || item.status === "sending" || item.status === "sent")
    ) {
      activeKeys.add(key);
    }
    if (
      item.status === "sent" &&
      item.sentAt &&
      nowMs - Date.parse(item.sentAt) < RECENT_WINDOW_MS
    ) {
      recentKeys.add(key);
    }
  }
  for (const outcome of outcomes) {
    if (!outcome.contactId) continue;
    if (nowMs - Date.parse(outcome.createdAt) < RECENT_WINDOW_MS) {
      recentKeys.add(
        contactStreetKey(
          outcome.contactId,
          streetFromListingName(outcome.address),
        ),
      );
    }
  }
  return {
    planCtx: { suppressedPhones, activeKeys, recentKeys },
    openOpps,
  };
}

/** Open opportunities indexed by contact+street pair. */
function buildOppByPair(
  openOpps: GhlOpportunity[],
): Map<string, GhlOpportunity> {
  const oppByPair = new Map<string, GhlOpportunity>();
  for (const o of openOpps) {
    oppByPair.set(contactStreetKey(o.contactId, streetFromListingName(o.name)), o);
  }
  return oppByPair;
}

/**
 * The normal workbench resolution path, shared by queue building and
 * by enrichment once a detail pull lands an agent phone: find the
 * canonical GHL contact by phone (create it — with the Listing Street
 * field stamped — when none exists) and make sure an open opportunity
 * exists for that contact+street in Pre-Screening · New Prospect.
 * Assumes merged.agentPhone is a dialable number; throws on any GHL
 * failure so the caller can record it as a resolution failure.
 */
async function resolveAgentCandidate(args: {
  merged: DealPrefill;
  address: string;
  street: string;
  locationId: string;
  oppByPair: Map<string, GhlOpportunity>;
}): Promise<BlastCandidate> {
  const { merged, address, street, locationId, oppByPair } = args;
  const agentPhone = merged.agentPhone as string;
  let contact = await findContactByPhone(locationId, agentPhone);
  if (!contact) {
    const name = merged.agentName?.trim();
    const parts = name?.split(/\s+/) ?? [];
    contact = await createContact({
      locationId,
      firstName: parts[0],
      lastName: parts.slice(1).join(" ") || undefined,
      name,
      phone: agentPhone,
      email: merged.agentEmail,
      customFields: [{ id: LISTING_STREET_FIELD_ID, value: street }],
    });
  }
  const pairKey = contactStreetKey(contact.id, street);
  let opp = oppByPair.get(pairKey);
  if (!opp) {
    opp = await createOpportunity({
      locationId,
      pipelineId: PRE_SCREENING_ID,
      pipelineStageId: NEW_PROSPECT_STAGE_ID,
      contactId: contact.id,
      name: address,
    });
    oppByPair.set(pairKey, opp);
  }
  return {
    contactId: contact.id,
    contactName: contact.name ?? merged.agentName,
    firstName: firstNameOf(contact.name, contact.firstName),
    opportunityId: opp.id,
    street,
    phone: contact.phone ?? agentPhone,
  };
}

/** planBlastItems' dedupe identity for a candidate, mirrored so item
 *  metadata (address / listing URL) can be attached after planning. */
function pairKeyOf(c: { contactId?: string; street: string }): string {
  return c.contactId
    ? contactStreetKey(c.contactId, c.street)
    : `unresolved|${streetKey(c.street)}`;
}

export interface BuildBlastRunInput {
  source: BlastSource;
  stageRef?: { pipelineId: string; stageId: string };
  properties?: DealPrefill[];
  scriptKey: BlastScriptKey;
  dailyCap?: number;
  /**
   * Skip the review step: create the run already approved so the
   * background engine starts it on the next tick. Used ONLY by the
   * workbench's "Send to all" button — that click is Bradley's
   * explicit send instruction for the visible list. All engine
   * exclusions (no phone, DND, suppressed, recently contacted) and
   * pacing rails still apply unchanged.
   */
  autoApprove?: boolean;
}

export async function buildBlastRun(
  input: BuildBlastRunInput,
): Promise<BlastRunDetail> {
  if (!ghlConfigured()) {
    throw new BlastError(
      "not_configured",
      "GoHighLevel is not configured (GHL_PRIVATE_TOKEN missing).",
    );
  }
  const locationId = ghlLocationId();
  if (!locationId) {
    throw new BlastError("not_configured", "GHL_LOCATION_ID is not set.");
  }

  // ----- Exclusion context (suppression list, live runs, 30-day history) --
  const { planCtx, openOpps } = await loadPlanContext(locationId);

  // ----- Candidates -------------------------------------------------------
  const candidates: BlastCandidate[] = [];
  const resolutionFailures: (BlastCandidate & { error: string })[] = [];
  // Property identity per candidate (keyed like planBlastItems dedupes)
  // so created items can carry their address + listing URL — the
  // agent-lookup enrichment matches detail rows back by URL.
  const metaByPairKey = new Map<string, { address: string; sourceUrl?: string }>();
  const noteMeta = (
    c: BlastCandidate,
    meta: { address: string; sourceUrl?: string },
  ) => {
    const key = pairKeyOf(c);
    if (!metaByPairKey.has(key)) metaByPairKey.set(key, meta);
  };

  if (input.source === "stage") {
    if (!input.stageRef) {
      throw new BlastError(
        "bad_request",
        "stageRef { pipelineId, stageId } is required for a stage-source run.",
      );
    }
    const { pipelineId, stageId } = input.stageRef;
    const opps = openOpps.filter(
      (o) => o.pipelineId === pipelineId && o.pipelineStageId === stageId,
    );
    const contactIds = [...new Set(opps.map((o) => o.contactId))];
    const contacts = await pool(contactIds, 6, async (id) => {
      try {
        return await getContact(id);
      } catch {
        return null;
      }
    });
    const byId = new Map(
      contactIds.map((id, i) => [id, contacts[i]] as const),
    );
    for (const opp of opps) {
      const contact = byId.get(opp.contactId);
      const candidate: BlastCandidate = {
        contactId: opp.contactId,
        contactName: contact?.name,
        firstName: firstNameOf(contact?.name, contact?.firstName),
        opportunityId: opp.id,
        street: streetFromListingName(opp.name),
        phone: contact?.phone,
      };
      candidates.push(candidate);
      noteMeta(candidate, { address: opp.name });
    }
  } else {
    // Workbench selection (primary source): resolve each property's
    // listing agent from the cached detail (never invented), upsert the
    // canonical GHL contact by phone, and make sure an open opportunity
    // exists for that contact+street in Pre-Screening · New Prospect.
    const properties = (input.properties ?? []).filter((p) => p.address);
    const oppByPair = buildOppByPair(openOpps);
    const resolved = await pool(properties, 4, async (posted) => {
      const address = posted.address as string;
      const street = streetFromListingName(address);
      let merged: DealPrefill = posted;
      try {
        const cached = await getCachedPrefill(address, 3650);
        if (cached) {
          merged = { ...cached.prefill };
          for (const [k, v] of Object.entries(posted)) {
            if (v !== undefined) {
              (merged as unknown as Record<string, unknown>)[k] = v;
            }
          }
        }
      } catch {
        // cache is best-effort; the posted card data stands on its own
      }
      const meta = {
        address,
        sourceUrl: merged.sourceUrl ?? posted.sourceUrl,
      };
      const agentPhone = merged.agentPhone;
      if (!agentPhone || normalizePhoneDigits(agentPhone).length < 7) {
        return { candidate: { street, phone: undefined } as BlastCandidate, meta };
      }
      try {
        const candidate = await resolveAgentCandidate({
          merged,
          address,
          street,
          locationId,
          oppByPair,
        });
        return { candidate, meta };
      } catch (err) {
        return {
          failure: {
            street,
            phone: agentPhone,
            error: `Agent resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          } as BlastCandidate & { error: string },
          meta,
        };
      }
    });
    for (const r of resolved) {
      if (r.failure) {
        resolutionFailures.push(r.failure);
        noteMeta(r.failure, r.meta);
      } else if (r.candidate) {
        candidates.push(r.candidate);
        noteMeta(r.candidate, r.meta);
      }
    }
  }

  // ----- Plan + persist ---------------------------------------------------
  const plan = planBlastItems(candidates, planCtx);
  const run = await createBlastRun({
    source: input.source,
    stageRef: input.stageRef,
    scriptKey: input.scriptKey,
    dailyCap: input.dailyCap,
  });
  const created = await createBlastItems([
    ...plan.items.map((p) => {
      const meta = metaByPairKey.get(pairKeyOf(p));
      return {
        runId: run.id,
        contactId: p.contactId,
        contactName: p.contactName,
        firstName: p.firstName,
        opportunityId: p.opportunityId,
        street: p.street,
        address: meta?.address,
        sourceUrl: meta?.sourceUrl,
        phone: p.phone,
        status: p.status,
        error: p.error,
      };
    }),
    ...resolutionFailures.map((f) => {
      const meta = metaByPairKey.get(pairKeyOf(f));
      return {
        runId: run.id,
        contactId: f.contactId,
        contactName: f.contactName,
        firstName: f.firstName,
        opportunityId: f.opportunityId,
        street: f.street,
        address: meta?.address,
        sourceUrl: meta?.sourceUrl,
        phone: f.phone,
        status: "failed" as const,
        error: f.error,
      };
    }),
  ]);

  // ----- Agent lookup hand-off ---------------------------------------------
  // Redfin search rows carry NO agent data, so a workbench property
  // with a listing URL but no agent phone is not written off as
  // missing_phone at build time: it starts as "enriching" and the
  // detail pull (enrichBlastRunStep) gets its chance to find the
  // listing agent. Stage-sourced items and URL-less properties behave
  // exactly as before. Enrichment only ever runs on properties
  // Bradley put into a blast — never on search/load.
  let items = created;
  if (input.source === "search") {
    const flipped = new Map<string, BlastItem>();
    for (const item of created) {
      if (item.status === "missing_phone" && item.sourceUrl) {
        const updated = await updateBlastItem(item.id, {
          status: "enriching",
          error: undefined,
        });
        if (updated) flipped.set(item.id, updated);
      }
    }
    if (flipped.size > 0) {
      items = created.map((i) => flipped.get(i.id) ?? i);
    }
  }
  const enrichingCount = items.filter((i) => i.status === "enriching").length;
  await addAudit("blast", "blast.run_created", {
    runId: run.id,
    source: run.source,
    scriptKey: run.scriptKey,
    counts: plan.counts,
    resolutionFailures: resolutionFailures.length,
    enriching: enrichingCount,
    autoApprove: input.autoApprove === true,
  });
  if (input.autoApprove) {
    if (enrichingCount > 0) {
      // "Send to all" is an approval for the list, but a run must not
      // start half-resolved: it stays a draft while the agent lookup
      // runs (approveBlastRun refuses too), and Bradley approves from
      // the panel once every lookup lands.
      const noted = await updateBlastRun(run.id, {
        note: "Agent lookup running — this run can be approved once every lookup resolves.",
      });
      return {
        run: noted ?? run,
        items,
        counts: blastCounts(items),
        sentToday: 0,
      };
    }
    // "Send to all": the button press IS the approval. Flip the fresh
    // draft run to approved through the same lifecycle function the
    // BlastPanel Approve button uses; the engine picks it up on the
    // next tick (item exclusions computed above still stand).
    const approved = await approveBlastRun(run.id);
    return {
      run: approved.run,
      items,
      counts: blastCounts(items),
      sentToday: 0,
    };
  }
  return {
    run,
    items,
    counts: blastCounts(items),
    sentToday: 0,
  };
}

// ---------- Run lifecycle ----------

export async function approveBlastRun(runId: string): Promise<BlastRunDetail> {
  const detail = await getBlastRunDetail(runId);
  if (!detail) throw new BlastError("not_found", `Blast run ${runId} not found.`);
  if (detail.run.status !== "draft" && detail.run.status !== "paused") {
    throw new BlastError(
      "bad_status",
      `Run is "${detail.run.status}"; only draft or paused runs can be approved.`,
    );
  }
  // A run must not start sending half-resolved: while any item is
  // still waiting on the agent lookup, approval is refused.
  const enriching = detail.items.filter(
    (i) => i.status === "enriching",
  ).length;
  if (enriching > 0) {
    throw new BlastError(
      "bad_status",
      `Agent lookup still running for ${enriching} item(s) — approval unlocks when every lookup resolves.`,
    );
  }
  // Bradley's approval click — the one human gate before any send.
  const run = await updateBlastRun(runId, { status: "approved", note: undefined });
  await addAudit("bradley", "blast.run_approved", { runId });
  return { ...detail, run: run ?? detail.run };
}

export async function pauseBlastRun(runId: string): Promise<BlastRunDetail> {
  const detail = await getBlastRunDetail(runId);
  if (!detail) throw new BlastError("not_found", `Blast run ${runId} not found.`);
  const run = await updateBlastRun(runId, {
    status: "paused",
    note: "Paused by Bradley.",
  });
  await addAudit("bradley", "blast.run_paused", { runId });
  return { ...detail, run: run ?? detail.run };
}

export async function stopBlastRun(runId: string): Promise<BlastRunDetail> {
  const detail = await getBlastRunDetail(runId);
  if (!detail) throw new BlastError("not_found", `Blast run ${runId} not found.`);
  const run = await updateBlastRun(runId, {
    status: "stopped",
    note: "Stopped by Bradley.",
  });
  await addAudit("bradley", "blast.run_stopped", { runId });
  return { ...detail, run: run ?? detail.run };
}

// ---------- Agent lookup enrichment ----------
//
// Redfin SEARCH rows carry no agent data at all, so workbench items
// built from them would all die as missing_phone. Instead, an item
// with a listing URL but no agent phone starts as "enriching" and this
// step machine pulls the property's Redfin DETAIL page via the
// memo23 Actor — the MLS disclaimer block on that page names the
// listing agent and his direct number. The detail Actor takes ~50s
// per property, so the run is ASYNC: each enrich step does one short
// piece of work (start the run / poll it / apply its rows) and the
// panel polls the step endpoint. Enrichment spends Apify credits only
// on properties Bradley put into a blast — never on search or load.

export type EnrichPhase = "idle" | "started" | "running" | "applied" | "failed";

export interface EnrichResult extends BlastRunDetail {
  phase: EnrichPhase;
  /** Items still in "enriching" after this step. */
  pending: number;
  /** Phase "applied": items whose agent phone was found and whose
   *  resolution through the normal path was applied. */
  resolved?: number;
  /** Phase "applied"/"failed": items that ended up missing_phone. */
  missing?: number;
}

/** Max listing URLs per detail run; extra items wait for the next batch. */
const ENRICH_BATCH_URLS = 25;
const ENRICH_TERMINAL_FAILURES = ["FAILED", "ABORTED", "TIMED-OUT"];

function normalizeListingUrl(url?: string): string {
  return (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * The batch an outstanding (or next) detail run covers: the first
 * ENRICH_BATCH_URLS distinct listing URLs among the enriching items,
 * in item order. Computed identically at start and at apply time —
 * the enriching set cannot change in between — so batches line up.
 */
function enrichBatch(enriching: BlastItem[]): {
  urls: string[];
  inBatch: Set<string>;
} {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of enriching) {
    if (!item.sourceUrl) continue;
    const key = normalizeListingUrl(item.sourceUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    if (urls.length < ENRICH_BATCH_URLS) urls.push(item.sourceUrl);
  }
  const batchKeys = new Set(urls.map(normalizeListingUrl));
  const inBatch = new Set(
    enriching
      .filter(
        (i) => i.sourceUrl && batchKeys.has(normalizeListingUrl(i.sourceUrl)),
      )
      .map((i) => i.id),
  );
  return { urls, inBatch };
}

export async function enrichBlastRunStep(
  runId: string,
): Promise<EnrichResult> {
  const detail = await getBlastRunDetail(runId);
  if (!detail) throw new BlastError("not_found", `Blast run ${runId} not found.`);
  const enriching = detail.items.filter((i) => i.status === "enriching");
  const reload = async (): Promise<BlastRunDetail> =>
    (await getBlastRunDetail(runId)) ?? detail;
  const remaining = (d: BlastRunDetail) =>
    d.items.filter((i) => i.status === "enriching").length;

  // ----- Phase 1: start the detail run ------------------------------------
  if (!detail.run.enrichRunId) {
    if (enriching.length === 0) {
      return { ...detail, phase: "idle", pending: 0 };
    }
    const { urls } = enrichBatch(enriching);
    if (!apifyConfigured() || urls.length === 0) {
      const error = !apifyConfigured()
        ? "Agent lookup unavailable: APIFY_TOKEN is not set."
        : "No listing URL to look up.";
      for (const item of enriching) {
        await updateBlastItem(item.id, { status: "missing_phone", error });
      }
      await addAudit("blast", "blast.enrich_failed", {
        runId,
        reason: !apifyConfigured() ? "apify_not_configured" : "no_urls",
        items: enriching.length,
      });
      const fresh = await reload();
      return {
        ...fresh,
        phase: "failed",
        pending: remaining(fresh),
        missing: enriching.length,
      };
    }
    // memo23's schema wants startUrls as plain URL strings.
    const started = await startActorRun(redfinDetailActorId(), {
      startUrls: urls,
    });
    await updateBlastRun(runId, {
      enrichRunId: started.runId,
      enrichDatasetId: started.datasetId,
    });
    await addAudit("blast", "blast.enrich_started", {
      runId,
      apifyRunId: started.runId,
      urls: urls.length,
      pending: enriching.length,
    });
    const fresh = await reload();
    return { ...fresh, phase: "started", pending: remaining(fresh) };
  }

  // ----- Phase 2: poll the outstanding run ---------------------------------
  const runRef = await getActorRun(detail.run.enrichRunId);

  if (ENRICH_TERMINAL_FAILURES.includes(runRef.status)) {
    const { inBatch } = enrichBatch(enriching);
    let missing = 0;
    for (const item of enriching) {
      // Items outside this batch keep their chance with the next one.
      if (item.sourceUrl && !inBatch.has(item.id)) continue;
      await updateBlastItem(item.id, {
        status: "missing_phone",
        error: `Agent lookup failed (${runRef.status.toLowerCase()}); no agent phone found.`,
      });
      missing += 1;
    }
    await updateBlastRun(runId, {
      enrichRunId: undefined,
      enrichDatasetId: undefined,
    });
    await addAudit("blast", "blast.enrich_failed", {
      runId,
      apifyStatus: runRef.status,
      items: missing,
    });
    const fresh = await reload();
    return {
      ...fresh,
      phase: "failed",
      pending: remaining(fresh),
      missing,
    };
  }

  if (runRef.status !== "SUCCEEDED") {
    return { ...detail, phase: "running", pending: enriching.length };
  }

  // ----- Phase 3: apply the detail rows ------------------------------------
  if (!ghlConfigured()) {
    throw new BlastError(
      "not_configured",
      "GoHighLevel is not configured (GHL_PRIVATE_TOKEN missing).",
    );
  }
  const locationId = ghlLocationId();
  if (!locationId) {
    throw new BlastError("not_configured", "GHL_LOCATION_ID is not set.");
  }
  const datasetId = detail.run.enrichDatasetId ?? runRef.datasetId;
  const rows = datasetId ? await getDatasetItems(datasetId) : [];
  const details: RedfinDetail[] = rows.map((r) => mapRedfinDetailRow(r));
  const { planCtx, openOpps } = await loadPlanContext(locationId);
  const oppByPair = buildOppByPair(openOpps);
  const { inBatch } = enrichBatch(enriching);
  let resolved = 0;
  let missing = 0;

  for (const item of enriching) {
    if (!inBatch.has(item.id)) {
      // Not in this batch: a URL-bearing item waits for the next
      // batch; a URL-less one can never resolve (defensive — build
      // never creates one).
      if (!item.sourceUrl) {
        await updateBlastItem(item.id, {
          status: "missing_phone",
          error: "No listing URL to look up.",
        });
        missing += 1;
      }
      continue;
    }
    const found =
      details.find(
        (d) =>
          d.sourceUrl &&
          item.sourceUrl &&
          normalizeListingUrl(d.sourceUrl) === normalizeListingUrl(item.sourceUrl),
      ) ??
      (item.address
        ? details.find(
            (d) => d.address && cacheKey(d.address) === cacheKey(item.address as string),
          )
        : undefined);
    const address = item.address ?? found?.address ?? item.street;

    // Merge whatever the detail pull found into the property cache
    // (best-effort) so the workbench and future builds reuse it.
    let cachedPrefill: DealPrefill | undefined;
    try {
      cachedPrefill = (await getCachedPrefill(address, 3650))?.prefill;
    } catch {
      // cache is best-effort
    }
    const phone =
      found?.agentPhone &&
      normalizePhoneDigits(found.agentPhone).length >= 7
        ? found.agentPhone
        : undefined;
    const enriched: DealPrefill = {
      ...(cachedPrefill ?? { source: "redfin" as const }),
      address: cachedPrefill?.address ?? address,
      sourceUrl:
        cachedPrefill?.sourceUrl ?? found?.sourceUrl ?? item.sourceUrl,
      agentName: found?.agentName ?? cachedPrefill?.agentName,
      agentPhone: phone ?? cachedPrefill?.agentPhone,
      agentBrokerage: found?.agentBrokerage ?? cachedPrefill?.agentBrokerage,
    };
    if (found) {
      try {
        await putCachedPrefill(address, enriched, "apify-detail");
      } catch {
        // cache is best-effort
      }
    }

    if (!phone) {
      // The broker's office line is NOT a substitute — the listing
      // agent's own number or nothing.
      await updateBlastItem(item.id, {
        status: "missing_phone",
        contactName: found?.agentName ?? item.contactName,
        error: "Detail pull found no agent phone.",
      });
      missing += 1;
      continue;
    }
    try {
      const candidate = await resolveAgentCandidate({
        merged: enriched,
        address,
        street: item.street,
        locationId,
        oppByPair,
      });
      // The build-time rails still apply to the resolved candidate
      // (suppression / already-active / contacted <30 days).
      const planned = planBlastItems([candidate], planCtx).items[0];
      await updateBlastItem(item.id, {
        contactId: planned.contactId,
        contactName: planned.contactName,
        firstName: planned.firstName,
        opportunityId: planned.opportunityId,
        phone: planned.phone,
        status: planned.status,
        error: planned.error,
      });
      resolved += 1;
    } catch (err) {
      await updateBlastItem(item.id, {
        status: "failed",
        phone,
        error: `Agent resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  await updateBlastRun(runId, {
    enrichRunId: undefined,
    enrichDatasetId: undefined,
  });
  await addAudit("blast", "blast.enrich_applied", {
    runId,
    resolved,
    missing,
  });
  const fresh = await reload();
  return {
    ...fresh,
    phase: "applied",
    pending: remaining(fresh),
    resolved,
    missing,
  };
}

// ---------- The send engine (shared by step route + tick) ----------

export type StepOutcome =
  | { kind: "refused"; reason: string }
  | { kind: "waiting"; waitSeconds: number; why: "gap" | "group_pause" }
  | { kind: "cap" }
  | { kind: "complete" }
  | { kind: "sent"; item: BlastItem; nextWaitSeconds: number }
  | { kind: "skipped"; item: BlastItem }
  | { kind: "failed"; item?: BlastItem; error: string };

export interface StepResult extends BlastRunDetail {
  outcome: StepOutcome;
}

function fmtNoteTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export async function stepBlastRun(
  runId: string,
  actor = "blast",
): Promise<StepResult> {
  const detail = await getBlastRunDetail(runId);
  if (!detail) throw new BlastError("not_found", `Blast run ${runId} not found.`);
  const { run, items } = detail;
  const now = new Date();
  const decision = decidePacing(run, detail.sentToday, now.getTime());

  if (decision.kind === "bad_status") {
    return {
      ...detail,
      outcome: {
        kind: "refused",
        reason: `Run is "${run.status}"; only approved/sending runs can send. Nothing was sent.`,
      },
    };
  }
  if (decision.kind === "capped") {
    if (!run.note?.startsWith("Daily cap")) {
      const updated = await updateBlastRun(runId, {
        note: `Daily cap reached — ${detail.sentToday} sent today (cap ${run.dailyCap}).`,
      });
      if (updated) detail.run = updated;
    }
    return { ...detail, outcome: { kind: "cap" } };
  }
  if (decision.kind === "wait") {
    return {
      ...detail,
      outcome: {
        kind: "waiting",
        waitSeconds: decision.waitSeconds,
        why: decision.why,
      },
    };
  }

  const item = items.find((i) => i.status === "queued");
  if (!item) {
    const updated = await updateBlastRun(runId, {
      status: "complete",
      note: undefined,
    });
    if (updated) detail.run = updated;
    detail.items = await listBlastItems(runId);
    detail.counts = blastCounts(detail.items);
    return { ...detail, outcome: { kind: "complete" } };
  }
  if (!item.contactId || !item.phone) {
    // Should be unreachable (such items are never "queued"), but fail
    // safe: mark it and pause rather than send anything half-resolved.
    const failed = await updateBlastItem(item.id, {
      status: "failed",
      error: "Queued item is missing a contact or phone; refusing to send.",
    });
    const updatedRun = await updateBlastRun(runId, {
      status: "paused",
      note: "Fail-stop: a queued item was missing its contact/phone.",
    });
    if (updatedRun) detail.run = updatedRun;
    detail.items = await listBlastItems(runId);
    detail.counts = blastCounts(detail.items);
    return {
      ...detail,
      outcome: {
        kind: "failed",
        item: failed,
        error: "Queued item is missing a contact or phone.",
      },
    };
  }

  await updateBlastItem(item.id, { status: "sending", error: undefined });
  const sentAt = new Date().toISOString();
  try {
    let first = item.firstName;
    if (!first) {
      try {
        const contact = await getContact(item.contactId);
        first = firstNameOf(contact.name, contact.firstName);
      } catch {
        // personalization falls back to the template token, visibly
      }
    }
    const body = personalizedBody(run.scriptKey, first, item.street);
    // The per-item draft is created and approved under the run's
    // approval (Bradley's approve click on the run) so the send goes
    // through the single gated send path with its suppression + live
    // DND re-checks and audit entries.
    const draft = await createDraft({
      feed: "ghl",
      contactId: item.contactId,
      to: item.phone,
      body,
    });
    await updateDraft(draft.id, {
      status: "approved",
      approvedAt: sentAt,
    });
    const result = await sendApprovedDraft(draft.id, actor);

    if (result.ok) {
      const updatedItem = await updateBlastItem(item.id, {
        status: "sent",
        ghlMessageId: result.externalId,
        sentAt,
        error: undefined,
      });
      const bookkeeping = afterSend(run, sentAt);
      const updatedRun = await updateBlastRun(runId, {
        status: "sending",
        startedAt: run.startedAt ?? sentAt,
        note: undefined,
        ...bookkeeping,
      });
      // Confirmed-send write-backs ONLY (never pre-marked): the dated
      // note with the exact text, and the Contacted stage move.
      try {
        await addContactNote(
          item.contactId,
          `${fmtNoteTimestamp(sentAt)} — Blast text sent via Wholesale AI (${run.scriptKey}): ${body}`,
        );
      } catch (err) {
        await addAudit(actor, "blast.note_failed", {
          runId,
          itemId: item.id,
          contactId: item.contactId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (item.opportunityId) {
        try {
          await updateOpportunityStage(item.opportunityId, CONTACTED_STAGE_ID);
        } catch (err) {
          await addAudit(actor, "blast.stage_move_failed", {
            runId,
            itemId: item.id,
            opportunityId: item.opportunityId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      detail.run = updatedRun ?? detail.run;
      detail.items = await listBlastItems(runId);
      detail.counts = blastCounts(detail.items);
      detail.sentToday = countSentToday(detail.items);
      return {
        ...detail,
        outcome: {
          kind: "sent",
          item: updatedItem ?? item,
          nextWaitSeconds: nextWaitAfterSend(bookkeeping.groupSentCount),
        },
      };
    }

    if (
      result.outcome === "blocked_dnd" ||
      result.outcome === "blocked_suppression"
    ) {
      // Do-not-contact: skip this item and CONTINUE the run.
      const updatedItem = await updateBlastItem(item.id, {
        status: "skipped_dnd",
        error: result.error ?? result.outcome,
      });
      detail.items = await listBlastItems(runId);
      detail.counts = blastCounts(detail.items);
      return {
        ...detail,
        outcome: { kind: "skipped", item: updatedItem ?? item },
      };
    }

    // Any other failure: fail-stop. Item failed, run auto-paused, the
    // error surfaced — nothing else sends until Bradley looks.
    const updatedItem = await updateBlastItem(item.id, {
      status: "failed",
      error: result.error ?? result.outcome,
    });
    const updatedRun = await updateBlastRun(runId, {
      status: "paused",
      note: `Fail-stop: ${result.error ?? result.outcome}`,
    });
    if (updatedRun) detail.run = updatedRun;
    detail.items = await listBlastItems(runId);
    detail.counts = blastCounts(detail.items);
    return {
      ...detail,
      outcome: {
        kind: "failed",
        item: updatedItem,
        error: result.error ?? result.outcome,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updatedItem = await updateBlastItem(item.id, {
      status: "failed",
      error: message,
    });
    const updatedRun = await updateBlastRun(runId, {
      status: "paused",
      note: `Fail-stop: ${message}`,
    });
    if (updatedRun) detail.run = updatedRun;
    detail.items = await listBlastItems(runId);
    detail.counts = blastCounts(detail.items);
    return {
      ...detail,
      outcome: { kind: "failed", item: updatedItem, error: message },
    };
  }
}

// ---------- Background tick ----------

export interface TickSummaryEntry {
  runId: string;
  action: "sent" | "skipped" | "waiting" | "paused" | "cap" | "idle";
  waitSeconds?: number;
  error?: string;
}

/**
 * One background tick: every approved/sending run is considered, and
 * each due run sends AT MOST one item through the shared engine. All
 * rails live in the engine/pacing — the tick only schedules.
 */
export async function tickBlast(actor = "blast-tick"): Promise<TickSummaryEntry[]> {
  const runs = (await listBlastRuns()).filter(
    (r) => r.status === "approved" || r.status === "sending",
  );
  const inputs = [];
  for (const run of runs) {
    const items = await listBlastItems(run.id);
    inputs.push({
      run,
      sentToday: countSentToday(items),
      hasQueued: items.some((i) => i.status === "queued"),
    });
  }
  const plan: TickPlanEntry[] = planTick(inputs, Date.now());
  const summary: TickSummaryEntry[] = [];
  for (const entry of plan) {
    if (entry.action !== "send") {
      summary.push({
        runId: entry.runId,
        action: entry.action,
        waitSeconds: entry.waitSeconds,
      });
      continue;
    }
    try {
      const result = await stepBlastRun(entry.runId, actor);
      switch (result.outcome.kind) {
        case "sent":
          summary.push({ runId: entry.runId, action: "sent" });
          break;
        case "skipped":
          summary.push({ runId: entry.runId, action: "skipped" });
          break;
        case "waiting":
          summary.push({
            runId: entry.runId,
            action: "waiting",
            waitSeconds: result.outcome.waitSeconds,
          });
          break;
        case "cap":
          summary.push({ runId: entry.runId, action: "cap" });
          break;
        case "complete":
          summary.push({ runId: entry.runId, action: "idle" });
          break;
        case "failed":
          summary.push({
            runId: entry.runId,
            action: "paused",
            error: result.outcome.error,
          });
          break;
        default:
          summary.push({ runId: entry.runId, action: "paused" });
      }
    } catch (err) {
      summary.push({
        runId: entry.runId,
        action: "paused",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}

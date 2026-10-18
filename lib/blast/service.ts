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
import { getCachedPrefill } from "@/lib/deals/cache";
import type { DealPrefill } from "@/lib/deals/prefill";
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
  type BlastCandidate,
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

export interface BuildBlastRunInput {
  source: BlastSource;
  stageRef?: { pipelineId: string; stageId: string };
  properties?: DealPrefill[];
  scriptKey: BlastScriptKey;
  dailyCap?: number;
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

  // ----- Candidates -------------------------------------------------------
  const candidates: BlastCandidate[] = [];
  const resolutionFailures: (BlastCandidate & { error: string })[] = [];

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
      candidates.push({
        contactId: opp.contactId,
        contactName: contact?.name,
        firstName: firstNameOf(contact?.name, contact?.firstName),
        opportunityId: opp.id,
        street: streetFromListingName(opp.name),
        phone: contact?.phone,
      });
    }
  } else {
    // Workbench selection (primary source): resolve each property's
    // listing agent from the cached detail (never invented), upsert the
    // canonical GHL contact by phone, and make sure an open opportunity
    // exists for that contact+street in Pre-Screening · New Prospect.
    const properties = (input.properties ?? []).filter((p) => p.address);
    const oppByPair = new Map<string, GhlOpportunity>();
    for (const o of openOpps) {
      oppByPair.set(contactStreetKey(o.contactId, streetFromListingName(o.name)), o);
    }
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
      const agentPhone = merged.agentPhone;
      if (!agentPhone || normalizePhoneDigits(agentPhone).length < 7) {
        return { candidate: { street, phone: undefined } as BlastCandidate };
      }
      try {
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
            customFields: [
              { id: LISTING_STREET_FIELD_ID, value: street },
            ],
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
          candidate: {
            contactId: contact.id,
            contactName: contact.name ?? merged.agentName,
            firstName: firstNameOf(contact.name, contact.firstName),
            opportunityId: opp.id,
            street,
            phone: contact.phone ?? agentPhone,
          } as BlastCandidate,
        };
      } catch (err) {
        return {
          failure: {
            street,
            phone: agentPhone,
            error: `Agent resolution failed: ${err instanceof Error ? err.message : String(err)}`,
          } as BlastCandidate & { error: string },
        };
      }
    });
    for (const r of resolved) {
      if (r.failure) resolutionFailures.push(r.failure);
      else if (r.candidate) candidates.push(r.candidate);
    }
  }

  // ----- Plan + persist ---------------------------------------------------
  const plan = planBlastItems(candidates, {
    suppressedPhones,
    activeKeys,
    recentKeys,
  });
  const run = await createBlastRun({
    source: input.source,
    stageRef: input.stageRef,
    scriptKey: input.scriptKey,
    dailyCap: input.dailyCap,
  });
  const items = await createBlastItems([
    ...plan.items.map((p) => ({
      runId: run.id,
      contactId: p.contactId,
      contactName: p.contactName,
      firstName: p.firstName,
      opportunityId: p.opportunityId,
      street: p.street,
      phone: p.phone,
      status: p.status,
      error: p.error,
    })),
    ...resolutionFailures.map((f) => ({
      runId: run.id,
      contactId: f.contactId,
      contactName: f.contactName,
      firstName: f.firstName,
      opportunityId: f.opportunityId,
      street: f.street,
      phone: f.phone,
      status: "failed" as const,
      error: f.error,
    })),
  ]);
  await addAudit("blast", "blast.run_created", {
    runId: run.id,
    source: run.source,
    scriptKey: run.scriptKey,
    counts: plan.counts,
    resolutionFailures: resolutionFailures.length,
  });
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

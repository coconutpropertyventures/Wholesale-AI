// Client-side fetch helpers for the dashboard.
// The /api/ghl/* routes are built against lib/types shapes, but these
// normalizers stay defensive about wrapper keys ({ conversations: [...] },
// { drafts: [...] }, bare arrays) so the UI degrades honestly instead of
// crashing if a payload shape drifts.
import type {
  Conversation,
  ConversationMessage,
  Draft,
} from "@/lib/types";

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function pickArray(v: unknown, key: string): unknown[] {
  if (Array.isArray(v)) return v;
  const rec = asRecord(v);
  if (!rec) return [];
  if (Array.isArray(rec[key])) return rec[key] as unknown[];
  if (Array.isArray(rec.data)) return rec.data as unknown[];
  return [];
}

export function configuredFlag(v: unknown): boolean {
  const rec = asRecord(v);
  return rec?.configured === true;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`);
  return (await res.json()) as unknown;
}

export async function fetchGhlConfigured(): Promise<boolean> {
  try {
    return configuredFlag(await getJson("/api/ghl/contacts"));
  } catch {
    return false;
  }
}

export interface InboxData {
  configured: boolean;
  conversations: Conversation[];
}

export async function fetchConversations(): Promise<InboxData> {
  const raw = await getJson("/api/ghl/conversations");
  const conversations = pickArray(raw, "conversations")
    .map(normalizeConversation)
    .filter((c): c is Conversation => c !== null);
  return { configured: configuredFlag(raw), conversations };
}

export async function fetchConversationMessages(
  conversationId: string,
): Promise<ConversationMessage[]> {
  const raw = await getJson(
    `/api/ghl/conversations?conversationId=${encodeURIComponent(conversationId)}`,
  );
  const rec = asRecord(raw);
  const convo = asRecord(rec?.conversation);
  const candidates: unknown[] = [
    rec?.messages,
    convo?.messages,
    asRecord(rec?.messages)?.messages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map(normalizeMessage)
        .filter((m): m is ConversationMessage => m !== null);
    }
  }
  return [];
}

// ---------- Pipeline ----------

export interface PipelineData {
  configured: boolean;
  stages: { stage: string; count: number }[];
  totals?: { open: number; won: number; lost: number };
}

export async function fetchPipeline(): Promise<PipelineData> {
  const raw = await getJson("/api/ghl/pipeline");
  const rec = asRecord(raw);
  const stages = pickArray(raw, "stages")
    .map((s) => {
      const r = asRecord(s);
      if (!r || typeof r.stage !== "string") return null;
      return {
        stage: r.stage,
        count: typeof r.count === "number" ? r.count : 0,
      };
    })
    .filter((s): s is { stage: string; count: number } => s !== null);
  const totalsRec = asRecord(rec?.totals);
  const totals =
    totalsRec &&
    typeof totalsRec.open === "number" &&
    typeof totalsRec.won === "number" &&
    typeof totalsRec.lost === "number"
      ? { open: totalsRec.open, won: totalsRec.won, lost: totalsRec.lost }
      : undefined;
  return { configured: configuredFlag(raw), stages, totals };
}

// ---------- Gmail ----------

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  email?: string;
}

export async function fetchGmailStatus(): Promise<GmailStatus> {
  try {
    const rec = asRecord(await getJson("/api/gmail/status"));
    return {
      configured: rec?.configured === true,
      connected: rec?.connected === true,
      email: str(rec?.email),
    };
  } catch {
    return { configured: false, connected: false };
  }
}

export interface GmailInboxData {
  configured: boolean;
  connected: boolean;
  conversations: Conversation[];
}

export async function fetchGmailConversations(): Promise<GmailInboxData> {
  const raw = await getJson("/api/gmail/messages");
  const rec = asRecord(raw);
  return {
    configured: rec?.configured === true,
    connected: rec?.connected === true,
    conversations: pickArray(raw, "conversations")
      .map(normalizeConversation)
      .filter((c): c is Conversation => c !== null),
  };
}

export interface GmailThreadData {
  conversation: Conversation | null;
  messages: ConversationMessage[];
  subject?: string;
}

export async function fetchGmailThread(
  threadId: string,
): Promise<GmailThreadData> {
  const raw = await getJson(
    `/api/gmail/messages?threadId=${encodeURIComponent(threadId)}`,
  );
  const rec = asRecord(raw);
  const convoRaw = asRecord(rec?.conversation);
  return {
    conversation: convoRaw ? normalizeConversation(convoRaw) : null,
    messages: pickArray(raw, "messages")
      .map(normalizeMessage)
      .filter((m): m is ConversationMessage => m !== null),
    subject: str(rec?.subject),
  };
}

// ---------- Drafts ----------

export interface CreateDraftPayload {
  feed: "ghl" | "gmail" | "voice";
  contactId?: string;
  to?: string;
  subject?: string;
  threadRef?: string;
  body: string;
}

/** POST a draft. Resolves with the server's draft; throws with the
 *  server's error message on failure. Creating a draft never sends. */
export async function createDraft(
  payload: CreateDraftPayload,
): Promise<Draft> {
  const res = await fetch("/api/ghl/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ??
      `Draft save failed (${res.status})`;
    throw new Error(msg);
  }
  const draft = normalizeDraft(asRecord(data)?.draft);
  if (!draft) throw new Error("Draft save returned an unexpected response.");
  return draft;
}

export async function fetchDrafts(): Promise<Draft[]> {
  const raw = await getJson("/api/ghl/drafts");
  return pickArray(raw, "drafts")
    .map(normalizeDraft)
    .filter((d): d is Draft => d !== null);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function normalizeConversation(v: unknown): Conversation | null {
  const rec = asRecord(v);
  if (!rec || typeof rec.id !== "string") return null;
  const messages = Array.isArray(rec.messages)
    ? rec.messages
        .map(normalizeMessage)
        .filter((m): m is ConversationMessage => m !== null)
    : undefined;
  return {
    id: rec.id,
    organizationId: str(rec.organizationId) ?? "",
    feed:
      rec.feed === "gmail" || rec.feed === "voice" ? rec.feed : "ghl",
    contactId: str(rec.contactId) ?? "",
    contactName: str(rec.contactName) ?? str(rec.fullName),
    subject: str(rec.subject),
    lastMessageBody: str(rec.lastMessageBody) ?? str(rec.lastMessage),
    lastMessageDate: str(rec.lastMessageDate),
    lastMessageDirection: str(rec.lastMessageDirection),
    unreadCount: typeof rec.unreadCount === "number" ? rec.unreadCount : undefined,
    messages,
  };
}

export function normalizeMessage(v: unknown): ConversationMessage | null {
  const rec = asRecord(v);
  if (!rec || typeof rec.id !== "string") return null;
  return {
    id: rec.id,
    direction: rec.direction === "outbound" ? "outbound" : "inbound",
    body: typeof rec.body === "string" ? rec.body : "",
    dateAdded: str(rec.dateAdded) ?? "",
    type: str(rec.type) ?? "SMS",
  };
}

export function normalizeDraft(v: unknown): Draft | null {
  const rec = asRecord(v);
  if (!rec || typeof rec.id !== "string") return null;
  const status = rec.status;
  return {
    id: rec.id,
    organizationId: str(rec.organizationId) ?? "",
    feed:
      rec.feed === "gmail" || rec.feed === "voice" ? rec.feed : "ghl",
    contactId: str(rec.contactId),
    to: typeof rec.to === "string" ? rec.to : "",
    subject: str(rec.subject),
    threadRef: str(rec.threadRef),
    body: typeof rec.body === "string" ? rec.body : "",
    status:
      status === "approved" ||
      status === "sent" ||
      status === "rejected" ||
      status === "draft"
        ? status
        : "draft",
    createdAt: str(rec.createdAt) ?? "",
    approvedAt: str(rec.approvedAt),
    sentAt: str(rec.sentAt),
    externalId: str(rec.externalId),
  };
}

// ---------- Pipeline map (badges + filtering) ----------

export interface PipelineMapEntry {
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  opportunityName: string;
  isDeal: boolean;
}

export interface PipelineMapData {
  configured: boolean;
  byContact: Record<string, PipelineMapEntry[]>;
  stageCounts: Record<string, number>;
  error?: string;
}

export async function fetchPipelineMap(): Promise<PipelineMapData> {
  try {
    const raw = await getJson("/api/ghl/pipeline-map");
    const rec = asRecord(raw);
    const byRaw = asRecord(rec?.byContact);
    const byContact: Record<string, PipelineMapEntry[]> = {};
    if (byRaw) {
      for (const [contactId, entries] of Object.entries(byRaw)) {
        if (!Array.isArray(entries)) continue;
        byContact[contactId] = entries
          .map((e) => {
            const r = asRecord(e);
            if (!r) return null;
            return {
              pipelineId: str(r.pipelineId) ?? "",
              pipelineName: str(r.pipelineName) ?? "",
              stageId: str(r.stageId) ?? "",
              stageName: str(r.stageName) ?? "",
              opportunityName: str(r.opportunityName) ?? "",
              isDeal: r.isDeal === true,
            };
          })
          .filter((e): e is PipelineMapEntry => e !== null);
      }
    }
    const countsRaw = asRecord(rec?.stageCounts);
    const stageCounts: Record<string, number> = {};
    if (countsRaw) {
      for (const [k, v] of Object.entries(countsRaw)) {
        if (typeof v === "number") stageCounts[k] = v;
      }
    }
    return {
      configured: rec?.configured === true,
      byContact,
      stageCounts,
      error: str(rec?.error),
    };
  } catch {
    return { configured: false, byContact: {}, stageCounts: {} };
  }
}

// ---------- Listing data (Apify lookup + Redfin search) ----------

import type { DealPrefill } from "@/lib/deals/prefill";

export interface LookupResult {
  ok: boolean;
  configured?: boolean;
  cached?: boolean;
  found?: boolean;
  prefill?: DealPrefill;
  reason?: string;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  return asRecord(data);
}

export async function lookupListing(url: string): Promise<LookupResult> {
  const rec = await postJson("/api/deals/lookup", { url });
  if (!rec) return { ok: false, reason: "Lookup returned no response." };
  return {
    ok: rec.ok === true,
    configured: typeof rec.configured === "boolean" ? rec.configured : undefined,
    cached: rec.cached === true,
    found: typeof rec.found === "boolean" ? rec.found : undefined,
    prefill: rec.prefill ? (rec.prefill as DealPrefill) : undefined,
    reason: str(rec.reason),
  };
}

export interface RedfinSearchResult {
  ok: boolean;
  configured?: boolean;
  results: DealPrefill[];
  reason?: string;
}

export async function searchRedfinListings(
  query: string,
): Promise<RedfinSearchResult> {
  const rec = await postJson("/api/deals/search", { query });
  if (!rec) return { ok: false, results: [], reason: "Search returned no response." };
  return {
    ok: rec.ok === true,
    configured: typeof rec.configured === "boolean" ? rec.configured : undefined,
    results: pickArray(rec, "results") as DealPrefill[],
    reason: str(rec.reason),
  };
}

// ---------- RentCast verification (under-contract only) ----------

export interface VerifyResult {
  ok: boolean;
  matched?: boolean;
  configured?: boolean;
  cached?: boolean;
  reason?: string;
  data?: {
    valueEstimate?: number;
    rentEstimate?: number;
    beds?: number;
    baths?: number;
    sqft?: number;
    yearBuilt?: number;
  };
}

export async function verifyRentcast(address: string): Promise<VerifyResult> {
  const rec = await postJson("/api/deals/verify", { address });
  if (!rec) return { ok: false, reason: "Verification returned no response." };
  return {
    ok: rec.ok === true,
    matched: rec.matched === true,
    configured: typeof rec.configured === "boolean" ? rec.configured : undefined,
    cached: rec.cached === true,
    reason: str(rec.reason),
    data: rec.data ? (rec.data as VerifyResult["data"]) : undefined,
  };
}

// ---------- Message outcomes + AI drafting ----------

export interface OutcomesData {
  outcomes: unknown[];
  assignedUses: Record<string, number>;
}

export async function fetchOutcomes(): Promise<OutcomesData> {
  try {
    const raw = await getJson("/api/outcomes");
    const rec = asRecord(raw);
    const usesRaw = asRecord(rec?.assignedUses);
    const assignedUses: Record<string, number> = {};
    if (usesRaw) {
      for (const [k, v] of Object.entries(usesRaw)) {
        if (typeof v === "number") assignedUses[k] = v;
      }
    }
    return { outcomes: pickArray(raw, "outcomes"), assignedUses };
  } catch {
    return { outcomes: [], assignedUses: {} };
  }
}

export async function createOutcome(payload: {
  draftId: string;
  address: string;
  mode: string;
  variant: "first" | "offer";
  body: string;
  offerAmount?: number;
  contactId?: string;
}): Promise<void> {
  await postJson("/api/outcomes", payload as unknown as Record<string, unknown>);
}

export interface AiDraftOfferResult {
  ok: boolean;
  configured?: boolean;
  reason?: string;
  text?: string;
  model?: string;
  draft?: Draft;
  usage?: { estCostUsd?: number };
  error?: string;
}

export async function draftOfferAi(payload: {
  address: string;
  street: string;
  first: string;
  offer: number;
  mode: string;
  fee?: number;
  to: string;
}): Promise<AiDraftOfferResult> {
  const rec = await postJson(
    "/api/ai/draft-offer",
    payload as unknown as Record<string, unknown>,
  );
  if (!rec) return { ok: false, error: "AI drafting returned no response." };
  return {
    ok: rec.ok === true,
    configured: typeof rec.configured === "boolean" ? rec.configured : undefined,
    reason: str(rec.reason),
    text: str(rec.text),
    model: str(rec.model),
    draft: rec.draft ? normalizeDraft(rec.draft) ?? undefined : undefined,
    usage: rec.usage ? (rec.usage as AiDraftOfferResult["usage"]) : undefined,
    error: str(rec.error),
  };
}

export interface AiUsageData {
  configured: boolean;
  monthCostUsd: number;
  budgetUsd: number;
  calls: number;
}

export async function fetchAiUsage(): Promise<AiUsageData | null> {
  try {
    const rec = asRecord(await getJson("/api/ai/usage"));
    if (!rec) return null;
    return {
      configured: rec.configured === true,
      monthCostUsd: typeof rec.monthCostUsd === "number" ? rec.monthCostUsd : 0,
      budgetUsd: typeof rec.budgetUsd === "number" ? rec.budgetUsd : 25,
      calls: typeof rec.calls === "number" ? rec.calls : 0,
    };
  } catch {
    return null;
  }
}

// ---------- Blast ----------

export interface BlastRunData {
  id: string;
  source: string;
  stageRef?: { pipelineId: string; stageId: string };
  scriptKey: string;
  status: string;
  dailyCap: number;
  note?: string;
  lastSentAt?: string;
  groupSentCount: number;
  createdAt: string;
  startedAt?: string;
}

export interface BlastItemData {
  id: string;
  runId: string;
  contactId?: string;
  contactName?: string;
  firstName?: string;
  opportunityId?: string;
  street: string;
  phone?: string;
  status: string;
  ghlMessageId?: string;
  error?: string;
  sentAt?: string;
  createdAt: string;
}

export interface BlastCountsData {
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

export interface BlastRunDetailData {
  run: BlastRunData;
  items: BlastItemData[];
  counts: BlastCountsData;
  sentToday: number;
  outcome?: Record<string, unknown>;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function normalizeBlastRun(v: unknown): BlastRunData | null {
  const r = asRecord(v);
  if (!r || typeof r.id !== "string") return null;
  const stageRef = asRecord(r.stageRef);
  return {
    id: r.id,
    source: str(r.source) ?? "search",
    stageRef:
      stageRef &&
      typeof stageRef.pipelineId === "string" &&
      typeof stageRef.stageId === "string"
        ? { pipelineId: stageRef.pipelineId, stageId: stageRef.stageId }
        : undefined,
    scriptKey: str(r.scriptKey) ?? "turnkey_opener",
    status: str(r.status) ?? "draft",
    dailyCap: numOr(r.dailyCap, 250),
    note: str(r.note),
    lastSentAt: str(r.lastSentAt),
    groupSentCount: numOr(r.groupSentCount, 0),
    createdAt: str(r.createdAt) ?? "",
    startedAt: str(r.startedAt),
  };
}

function normalizeBlastItem(v: unknown): BlastItemData | null {
  const r = asRecord(v);
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    runId: str(r.runId) ?? "",
    contactId: str(r.contactId),
    contactName: str(r.contactName),
    firstName: str(r.firstName),
    opportunityId: str(r.opportunityId),
    street: str(r.street) ?? "",
    phone: str(r.phone),
    status: str(r.status) ?? "queued",
    ghlMessageId: str(r.ghlMessageId),
    error: str(r.error),
    sentAt: str(r.sentAt),
    createdAt: str(r.createdAt) ?? "",
  };
}

function normalizeBlastCounts(v: unknown): BlastCountsData {
  const r = asRecord(v);
  return {
    total: numOr(r?.total, 0),
    queued: numOr(r?.queued, 0),
    sending: numOr(r?.sending, 0),
    sent: numOr(r?.sent, 0),
    skippedDnd: numOr(r?.skippedDnd, 0),
    failed: numOr(r?.failed, 0),
    noPhone: numOr(r?.noPhone, 0),
    suppressed: numOr(r?.suppressed, 0),
    recent: numOr(r?.recent, 0),
    active: numOr(r?.active, 0),
  };
}

function normalizeBlastDetail(raw: unknown): BlastRunDetailData | null {
  const rec = asRecord(raw);
  const run = normalizeBlastRun(rec?.run);
  if (!run) return null;
  return {
    run,
    items: pickArray(raw, "items")
      .map(normalizeBlastItem)
      .filter((i): i is BlastItemData => i !== null),
    counts: normalizeBlastCounts(rec?.counts),
    sentToday: numOr(rec?.sentToday, 0),
    outcome: asRecord(rec?.outcome) ?? undefined,
  };
}

async function postJsonOrThrow(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data as { error?: string; reason?: string } | null)?.error ??
      (data as { error?: string; reason?: string } | null)?.reason ??
      `POST ${url} failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/** All runs (newest first) with counts — the panel reloads this to
 *  resume progress display; sending itself is server-side. */
export async function fetchBlastRuns(): Promise<{
  configured: boolean;
  runs: { run: BlastRunData; counts: BlastCountsData; sentToday: number }[];
}> {
  const raw = await getJson("/api/blast/runs");
  const rec = asRecord(raw);
  const runs = pickArray(raw, "runs")
    .map((entry) => {
      const e = asRecord(entry);
      const run = normalizeBlastRun(e?.run);
      if (!run) return null;
      return {
        run,
        counts: normalizeBlastCounts(e?.counts),
        sentToday: numOr(e?.sentToday, 0),
      };
    })
    .filter(
      (
        x,
      ): x is {
        run: BlastRunData;
        counts: BlastCountsData;
        sentToday: number;
      } => x !== null,
    );
  return { configured: rec?.configured === true, runs };
}

export async function fetchBlastRun(
  id: string,
): Promise<BlastRunDetailData | null> {
  return normalizeBlastDetail(await getJson(`/api/blast/runs/${id}`));
}

export async function createBlastRun(payload: {
  source: "search" | "stage";
  stageRef?: { pipelineId: string; stageId: string };
  properties?: unknown[];
  scriptKey: string;
  dailyCap?: number;
  /** "Send to all": create the run already approved (engine starts on
   *  the next tick). Omit for the review path (draft → Approve click). */
  autoApprove?: boolean;
}): Promise<BlastRunDetailData> {
  const raw = await postJsonOrThrow("/api/blast/runs", payload);
  const detail = normalizeBlastDetail(raw);
  if (!detail) throw new Error("Blast run build returned no run.");
  return detail;
}

export async function blastRunAction(
  id: string,
  action: "approve" | "step" | "pause" | "stop",
): Promise<BlastRunDetailData> {
  const raw = await postJsonOrThrow(`/api/blast/runs/${id}/${action}`);
  const detail = normalizeBlastDetail(raw);
  if (!detail) throw new Error(`Blast ${action} returned no run.`);
  return detail;
}

// ---------- Thread send (per-thread "Send" button) + AI reply drafting ---

/** Approve a draft via the drafts API (PATCH). Throws on failure. */
export async function approveDraft(id: string): Promise<void> {
  const res = await fetch("/api/ghl/drafts", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status: "approved" }),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ??
      `Draft approval failed (${res.status})`;
    throw new Error(msg);
  }
}

export interface ThreadSendResult {
  ok: boolean;
  outcome?: string;
  error?: string;
}

/**
 * Send an approved draft through POST /api/ghl/send — the same
 * endpoint DraftsPanel's "Send now" uses. Never throws for a blocked
 * send: the send path's refusal (suppression, live DND re-check, …)
 * comes back as { ok: false, error } so the composer can show the
 * reason inline and keep Bradley's text.
 */
export async function sendDraftById(id: string): Promise<ThreadSendResult> {
  const res = await fetch("/api/ghl/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draftId: id }),
  });
  const data: unknown = await res.json().catch(() => null);
  const rec = asRecord(data);
  return {
    ok: rec?.ok === true,
    outcome: str(rec?.outcome),
    error: str(rec?.error) ?? (res.ok ? undefined : `Send failed (${res.status})`),
  };
}

/**
 * The per-thread Send chain: create a Draft from the composer text,
 * approve it, then send it. Bradley typing the text and pressing Send
 * IS the approval — but the send still flows through the single
 * approval-gated path (lib/comms/send.ts: suppression + live DND
 * checks intact). There is no other send route for thread messages.
 */
export async function sendThreadMessage(
  payload: CreateDraftPayload,
): Promise<ThreadSendResult> {
  try {
    const draft = await createDraft(payload);
    await approveDraft(draft.id);
    return await sendDraftById(draft.id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AiDraftReplyResult {
  ok: boolean;
  configured?: boolean;
  text?: string;
  model?: string;
  /** "haiku" | "sonnet" — which tier drafted it (chip label). */
  modelTier?: string;
  /** Model-selection reason, e.g. "routine pre-deal communication". */
  reason?: string;
  error?: string;
}

/** POST /api/ai/draft-reply — fills the composer, never sends. */
export async function draftReplyAi(payload: {
  feed: "ghl" | "gmail";
  conversationId: string;
  contactId?: string;
  note?: string;
}): Promise<AiDraftReplyResult> {
  const rec = await postJson(
    "/api/ai/draft-reply",
    payload as unknown as Record<string, unknown>,
  );
  if (!rec) return { ok: false, error: "AI drafting returned no response." };
  return {
    ok: rec.ok === true,
    configured: typeof rec.configured === "boolean" ? rec.configured : undefined,
    text: str(rec.text),
    model: str(rec.model),
    modelTier: str(rec.modelTier),
    reason: str(rec.reason),
    error: str(rec.error),
  };
}

// ---------- Formatting ----------

export function fmtMoney(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return "$" + Math.round(v).toLocaleString("en-US");
}

export function fmtPct(v: number | undefined | null, digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(digits) + "%";
}

export function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US");
}

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

// HighLevel API v2 client (https://services.leadconnectorhq.com).
// Auth: Private Integration token (Bearer) + `Version: 2021-07-28` header.
// The token lives ONLY in process.env.GHL_PRIVATE_TOKEN (server-side).
// When it is absent every call throws GhlNotConfiguredError — this client
// never fabricates or falls back to sample data.
//
// Payload-shape notes (defensive by design): HighLevel v2 responses wrap
// collections ({ contacts: [...] }, { conversations: [...] }, and messages
// nested as { messages: { messages: [...] } }). Field names below follow
// the documented v2 shapes, but every access is optional-chained because
// HighLevel has shipped minor variations across resources/versions.
import {
  DEFAULT_ORG_ID,
  type Contact,
  type Conversation,
  type ConversationMessage,
} from "@/lib/types";
import { sortMessagesAscending } from "@/lib/messages";

const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export class GhlNotConfiguredError extends Error {
  constructor() {
    super(
      "GoHighLevel is not configured: GHL_PRIVATE_TOKEN is not set. " +
        "Add it via the secure secret store (see .env.example) — never paste it into chat or commit it.",
    );
    this.name = "GhlNotConfiguredError";
  }
}

export class GhlApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GhlApiError";
    this.status = status;
  }
}

export function ghlConfigured(): boolean {
  return Boolean(process.env.GHL_PRIVATE_TOKEN?.trim());
}

export function ghlLocationId(): string | undefined {
  return process.env.GHL_LOCATION_ID?.trim() || undefined;
}

function requireToken(): string {
  const token = process.env.GHL_PRIVATE_TOKEN?.trim();
  if (!token) throw new GhlNotConfiguredError();
  return token;
}

async function ghlFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = requireToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: API_VERSION,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!res.ok) {
    // Include HighLevel's own response body (first ~200 chars) so error
    // surfaces downstream — blast item errors, audit logs — show the
    // actual reason instead of a bare status code.
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 200);
    const msg = snippet
      ? `HighLevel API error ${res.status}: ${snippet}`
      : `HighLevel API error ${res.status}`;
    throw new GhlApiError(res.status, msg);
  }
  return parsed;
}

// ---------- Mapping helpers ----------

type Raw = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return new Date(v).toISOString();
  }
  return asString(v);
}

function mapContact(raw: Raw): Contact {
  const firstName = asString(raw.firstName);
  const lastName = asString(raw.lastName);
  const name =
    asString(raw.contactName) ??
    asString(raw.name) ??
    ([firstName, lastName].filter(Boolean).join(" ") || undefined);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    id: String(raw.id ?? ""),
    organizationId: DEFAULT_ORG_ID,
    feed: "ghl",
    firstName,
    lastName,
    name,
    phone: asString(raw.phone),
    email: asString(raw.email)?.toLowerCase(),
    // v2 contact payloads carry a boolean `dnd` (and a richer `dndSettings`
    // object); the boolean is the reliable top-level signal.
    dnd: raw.dnd === true,
    tags,
  };
}

function mapConversation(raw: Raw): Conversation {
  return {
    id: String(raw.id ?? ""),
    organizationId: DEFAULT_ORG_ID,
    feed: "ghl",
    contactId: String(raw.contactId ?? ""),
    contactName: asString(raw.contactName) ?? asString(raw.fullName),
    lastMessageBody: asString(raw.lastMessageBody) ?? asString(raw.lastMessage),
    lastMessageDate: toIso(raw.lastMessageDate),
    lastMessageDirection: asString(raw.lastMessageDirection),
    unreadCount:
      typeof raw.unreadCount === "number" ? raw.unreadCount : undefined,
  };
}

function mapMessage(raw: Raw): ConversationMessage {
  const direction =
    asString(raw.direction) === "outbound" ? "outbound" : "inbound";
  return {
    id: String(raw.id ?? ""),
    direction,
    body: asString(raw.body) ?? "",
    dateAdded: toIso(raw.dateAdded) ?? new Date(0).toISOString(),
    type: asString(raw.type) ?? asString(raw.messageType) ?? "SMS",
  };
}

// ---------- Contacts ----------

export async function listContacts(
  locationId: string,
  limit = 25,
): Promise<Contact[]> {
  const qs = new URLSearchParams({
    locationId,
    limit: String(limit),
  });
  const data = (await ghlFetch(`/contacts/?${qs.toString()}`)) as {
    contacts?: Raw[];
  };
  return (data.contacts ?? []).map(mapContact);
}

export async function getContact(contactId: string): Promise<Contact> {
  const data = (await ghlFetch(`/contacts/${contactId}`)) as {
    contact?: Raw;
  };
  // v2 wraps a single contact as { contact: {...} }; fall back to the
  // top-level object in case of shape drift.
  const raw = data.contact ?? (data as unknown as Raw);
  return mapContact(raw);
}

// ---------- Conversations ----------

export async function searchConversations(
  locationId: string,
  limit = 25,
): Promise<Conversation[]> {
  const qs = new URLSearchParams({
    locationId,
    limit: String(limit),
  });
  const data = (await ghlFetch(
    `/conversations/search?${qs.toString()}`,
  )) as { conversations?: Raw[] };
  return (data.conversations ?? []).map(mapConversation);
}

export async function getConversationMessages(
  conversationId: string,
): Promise<ConversationMessage[]> {
  const data = (await ghlFetch(
    `/conversations/${conversationId}/messages`,
  )) as { messages?: { messages?: Raw[] } | Raw[] };
  // v2 nests the list: { messages: { messages: [...] } }. Some resources
  // return { messages: [...] } directly — handle both.
  const list = Array.isArray(data.messages)
    ? data.messages
    : (data.messages?.messages ?? []);
  // HighLevel returns messages newest-first; the API contract here is
  // chat order (oldest → newest) so every client renders threads with
  // the newest message at the bottom.
  return sortMessagesAscending(list.map(mapMessage));
}

export async function getConversation(
  conversationId: string,
): Promise<Conversation & { messages: ConversationMessage[] }> {
  const data = (await ghlFetch(`/conversations/${conversationId}`)) as {
    conversation?: Raw;
  };
  const raw = data.conversation ?? (data as unknown as Raw);
  const base = mapConversation(raw);
  const messages = await getConversationMessages(conversationId);
  return { ...base, messages };
}

// ---------- Pipelines & opportunities ----------

export interface PipelineStage {
  id: string;
  name: string;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
}

function mapPipeline(raw: Raw): GhlPipeline {
  const stages = Array.isArray(raw.stages)
    ? (raw.stages as Raw[])
        .map((s) => ({
          id: String(s.id ?? ""),
          name: asString(s.name) ?? "",
        }))
        .filter((s) => s.id.length > 0 && s.name.length > 0)
    : [];
  return {
    id: String(raw.id ?? ""),
    name: asString(raw.name) ?? "",
    stages,
  };
}

export async function listPipelines(
  locationId: string,
): Promise<GhlPipeline[]> {
  const qs = new URLSearchParams({ locationId });
  const data = (await ghlFetch(
    `/opportunities/pipelines?${qs.toString()}`,
  )) as { pipelines?: Raw[] };
  return (data.pipelines ?? []).map(mapPipeline);
}

export interface OpportunityCountParams {
  locationId: string;
  pipelineId?: string;
  stageId?: string;
  status?: string; // open | won | lost | abandoned | all
}

/**
 * Count opportunities matching the filters via GET /opportunities/search
 * with limit=1 — only meta.total is read (defensively: some responses put
 * the total at the top level instead of under `meta`).
 */
export async function countOpportunities(
  params: OpportunityCountParams,
): Promise<number> {
  const qs = new URLSearchParams({
    location_id: params.locationId,
    limit: "1",
  });
  if (params.pipelineId) qs.set("pipeline_id", params.pipelineId);
  if (params.stageId) qs.set("pipeline_stage_id", params.stageId);
  if (params.status) qs.set("status", params.status);
  const data = (await ghlFetch(
    `/opportunities/search?${qs.toString()}`,
  )) as { meta?: { total?: unknown }; total?: unknown };
  const total = data.meta?.total ?? data.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export type StageCountLookup = (
  pipelineId: string,
  stageId: string,
) => Promise<number>;

/**
 * Pure aggregation: sum a per-(pipeline, stage) open-count lookup into
 * stage-NAME totals across all pipelines (the same stage name in two
 * pipelines is one number on the dashboard strip).
 */
export async function aggregateStageCounts(
  pipelines: GhlPipeline[],
  countFor: StageCountLookup,
): Promise<Map<string, number>> {
  const jobs: { name: string; count: Promise<number> }[] = [];
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      jobs.push({
        name: stage.name,
        count: countFor(pipeline.id, stage.id),
      });
    }
  }
  const counts = await Promise.all(jobs.map((j) => j.count));
  const totals = new Map<string, number>();
  jobs.forEach((job, i) => {
    totals.set(job.name, (totals.get(job.name) ?? 0) + counts[i]);
  });
  return totals;
}

/**
 * Normalize a stage name for MATCHING only: lowercase and strip every
 * non-alphanumeric character. Real HighLevel stage names are decorated —
 * e.g. the New Prospect stage is literally "🚨 NEW PROSPECT 🚨" — so pin
 * comparisons must not be exact-string. Display names are never altered;
 * this is used only to decide ordering.
 */
export function normalizeStageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Rank of a stage within a pinned-first list (0 = first pin), or -1 when
 * the stage is not pinned. Both sides are compared after
 * normalizeStageName, so "🚨 NEW PROSPECT 🚨" matches the pin "New Prospect".
 */
export function stagePinRank(stage: string, pinned: string[]): number {
  const target = normalizeStageName(stage);
  return pinned.findIndex((p) => normalizeStageName(p) === target);
}

export interface GhlOpportunity {
  id: string;
  name: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  status: string; // open | won | lost | abandoned
  /** Opportunity value in dollars, when HighLevel reports one. Feeds
   *  the AI model-selection value threshold (see lib/ai/modelSelect). */
  monetaryValue?: number;
}

function mapOpportunity(raw: Raw): GhlOpportunity | null {
  const id = asString(raw.id);
  const contactId = asString(raw.contactId);
  if (!id || !contactId) return null;
  const monetaryValue =
    typeof raw.monetaryValue === "number" && raw.monetaryValue > 0
      ? raw.monetaryValue
      : undefined;
  return {
    id,
    name: asString(raw.name) ?? "",
    contactId,
    pipelineId: asString(raw.pipelineId) ?? "",
    pipelineStageId: asString(raw.pipelineStageId) ?? "",
    status: asString(raw.status) ?? "open",
    monetaryValue,
  };
}

// 60s in-memory cache: the pipeline map, card filtering, RentCast gate and
// learning loop all read the same opportunity set, and the dashboard must
// not hammer HighLevel on every render.
let openOppsCache: { at: number; locationId: string; data: GhlOpportunity[] } | null =
  null;
const OPEN_OPPS_TTL_MS = 60_000;
const OPPS_PAGE_LIMIT = 100;
const OPPS_MAX_PAGES = 100;

/**
 * Every OPEN opportunity in the location, across all pipelines, paginated
 * through GET /opportunities/search (status=open). Cached for 60s per
 * location. Throws GhlNotConfiguredError when no token is set.
 */
export async function listOpenOpportunities(
  locationId: string,
): Promise<GhlOpportunity[]> {
  if (
    openOppsCache &&
    openOppsCache.locationId === locationId &&
    Date.now() - openOppsCache.at < OPEN_OPPS_TTL_MS
  ) {
    return openOppsCache.data;
  }
  const all: GhlOpportunity[] = [];
  for (let page = 1; page <= OPPS_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      location_id: locationId,
      status: "open",
      limit: String(OPPS_PAGE_LIMIT),
      page: String(page),
    });
    const data = (await ghlFetch(
      `/opportunities/search?${qs.toString()}`,
    )) as { opportunities?: Raw[] };
    const rows = (data.opportunities ?? [])
      .map(mapOpportunity)
      .filter((o): o is GhlOpportunity => o !== null);
    all.push(...rows);
    if (rows.length < OPPS_PAGE_LIMIT) break;
  }
  openOppsCache = { at: Date.now(), locationId, data: all };
  return all;
}

// ---------- Sending ----------

export interface SendSmsResult {
  /** Provider message id, when HighLevel returns one. */
  messageId?: string;
  conversationId?: string;
  raw: unknown;
}

export async function sendSms(
  contactId: string,
  message: string,
): Promise<SendSmsResult> {
  // v2 send-message endpoint: POST /conversations/messages
  // body: { type: "SMS", contactId, message }. The response is expected to
  // carry conversationId and messageId; both are read defensively.
  const data = (await ghlFetch(`/conversations/messages`, {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId, message }),
  })) as { conversationId?: string; messageId?: string } | undefined;
  return {
    messageId: data?.messageId,
    conversationId: data?.conversationId,
    raw: data,
  };
}

// ---------- Blast support: contact resolution + write-backs ----------

/** Digits-only phone comparison key: strips formatting and a leading US
 *  country code, so "(317) 555-0100", "+1 317 555 0100" and "3175550100"
 *  all compare equal. */
export function normalizePhoneDigits(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * Normalize a phone for HighLevel WRITES. The contacts API rejects
 * numbers that are not E.164 with a 400 (verified live 2026-10-18:
 * "317-550-0700" failed contact creation, "+13175500700" succeeded),
 * while detail scrapers hand us raw display formats. US numbers in any
 * common format become "+1XXXXXXXXXX"; an already-international "+"
 * number with 8–15 digits is returned in stripped "+digits" form.
 * Anything we don't recognize is passed through trimmed and untouched —
 * never mangle a number we don't understand.
 */
export function toE164Phone(phone?: string): string | undefined {
  if (phone === undefined) return undefined;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15
      ? `+${digits}`
      : trimmed;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

/**
 * Canonical-contact lookup by phone. Uses GET /contacts/lookup with the
 * number in E.164 form — v2's /contacts/search is POST-only, so a GET
 * against it 400s before any contact work happens (diagnosed live
 * 2026-10-18: blast agent resolution died there with a bare 400 while
 * the same payload created fine once lookup replaced search). Lookup
 * can return near matches, so results still go through an exact
 * normalized-digit equality check. Returns null when no contact carries
 * that number — callers create one instead of ever duplicating a
 * realtor. Lookup errors throw; there is no silent fallback.
 */
export async function findContactByPhone(
  locationId: string,
  phone: string,
): Promise<Contact | null> {
  const target = normalizePhoneDigits(phone);
  if (target.length < 7) return null;
  const qs = new URLSearchParams({
    locationId,
    phone: toE164Phone(phone) ?? phone,
  });
  const data = (await ghlFetch(`/contacts/lookup?${qs.toString()}`)) as {
    contacts?: Raw[];
  };
  const matches = (data.contacts ?? [])
    .map(mapContact)
    .filter((c) => c.phone && normalizePhoneDigits(c.phone) === target);
  return matches[0] ?? null;
}

export interface CreateContactInput {
  locationId: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
  email?: string;
  /** GHL custom field id → value, stamped at creation (e.g. Listing Street). */
  customFields?: { id: string; value: string }[];
}

export async function createContact(
  input: CreateContactInput,
): Promise<Contact> {
  const body: Record<string, unknown> = {
    locationId: input.locationId,
    firstName: input.firstName,
    lastName: input.lastName,
    name: input.name,
    phone: toE164Phone(input.phone),
    email: input.email,
  };
  if (input.customFields && input.customFields.length > 0) {
    body.customFields = input.customFields.map((f) => ({
      id: f.id,
      field_value: f.value,
    }));
  }
  const data = (await ghlFetch(`/contacts/`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { contact?: Raw };
  const raw = data.contact ?? (data as unknown as Raw);
  return mapContact(raw);
}

/** Add a note to a contact (used for the blast send log: date/time + the
 *  exact text sent, per Bradley's outreach logging rule). */
export async function addContactNote(
  contactId: string,
  body: string,
): Promise<void> {
  await ghlFetch(`/contacts/${contactId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export interface CreateOpportunityInput {
  locationId: string;
  pipelineId: string;
  pipelineStageId: string;
  contactId: string;
  name: string;
}

export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<GhlOpportunity> {
  const data = (await ghlFetch(`/opportunities/`, {
    method: "POST",
    body: JSON.stringify({
      locationId: input.locationId,
      pipelineId: input.pipelineId,
      pipelineStageId: input.pipelineStageId,
      contactId: input.contactId,
      name: input.name,
      status: "open",
    }),
  })) as { opportunity?: Raw };
  const raw = data.opportunity ?? (data as unknown as Raw);
  const opp = mapOpportunity(raw);
  if (!opp) {
    throw new GhlApiError(502, "HighLevel created an opportunity without an id/contact.");
  }
  return opp;
}

/**
 * Move an opportunity to another stage. Per the verified write-back
 * rules: PUT /opportunities/{id} with body { pipelineStageId } —
 * update-opportunity-status only changes open/won/lost/abandoned.
 */
export async function updateOpportunityStage(
  opportunityId: string,
  pipelineStageId: string,
): Promise<void> {
  await ghlFetch(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: JSON.stringify({ pipelineStageId }),
  });
}

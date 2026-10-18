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
    `/api/ghl/conversations?id=${encodeURIComponent(conversationId)}`,
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
    feed: "ghl",
    contactId: str(rec.contactId) ?? "",
    contactName: str(rec.contactName) ?? str(rec.fullName),
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

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
    const msg =
      (parsed as { message?: string } | undefined)?.message ??
      `HighLevel API error ${res.status}`;
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
  return list.map(mapMessage);
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

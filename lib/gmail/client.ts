// Gmail integration using the USER'S OWN Google Cloud OAuth client
// (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in server env). No Google SDK —
// plain fetch against oauth2.googleapis.com + gmail.googleapis.com, and
// node:crypto for token storage.
//
// Token storage: the OAuth tokens live in a single encrypted httpOnly
// cookie (wai_gmail_tokens), AES-256-GCM with key = sha256(client secret).
// The server keeps no Gmail credential at rest; the cookie IS the session.
// (A hosted database for tokens is future work — see README.)
//
// Honesty rules mirror the GHL client: when the client credentials are
// absent, gmailConfigured() is false and callers must show an explicit
// "not configured" state — never sample mail.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  DEFAULT_ORG_ID,
  type Conversation,
  type ConversationMessage,
} from "@/lib/types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CONSENT_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_COOKIE_NAME = "wai_gmail_tokens";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, seconds

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

export class GmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Gmail is not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.",
    );
    this.name = "GmailNotConfiguredError";
  }
}

export class GmailNotConnectedError extends Error {
  constructor() {
    super(
      "Gmail is not connected: no stored OAuth tokens. Use the Connect Gmail flow first.",
    );
    this.name = "GmailNotConnectedError";
  }
}

export class GmailApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
  }
}

export function gmailConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim(),
  );
}

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!v) throw new GmailNotConfiguredError();
  return v;
}

function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!v) throw new GmailNotConfiguredError();
  return v;
}

// ---------- Token cookie (AES-256-GCM) ----------

export interface GmailTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms when accessToken expires. */
  expiresAt?: number;
  email?: string;
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(clientSecret()).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function encryptTokens(tokens: GmailTokens): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [b64url(iv), b64url(tag), b64url(ct)].join(".");
}

export function decryptTokens(blob: string): GmailTokens | null {
  try {
    const [ivB, tagB, ctB] = blob.split(".");
    if (!ivB || !tagB || !ctB) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivB, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ctB, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plain) as GmailTokens;
    if (!parsed || typeof parsed.refreshToken !== "string") return null;
    return parsed;
  } catch {
    return null; // tampered, truncated, or secret rotated — treat as signed out
  }
}

function parseCookieHeader(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

/**
 * Read + decrypt the stored tokens. Accepts a raw Cookie header string or
 * a NextRequest (anything with .cookies.get or .headers.get).
 */
export function readGmailTokens(source: unknown): GmailTokens | null {
  let blob: string | undefined;
  if (typeof source === "string") {
    blob = parseCookieHeader(source, GMAIL_COOKIE_NAME);
  } else if (source && typeof source === "object") {
    const s = source as {
      cookies?: { get?: (n: string) => { value?: string } | undefined };
      headers?: { get?: (n: string) => string | null };
    };
    if (typeof s.cookies?.get === "function") {
      blob = s.cookies.get(GMAIL_COOKIE_NAME)?.value;
    } else if (typeof s.headers?.get === "function") {
      const header = s.headers.get("cookie");
      if (header) blob = parseCookieHeader(header, GMAIL_COOKIE_NAME);
    }
  }
  if (!blob) return null;
  return decryptTokens(blob);
}

function cookieAttrs(maxAge: number): string {
  const attrs = [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

/** Full Set-Cookie value persisting the given tokens. */
export function buildGmailCookie(tokens: GmailTokens): string {
  return `${GMAIL_COOKIE_NAME}=${encryptTokens(tokens)}; ${cookieAttrs(COOKIE_MAX_AGE)}`;
}

/** Full Set-Cookie value that clears the stored tokens. */
export function clearGmailCookie(): string {
  return `${GMAIL_COOKIE_NAME}=; ${cookieAttrs(0)}`;
}

// ---------- OAuth flow ----------

export function buildConsentUrl(redirectUri: string): string {
  const qs = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${CONSENT_URL}?${qs.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new GmailApiError(
      res.status,
      data.error_description ?? data.error ?? `Token endpoint error ${res.status}`,
    );
  }
  return data;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<GmailTokens> {
  const data = await postToken({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!data.access_token || !data.refresh_token) {
    throw new GmailApiError(
      502,
      "Google did not return an access + refresh token pair for the authorization code.",
    );
  }
  const accessToken = data.access_token;
  const tokens: GmailTokens = {
    refreshToken: data.refresh_token,
    accessToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  try {
    const profile = await getProfile(accessToken);
    tokens.email = profile.email;
  } catch {
    // Email is cosmetic (shown in the header pill); tokens are still valid.
  }
  return tokens;
}

export interface ValidAccessToken {
  accessToken: string;
  /** The token set to persist — updated when a refresh happened. */
  tokens: GmailTokens;
  refreshed: boolean;
}

export async function getValidAccessToken(
  tokens: GmailTokens,
): Promise<ValidAccessToken> {
  const stillValid =
    tokens.accessToken &&
    typeof tokens.expiresAt === "number" &&
    tokens.expiresAt > Date.now() + 60_000;
  if (stillValid) {
    return { accessToken: tokens.accessToken as string, tokens, refreshed: false };
  }
  if (!tokens.refreshToken) throw new GmailNotConnectedError();
  const data = await postToken({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: tokens.refreshToken,
    grant_type: "refresh_token",
  });
  if (!data.access_token) {
    throw new GmailApiError(502, "Google token refresh returned no access token.");
  }
  const updated: GmailTokens = {
    ...tokens,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return { accessToken: updated.accessToken as string, tokens: updated, refreshed: true };
}

// ---------- Gmail API ----------

async function gmailFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
      (parsed as { error?: { message?: string } } | undefined)?.error
        ?.message ?? `Gmail API error ${res.status}`;
    throw new GmailApiError(res.status, msg);
  }
  return parsed;
}

export interface GmailProfile {
  email?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export async function getProfile(
  accessToken: string,
): Promise<GmailProfile> {
  const data = (await gmailFetch(`/profile`, accessToken)) as {
    emailAddress?: string;
    messagesTotal?: number;
    threadsTotal?: number;
  };
  return {
    email: data.emailAddress,
    messagesTotal: data.messagesTotal,
    threadsTotal: data.threadsTotal,
  };
}

export interface GmailMessageStub {
  id: string;
  threadId: string;
}

export async function listMessages(
  accessToken: string,
  query: string,
  maxResults = 25,
): Promise<GmailMessageStub[]> {
  const qs = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });
  const data = (await gmailFetch(
    `/messages?${qs.toString()}`,
    accessToken,
  )) as { messages?: GmailMessageStub[] };
  return data.messages ?? [];
}

export async function getMessage(
  accessToken: string,
  id: string,
): Promise<ParsedGmailMessage> {
  const data = await gmailFetch(
    `/messages/${encodeURIComponent(id)}?format=full`,
    accessToken,
  );
  return parseGmailMessage(data);
}

export async function getThread(
  accessToken: string,
  threadId: string,
): Promise<ParsedGmailMessage[]> {
  const data = (await gmailFetch(
    `/threads/${encodeURIComponent(threadId)}?format=full`,
    accessToken,
  )) as { messages?: unknown[] };
  return (data.messages ?? [])
    .map((m) => parseGmailMessage(m))
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

export interface SendGmailInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  /** RFC 822 Message-ID of the message being replied to, when known. */
  inReplyTo?: string;
}

export async function sendMessage(
  accessToken: string,
  input: SendGmailInput,
): Promise<{ id?: string; threadId?: string }> {
  const headers = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    headers.push(`References: ${input.inReplyTo}`);
  }
  const raw = Buffer.from(
    headers.join("\r\n") + "\r\n\r\n" + input.body,
    "utf8",
  ).toString("base64url");
  const payload: Record<string, unknown> = { raw };
  if (input.threadId) payload.threadId = input.threadId;
  const data = (await gmailFetch(`/messages/send`, accessToken, {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { id?: string; threadId?: string };
  return { id: data.id, threadId: data.threadId };
}

// ---------- Parsing (pure — unit-tested) ----------

export interface ParsedGmailMessage {
  id: string;
  threadId: string;
  fromName?: string;
  fromEmail?: string;
  toEmail?: string;
  subject?: string;
  dateIso: string;
  direction: "inbound" | "outbound";
  snippet: string;
  bodyText: string;
  labelIds: string[];
}

type RawPart = {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: RawPart[];
};

type RawMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: RawPart;
};

function headerValue(
  headers: { name: string; value: string }[] | undefined,
  name: string,
): string | undefined {
  const hit = (headers ?? []).find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return hit?.value;
}

function parseAddress(value: string | undefined): {
  name?: string;
  email?: string;
} {
  if (!value) return {};
  const angled = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].replace(/^"|"$/g, "").trim();
    return { name: name || undefined, email: angled[2].trim() };
  }
  // Bare address, possibly the first of a list.
  const first = value.split(",")[0].trim();
  return first.includes("@") ? { email: first } : { name: first || undefined };
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectBodies(
  part: RawPart | undefined,
  out: { plain: string[]; html: string[] },
): void {
  if (!part) return;
  const data = part.body?.data;
  if (data) {
    if (part.mimeType === "text/plain") out.plain.push(decodeBase64Url(data));
    else if (part.mimeType === "text/html") out.html.push(decodeBase64Url(data));
  }
  for (const child of part.parts ?? []) collectBodies(child, out);
}

export function parseGmailMessage(raw: unknown): ParsedGmailMessage {
  const msg = (raw ?? {}) as RawMessage;
  const headers = msg.payload?.headers;
  const from = parseAddress(headerValue(headers, "From"));
  const to = parseAddress(headerValue(headers, "To"));
  const dateHeader = headerValue(headers, "Date");
  let dateIso: string | undefined;
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!Number.isNaN(d.getTime())) dateIso = d.toISOString();
  }
  if (!dateIso && msg.internalDate) {
    const ms = Number(msg.internalDate);
    if (Number.isFinite(ms)) dateIso = new Date(ms).toISOString();
  }
  dateIso = dateIso ?? new Date(0).toISOString();
  const bodies = { plain: [] as string[], html: [] as string[] };
  collectBodies(msg.payload, bodies);
  const bodyText =
    bodies.plain.length > 0
      ? bodies.plain.join("\n").trim()
      : bodies.html.length > 0
        ? stripHtml(bodies.html.join("\n"))
        : "";
  const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  return {
    id: String(msg.id ?? ""),
    threadId: String(msg.threadId ?? ""),
    fromName: from.name,
    fromEmail: from.email?.toLowerCase(),
    toEmail: to.email?.toLowerCase(),
    subject: headerValue(headers, "Subject"),
    dateIso,
    direction: labelIds.includes("SENT") ? "outbound" : "inbound",
    snippet: typeof msg.snippet === "string" ? msg.snippet : "",
    bodyText,
    labelIds,
  };
}

// ---------- Mapping into shared shapes ----------

export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

export function toConversationMessage(
  m: ParsedGmailMessage,
): ConversationMessage {
  return {
    id: m.id,
    direction: m.direction,
    body: m.bodyText,
    dateAdded: m.dateIso,
    type: "Email",
  };
}

/**
 * Group parsed messages into thread summaries for the inbox list. The
 * "other party" is the sender of the latest inbound message, or the
 * recipient of the latest outbound one.
 */
export function summarizeThreads(
  messages: ParsedGmailMessage[],
): Conversation[] {
  const byThread = new Map<string, ParsedGmailMessage[]>();
  for (const m of messages) {
    const list = byThread.get(m.threadId) ?? [];
    list.push(m);
    byThread.set(m.threadId, list);
  }
  const conversations: Conversation[] = [];
  for (const [threadId, list] of byThread) {
    const sorted = [...list].sort((a, b) =>
      a.dateIso.localeCompare(b.dateIso),
    );
    const latest = sorted[sorted.length - 1];
    const otherEmail =
      latest.direction === "outbound" ? latest.toEmail : latest.fromEmail;
    const otherName =
      latest.direction === "outbound" ? undefined : latest.fromName;
    conversations.push({
      id: threadId,
      organizationId: DEFAULT_ORG_ID,
      feed: "gmail",
      contactId: otherEmail ?? threadId,
      contactName: otherName ?? otherEmail,
      lastMessageBody: excerpt(latest.bodyText || latest.snippet),
      lastMessageDate: latest.dateIso,
      lastMessageDirection: latest.direction,
      unreadCount: sorted.filter(
        (m) => m.direction === "inbound" && m.labelIds.includes("UNREAD"),
      ).length,
    });
  }
  return conversations.sort((a, b) =>
    (b.lastMessageDate ?? "").localeCompare(a.lastMessageDate ?? ""),
  );
}

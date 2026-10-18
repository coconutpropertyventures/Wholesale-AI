// Shared contracts across Wholesale AI modules. Multi-tenant from day one:
// every record carries organizationId; milestone 1 runs a single default org.
export const DEFAULT_ORG_ID = "coconut-property-ventures";

export type Feed = "ghl" | "gmail" | "voice";

export interface Contact {
  id: string;
  organizationId: string;
  feed: Feed;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
  email?: string;
  dnd?: boolean;          // do-not-disturb / opted out — never message
  tags?: string[];
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  dateAdded: string;
  type: string;           // SMS, Email, Voice, ...
}

export interface Conversation {
  id: string;
  organizationId: string;
  feed: Feed;
  contactId: string;
  contactName?: string;
  subject?: string;       // email threads (Gmail feed)
  lastMessageBody?: string;
  lastMessageDate?: string;
  lastMessageDirection?: string;
  unreadCount?: number;
  messages?: ConversationMessage[];
}

export type DraftStatus = "draft" | "approved" | "sent" | "rejected";

export interface Draft {
  id: string;
  organizationId: string;
  feed: Feed;
  contactId?: string;
  to: string;             // phone or email
  subject?: string;       // email drafts (Gmail feed)
  threadRef?: string;     // provider thread id the reply belongs to (Gmail feed)
  body: string;
  status: DraftStatus;
  createdAt: string;
  approvedAt?: string;
  sentAt?: string;
  externalId?: string;    // provider message id after a confirmed send
}

export interface AuditEntry {
  id: string;
  organizationId: string;
  at: string;
  actor: string;          // "bradley" | "system" | "ai"
  action: string;         // e.g. draft.created, draft.approved, message.sent, send.blocked_suppression
  detail: Record<string, unknown>;
}

export interface Suppression {
  organizationId: string;
  value: string;          // phone or email suppressed
  reason: string;         // STOP, DND, manual
  at: string;
}

/**
 * One row per realtor-message draft created from the Deal workbench.
 * This is the seed data for the closed-deal learning loop: when a draft's
 * address later matches an opportunity that reached DEALS ASSIGNED /
 * Closed, the pattern counts as one that worked. No outcome is inferred
 * beyond that address match — see lib/learning.ts.
 */
export interface MessageOutcome {
  id: string;
  organizationId: string;
  draftId: string;
  address: string;
  mode: string;                 // turnkey | traditional | land | flip
  variant: "first" | "offer";
  body: string;
  offerAmount?: number;
  contactId?: string;
  createdAt: string;
}

/** One AI model call, logged for cost control (see lib/ai/draft.ts). */
export interface AiUsageEntry {
  id: string;
  organizationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;         // cache-read input tokens (billed cheap)
  purpose: string;              // e.g. "draft-offer"
  createdAt: string;
}

// ---------- Blast (paced bulk outreach to listing agents) ----------

export type BlastSource = "search" | "stage";
export type BlastScriptKey = "turnkey_opener" | "distressed_opener";
export type BlastRunStatus =
  | "draft"
  | "approved"
  | "sending"
  | "paused"
  | "stopped"
  | "complete";

/**
 * Item lifecycle: build-time exclusions land in a skipped_* status with
 * the reason in `error`; only "queued" items can ever send. A confirmed
 * send is "sent"; a send-time DND/suppression skip is "skipped_dnd";
 * any other send failure is "failed" and pauses the run (fail-stop).
 */
export type BlastItemStatus =
  | "queued"
  | "sending"
  | "sent"
  | "skipped_dnd"
  | "skipped_suppressed"
  | "skipped_recent"
  | "skipped_active"
  | "missing_phone"
  | "failed";

export interface BlastRun {
  id: string;
  organizationId: string;
  source: BlastSource;
  /** Pipeline stage the queue was built from (source "stage" only). */
  stageRef?: { pipelineId: string; stageId: string };
  scriptKey: BlastScriptKey;
  status: BlastRunStatus;
  dailyCap: number;
  lastSentAt?: string;
  currentGroupStartedAt?: string;
  groupSentCount: number;
  /** Last notable event for the UI (e.g. "daily cap reached", fail-stop error). */
  note?: string;
  createdAt: string;
  startedAt?: string;
}

export interface BlastItem {
  id: string;
  organizationId: string;
  runId: string;
  /** Absent only for search-source items whose agent phone never resolved. */
  contactId?: string;
  contactName?: string;
  firstName?: string;
  opportunityId?: string;
  street: string;
  phone?: string;
  status: BlastItemStatus;
  ghlMessageId?: string;
  /** Exclusion reason, skip detail, or send error — human-readable. */
  error?: string;
  sentAt?: string;
  createdAt: string;
}

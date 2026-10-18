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

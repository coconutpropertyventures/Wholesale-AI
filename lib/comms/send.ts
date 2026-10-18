// THE ONLY SEND PATH in Wholesale AI.
// Nothing in the app sends an external message except sendApprovedDraft().
// Gates, in order: draft exists -> status is "approved" -> recipient not
// suppressed -> contact not DND -> provider configured -> provider send.
// Every outcome (sent or blocked) is written to the audit log.
import {
  getContact,
  ghlConfigured,
  sendSms,
} from "@/lib/ghl/client";
import {
  getValidAccessToken,
  gmailConfigured,
  sendMessage as sendGmailMessage,
  type GmailTokens,
} from "@/lib/gmail/client";
import {
  addAudit,
  addSuppression,
  getDraft,
  isSuppressed,
  updateDraft,
} from "@/lib/store/store";

export interface SendResult {
  ok: boolean;
  draftId: string;
  /** Machine-readable outcome, e.g. "sent", "blocked_not_approved". */
  outcome: string;
  error?: string;
  externalId?: string;
}

async function blocked(
  draftId: string,
  actor: string,
  outcome: string,
  action: string,
  detail: Record<string, unknown>,
  error: string,
): Promise<SendResult> {
  await addAudit(actor, action, { draftId, ...detail });
  return { ok: false, draftId, outcome, error };
}

export async function sendApprovedDraft(
  draftId: string,
  actor: string,
  gmailTokens?: GmailTokens | null,
): Promise<SendResult> {
  const draft = await getDraft(draftId);
  if (!draft) {
    await addAudit(actor, "send.blocked_draft_not_found", { draftId });
    return {
      ok: false,
      draftId,
      outcome: "blocked_draft_not_found",
      error: `Draft ${draftId} not found.`,
    };
  }

  if (draft.status !== "approved") {
    return blocked(
      draftId,
      actor,
      "blocked_not_approved",
      "send.blocked_not_approved",
      { status: draft.status },
      `Draft status is "${draft.status}"; only "approved" drafts can be sent. Nothing was sent.`,
    );
  }

  if (await isSuppressed(draft.to)) {
    return blocked(
      draftId,
      actor,
      "blocked_suppression",
      "send.blocked_suppression",
      { to: draft.to, feed: draft.feed },
      `Recipient ${draft.to} is on the suppression list. Nothing was sent.`,
    );
  }

  // Google Voice has no official API — still unimplemented. Refuse
  // explicitly; never pretend a message went out on a channel we cannot use.
  if (draft.feed === "voice") {
    return blocked(
      draftId,
      actor,
      "blocked_feed_not_implemented",
      "send.blocked_feed_not_implemented",
      { feed: draft.feed, to: draft.to },
      `The "${draft.feed}" feed is not implemented yet (later milestone). Nothing was sent.`,
    );
  }

  // --- Gmail feed (user's own Google OAuth client; tokens come from the
  // encrypted cookie the send route read off the request) ---
  if (draft.feed === "gmail") {
    if (!gmailConfigured()) {
      return blocked(
        draftId,
        actor,
        "blocked_not_configured",
        "send.blocked_not_configured",
        { feed: draft.feed, to: draft.to },
        "Gmail is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing). Nothing was sent.",
      );
    }
    if (!gmailTokens?.refreshToken) {
      return blocked(
        draftId,
        actor,
        "blocked_gmail_not_connected",
        "send.blocked_gmail_not_connected",
        { feed: draft.feed, to: draft.to },
        "Gmail is not connected in this browser session (no OAuth tokens). Connect Gmail first. Nothing was sent.",
      );
    }
    try {
      const { accessToken } = await getValidAccessToken(gmailTokens);
      const result = await sendGmailMessage(accessToken, {
        to: draft.to,
        subject: draft.subject ?? "(no subject)",
        body: draft.body,
        threadId: draft.threadRef,
      });
      const sentAt = new Date().toISOString();
      await updateDraft(draftId, {
        status: "sent",
        sentAt,
        externalId: result.id,
      });
      await addAudit(actor, "message.sent", {
        draftId,
        feed: draft.feed,
        to: draft.to,
        subject: draft.subject ?? null,
        threadRef: draft.threadRef ?? null,
        externalId: result.id ?? null,
      });
      return { ok: true, draftId, outcome: "sent", externalId: result.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await addAudit(actor, "send.failed", {
        draftId,
        feed: draft.feed,
        to: draft.to,
        error: message,
      });
      return {
        ok: false,
        draftId,
        outcome: "send_failed",
        error: `Gmail send failed: ${message}`,
      };
    }
  }

  // --- GHL feed ---
  if (!ghlConfigured()) {
    return blocked(
      draftId,
      actor,
      "blocked_not_configured",
      "send.blocked_not_configured",
      { feed: draft.feed, to: draft.to },
      "GoHighLevel is not configured (GHL_PRIVATE_TOKEN missing). Nothing was sent.",
    );
  }

  if (!draft.contactId) {
    return blocked(
      draftId,
      actor,
      "blocked_missing_contact",
      "send.blocked_missing_contact",
      { to: draft.to },
      "Draft has no GHL contactId; cannot send or verify DND status. Nothing was sent.",
    );
  }

  // Re-check DND against the live contact before sending — a contact can
  // opt out after the draft was approved.
  try {
    const contact = await getContact(draft.contactId);
    if (contact.dnd) {
      await addSuppression(draft.to, "DND");
      return blocked(
        draftId,
        actor,
        "blocked_dnd",
        "send.blocked_dnd",
        { contactId: draft.contactId, to: draft.to },
        "Contact is marked DND in GoHighLevel. Nothing was sent.",
      );
    }
  } catch (err) {
    return blocked(
      draftId,
      actor,
      "blocked_dnd_check_failed",
      "send.blocked_dnd_check_failed",
      {
        contactId: draft.contactId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Could not verify the contact's DND status in GoHighLevel; refusing to send.",
    );
  }

  try {
    const result = await sendSms(draft.contactId, draft.body);
    const sentAt = new Date().toISOString();
    await updateDraft(draftId, {
      status: "sent",
      sentAt,
      externalId: result.messageId,
    });
    await addAudit(actor, "message.sent", {
      draftId,
      feed: draft.feed,
      contactId: draft.contactId,
      to: draft.to,
      externalId: result.messageId ?? null,
      conversationId: result.conversationId ?? null,
    });
    return {
      ok: true,
      draftId,
      outcome: "sent",
      externalId: result.messageId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addAudit(actor, "send.failed", {
      draftId,
      feed: draft.feed,
      contactId: draft.contactId,
      to: draft.to,
      error: message,
    });
    return {
      ok: false,
      draftId,
      outcome: "send_failed",
      error: `GoHighLevel send failed: ${message}`,
    };
  }
}

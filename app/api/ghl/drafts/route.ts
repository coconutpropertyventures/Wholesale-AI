import { NextResponse, type NextRequest } from "next/server";
import {
  addAudit,
  createDraft,
  getDraft,
  getDrafts,
  updateDraft,
} from "@/lib/store/store";
import { getContact } from "@/lib/ghl/client";
import { resolveDraftForContact } from "@/lib/comms/draft";
import type { Feed } from "@/lib/types";

export const dynamic = "force-dynamic";

const FEEDS: Feed[] = ["ghl", "gmail", "voice"];

// GET /api/ghl/drafts -> { drafts }
// (Route name kept under /api/ghl per the app layout; drafts cover all feeds.)
export async function GET() {
  return NextResponse.json({ drafts: getDrafts() });
}

// POST /api/ghl/drafts
//   { feed, contactId?, to?, body, subject?, threadRef?, actor? }
// Creates a draft with status "draft". Creating a draft NEVER sends anything.
//
// `to` is required EXCEPT for feed="ghl" with a contactId: then the server
// resolves the recipient from the live HighLevel contact (phone, else
// email, else name, else the id) and replaces "{first}" in the body with
// the contact's first name. If the contact cannot be resolved, the request
// fails with 502 — a draft is never created with a guessed recipient.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const { feed, contactId, to, body: text } = body;
  if (
    typeof feed !== "string" ||
    !FEEDS.includes(feed as Feed) ||
    typeof text !== "string" ||
    text.trim().length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "feed (ghl|gmail|voice) and a non-empty body are required; to is required unless feed is ghl with a contactId.",
      },
      { status: 400 },
    );
  }
  const contactIdStr =
    typeof contactId === "string" && contactId.length > 0
      ? contactId
      : undefined;
  let resolvedTo = typeof to === "string" ? to.trim() : "";
  let resolvedBody = text;
  if (resolvedTo.length === 0) {
    if (feed !== "ghl" || !contactIdStr) {
      return NextResponse.json(
        {
          error:
            "to is required unless feed is ghl with a contactId to resolve it from.",
        },
        { status: 400 },
      );
    }
    try {
      const contact = await getContact(contactIdStr);
      const resolved = resolveDraftForContact(contact, text);
      resolvedTo = resolved.to;
      resolvedBody = resolved.body;
    } catch (err) {
      return NextResponse.json(
        {
          error: `Could not resolve contact ${contactIdStr} in HighLevel: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
        { status: 502 },
      );
    }
  }
  const actor = typeof body.actor === "string" ? body.actor : "bradley";
  const draft = createDraft({
    feed: feed as Feed,
    contactId: contactIdStr,
    to: resolvedTo,
    subject: typeof body.subject === "string" ? body.subject : undefined,
    threadRef:
      typeof body.threadRef === "string" ? body.threadRef : undefined,
    body: resolvedBody,
  });
  addAudit(actor, "draft.created", {
    draftId: draft.id,
    feed: draft.feed,
    contactId: draft.contactId ?? null,
    to: draft.to,
  });
  return NextResponse.json({ draft }, { status: 201 });
}

// PATCH /api/ghl/drafts  { id, action: "approve" | "reject", actor? }
// Approval is a separate, deliberate step from creation — and from sending
// (sending happens only via POST /api/ghl/send).
export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const { id } = body;
  // Two client spellings exist: { action: "approve" | "reject" } and
  // { status: "approved" | "rejected" } (the DraftsPanel wording). Accept
  // both; they mean the same deliberate step.
  const action =
    body.action === "approve" || body.status === "approved"
      ? "approve"
      : body.action === "reject" || body.status === "rejected"
        ? "reject"
        : undefined;
  if (typeof id !== "string" || !action) {
    return NextResponse.json(
      { error: 'id and action ("approve" | "reject") are required.' },
      { status: 400 },
    );
  }
  const existing = getDraft(id);
  if (!existing) {
    return NextResponse.json(
      { error: `Draft ${id} not found.` },
      { status: 404 },
    );
  }
  const actor = typeof body.actor === "string" ? body.actor : "bradley";
  const updated =
    action === "approve"
      ? updateDraft(id, {
          status: "approved",
          approvedAt: new Date().toISOString(),
        })
      : updateDraft(id, { status: "rejected" });
  addAudit(actor, action === "approve" ? "draft.approved" : "draft.rejected", {
    draftId: id,
    feed: existing.feed,
    to: existing.to,
  });
  return NextResponse.json({ draft: updated });
}

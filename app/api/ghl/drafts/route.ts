import { NextResponse, type NextRequest } from "next/server";
import {
  addAudit,
  createDraft,
  getDraft,
  getDrafts,
  updateDraft,
} from "@/lib/store/store";
import type { Feed } from "@/lib/types";

export const dynamic = "force-dynamic";

const FEEDS: Feed[] = ["ghl", "gmail", "voice"];

// GET /api/ghl/drafts -> { drafts }
// (Route name kept under /api/ghl per the app layout; drafts cover all feeds.)
export async function GET() {
  return NextResponse.json({ drafts: getDrafts() });
}

// POST /api/ghl/drafts  { feed, contactId?, to, body, actor? }
// Creates a draft with status "draft". Creating a draft NEVER sends anything.
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
    typeof to !== "string" ||
    to.trim().length === 0 ||
    typeof text !== "string" ||
    text.trim().length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "feed (ghl|gmail|voice), to, and a non-empty body are required.",
      },
      { status: 400 },
    );
  }
  const actor = typeof body.actor === "string" ? body.actor : "bradley";
  const draft = createDraft({
    feed: feed as Feed,
    contactId: typeof contactId === "string" ? contactId : undefined,
    to,
    body: text,
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
  const { id, action } = body;
  if (
    typeof id !== "string" ||
    (action !== "approve" && action !== "reject")
  ) {
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

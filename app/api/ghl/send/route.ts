import { NextResponse, type NextRequest } from "next/server";
import { sendApprovedDraft } from "@/lib/comms/send";
import { readGmailTokens } from "@/lib/gmail/client";

export const dynamic = "force-dynamic";

// POST /api/ghl/send  { draftId, actor? }
// The only HTTP entry point that can send a message, and it delegates to
// sendApprovedDraft() — which refuses anything not explicitly approved.
// For Gmail drafts, the caller's OAuth tokens are read from the encrypted
// session cookie and handed to the send path; without them the send is
// blocked as gmail_not_connected.
export async function POST(req: NextRequest) {
  let body: { draftId?: unknown; actor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON with a draftId." },
      { status: 400 },
    );
  }
  if (typeof body.draftId !== "string" || body.draftId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "draftId is required." },
      { status: 400 },
    );
  }
  const actor = typeof body.actor === "string" ? body.actor : "bradley";
  const gmailTokens = readGmailTokens(req);
  const result = await sendApprovedDraft(body.draftId, actor, gmailTokens);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}

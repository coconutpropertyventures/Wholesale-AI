import { NextResponse, type NextRequest } from "next/server";
import { sendApprovedDraft } from "@/lib/comms/send";

export const dynamic = "force-dynamic";

// POST /api/ghl/send  { draftId, actor? }
// The only HTTP entry point that can send a message, and it delegates to
// sendApprovedDraft() — which refuses anything not explicitly approved.
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
  const result = await sendApprovedDraft(body.draftId, actor);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}

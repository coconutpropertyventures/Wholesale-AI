import { NextResponse, type NextRequest } from "next/server";
import {
  createMessageOutcome,
  listMessageOutcomes,
} from "@/lib/store/store";
import {
  ghlConfigured,
  ghlLocationId,
  listOpenOpportunities,
} from "@/lib/ghl/client";
import { assignedUsesByDraftId } from "@/lib/learning";

export const dynamic = "force-dynamic";

// POST /api/outcomes  { draftId, address, mode, variant, body, offerAmount?, contactId? }
// Logs one workbench-created draft into wai_message_outcomes — the seed
// data for the closed-deal learning loop. Logging only; sends nothing.
// GET /api/outcomes -> { outcomes, assignedUses }
// assignedUses[draftId] = how many assigned/closed deals the draft's
// (variant + mode) pattern is tied to (0/absent = no label shown).
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
  const { draftId, address, mode, variant, body: text } = body;
  if (
    typeof draftId !== "string" ||
    typeof address !== "string" ||
    typeof mode !== "string" ||
    (variant !== "first" && variant !== "offer") ||
    typeof text !== "string" ||
    text.trim().length === 0
  ) {
    return NextResponse.json(
      {
        error:
          "draftId, address, mode, variant (first|offer) and a non-empty body are required.",
      },
      { status: 400 },
    );
  }
  const outcome = await createMessageOutcome({
    draftId,
    address,
    mode,
    variant,
    body: text,
    offerAmount:
      typeof body.offerAmount === "number" ? body.offerAmount : undefined,
    contactId:
      typeof body.contactId === "string" ? body.contactId : undefined,
  });
  return NextResponse.json({ outcome }, { status: 201 });
}

export async function GET() {
  const outcomes = await listMessageOutcomes();
  let assignedUses: Record<string, number> = {};
  if (ghlConfigured() && ghlLocationId()) {
    try {
      const opps = await listOpenOpportunities(ghlLocationId() as string);
      assignedUses = assignedUsesByDraftId(outcomes, opps);
    } catch {
      assignedUses = {}; // no labels rather than wrong labels
    }
  }
  return NextResponse.json({ outcomes, assignedUses });
}

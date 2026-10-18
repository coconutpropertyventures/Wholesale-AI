import { NextResponse, type NextRequest } from "next/server";
import {
  addAudit,
  createDraft,
  createMessageOutcome,
  getDrafts,
  listMessageOutcomes,
} from "@/lib/store/store";
import {
  getContact,
  ghlConfigured,
  ghlLocationId,
  listOpenOpportunities,
} from "@/lib/ghl/client";
import { resolveDraftForContact } from "@/lib/comms/draft";
import { rejectedExample, winningExamples } from "@/lib/learning";
import { draftOfferWithModel } from "@/lib/ai/draft";

export const dynamic = "force-dynamic";

// POST /api/ai/draft-offer
//   { address, street, first, offer, mode, fee, to?, contactId?,
//     threadSummary?, escalate? }
// Model-personalized OFFER message (openers stay pure templates). On
// success this creates the Draft record + wai_message_outcomes row
// exactly like the template path in the workbench — it NEVER sends.
// Expected non-success states return 200 with the helper's result so the
// UI can fall back to the plain template honestly:
//   { ok: false, configured: false }               -> no ANTHROPIC_API_KEY
//   { ok: false, configured: true, reason: "budget" | "api_error", ... }
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
  const { address, street, first, mode } = body;
  const offer = body.offer;
  const fee = typeof body.fee === "number" ? body.fee : undefined;
  if (
    typeof address !== "string" ||
    address.trim().length === 0 ||
    typeof street !== "string" ||
    street.trim().length === 0 ||
    typeof first !== "string" ||
    first.trim().length === 0 ||
    typeof mode !== "string" ||
    typeof offer !== "number" ||
    !Number.isFinite(offer) ||
    offer <= 0
  ) {
    return NextResponse.json(
      {
        error:
          "address, street, first, mode and a positive numeric offer are required.",
      },
      { status: 400 },
    );
  }

  // Recipient resolution mirrors POST /api/ghl/drafts: explicit `to`, or a
  // contactId resolved from the live HighLevel contact (never a guess).
  const contactId =
    typeof body.contactId === "string" && body.contactId.length > 0
      ? body.contactId
      : undefined;
  let to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to) {
    if (!contactId) {
      return NextResponse.json(
        { error: "to is required unless a contactId is given to resolve it from." },
        { status: 400 },
      );
    }
    try {
      const contact = await getContact(contactId);
      to = resolveDraftForContact(contact, "").to;
    } catch (err) {
      return NextResponse.json(
        {
          error: `Could not resolve contact ${contactId} in HighLevel: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
        { status: 502 },
      );
    }
  }

  // Learning hook: winning patterns for the offer variant + one rejected
  // example, when the data exists. Failures here only lose the examples.
  let examples: Awaited<ReturnType<typeof winningExamples>> = [];
  let avoidExample: ReturnType<typeof rejectedExample> = null;
  try {
    const outcomes = await listMessageOutcomes();
    if (ghlConfigured() && ghlLocationId()) {
      const opps = await listOpenOpportunities(ghlLocationId() as string);
      examples = winningExamples(outcomes, opps, "offer", 3);
    }
    avoidExample = rejectedExample(outcomes, await getDrafts(), "offer");
  } catch {
    examples = [];
    avoidExample = null;
  }

  const result = await draftOfferWithModel({
    first: first.trim(),
    street: street.trim(),
    address: address.trim(),
    offerFormatted: `$${Math.round(offer).toLocaleString("en-US")}`,
    mode,
    fee,
    threadSummary:
      typeof body.threadSummary === "string" ? body.threadSummary : undefined,
    examples,
    avoidExample,
    escalate: body.escalate === true,
  });

  if (!result.ok) {
    return NextResponse.json(result);
  }

  const draft = await createDraft({
    feed: "ghl",
    contactId,
    to,
    body: result.text,
  });
  await createMessageOutcome({
    draftId: draft.id,
    address: address.trim(),
    mode,
    variant: "offer",
    body: result.text,
    offerAmount: offer,
    contactId,
  });
  await addAudit("ai", "ai.draft_offer_created", {
    draftId: draft.id,
    model: result.model,
    escalated: result.escalated,
    estCostUsd: result.usage.estCostUsd,
    examplesUsed: examples.length,
  });
  return NextResponse.json({ ...result, draft }, { status: 201 });
}

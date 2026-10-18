import { NextResponse, type NextRequest } from "next/server";
import {
  getContact,
  getConversationMessages,
  ghlConfigured,
  ghlLocationId,
  listOpenOpportunities,
} from "@/lib/ghl/client";
import { buildPipelineMap, shortStageName } from "@/lib/ghl/pipelineMap";
import {
  getThread,
  getValidAccessToken,
  readGmailTokens,
  toConversationMessage,
} from "@/lib/gmail/client";
import { sortMessagesAscending } from "@/lib/messages";
import { aiDraftConfigured, draftReplyWithModel } from "@/lib/ai/draft";
import type { ConversationMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST /api/ai/draft-reply  { feed, conversationId, contactId?, note? }
//   -> { ok: true, configured: true, text, model, modelTier, reason }
//   -> { ok: false, configured: false } when no ANTHROPIC_API_KEY is set
//   -> { ok: false, configured: true, error } on any other failure
//
// Backs the inbox's per-thread "Draft with AI" button. The server
// assembles the context itself — the thread's recent messages, the
// contact's pipeline entries (stage names + deal flag), and the
// opportunity's name/value when known — then lib/ai/draft.ts drafts a
// reply in Bradley's voice with the context-dependent model from
// lib/ai/modelSelect.ts (Haiku for routine pre-deal comms, Sonnet for
// deals/contracts/$$). The draft is returned for the composer only;
// this route never sends and never creates a Draft record.
//
// Reply drafting has NO template fallback: without an Anthropic key
// the response is { configured: false } and the UI says so plainly.

interface DraftReplyBody {
  feed?: unknown;
  conversationId?: unknown;
  contactId?: unknown;
  note?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export async function POST(req: NextRequest) {
  let body: DraftReplyBody;
  try {
    body = (await req.json()) as DraftReplyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const feed = asString(body.feed);
  const conversationId = asString(body.conversationId);
  const contactId = asString(body.contactId);
  const note = asString(body.note);
  if ((feed !== "ghl" && feed !== "gmail") || !conversationId) {
    return NextResponse.json(
      { error: "feed ('ghl' | 'gmail') and conversationId are required." },
      { status: 400 },
    );
  }

  if (!aiDraftConfigured()) {
    return NextResponse.json({ ok: false, configured: false });
  }

  // ----- Thread messages -------------------------------------------------
  let messages: ConversationMessage[];
  try {
    if (feed === "ghl") {
      if (!ghlConfigured()) {
        return NextResponse.json({
          ok: false,
          configured: true,
          error:
            "HighLevel is not configured on the server, so the thread can't be read.",
        });
      }
      messages = await getConversationMessages(conversationId);
    } else {
      const tokens = readGmailTokens(req);
      if (!tokens?.refreshToken) {
        return NextResponse.json({
          ok: false,
          configured: true,
          error:
            "Gmail is not connected in this browser session — connect Gmail first.",
        });
      }
      const { accessToken } = await getValidAccessToken(tokens);
      const raw = await getThread(accessToken, conversationId);
      messages = sortMessagesAscending(raw.map(toConversationMessage));
    }
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
  if (messages.length === 0) {
    return NextResponse.json({
      ok: false,
      configured: true,
      error: "This thread has no messages to draft a reply to yet.",
    });
  }

  // ----- Pipeline / deal context (GHL contacts; best-effort) -------------
  let contactName: string | undefined;
  let stageLabels: string[] = [];
  let stageIds: string[] = [];
  let isDeal = false;
  let opportunityName: string | undefined;
  let monetaryValue: number | undefined;
  if (feed === "ghl" && contactId && ghlConfigured()) {
    const locationId = ghlLocationId();
    if (locationId) {
      try {
        const opps = await listOpenOpportunities(locationId);
        const entries = buildPipelineMap(opps)[contactId] ?? [];
        stageIds = entries.map((e) => e.stageId);
        isDeal = entries.some((e) => e.isDeal);
        stageLabels = entries.map(
          (e) => `${e.pipelineName} · ${shortStageName(e.stageName)}`,
        );
        const primary = entries[0];
        opportunityName = primary?.opportunityName;
        const match =
          opps.find(
            (o) => o.contactId === contactId && o.name === primary?.opportunityName,
          ) ?? opps.find((o) => o.contactId === contactId && o.monetaryValue);
        monetaryValue = match?.monetaryValue;
      } catch {
        // Context is best-effort — draft from the thread alone.
      }
    }
    try {
      const contact = await getContact(contactId);
      contactName = contact.name;
    } catch {
      // Same: best-effort.
    }
  }

  const result = await draftReplyWithModel({
    contactName,
    messages: messages.map((m) => ({ direction: m.direction, body: m.body })),
    stageLabels,
    opportunityName,
    monetaryValue,
    note,
    isDeal,
    stageIds,
  });

  if (!result.ok) {
    if (!result.configured) {
      return NextResponse.json({ ok: false, configured: false });
    }
    if (result.reason === "budget") {
      return NextResponse.json({
        ok: false,
        configured: true,
        error: `AI drafting is paused — this month's AI spend ($${result.spentUsd.toFixed(2)}) has hit the $${result.budgetUsd} budget.`,
      });
    }
    return NextResponse.json({
      ok: false,
      configured: true,
      error: result.error,
    });
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    text: result.text,
    model: result.model,
    modelTier: result.modelTier,
    reason: result.reason,
  });
}

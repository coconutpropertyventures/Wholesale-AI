import { NextResponse, type NextRequest } from "next/server";
import {
  getConversationMessages,
  ghlConfigured,
  ghlLocationId,
  searchConversations,
} from "@/lib/ghl/client";

export const dynamic = "force-dynamic";

// GET /api/ghl/conversations
//   -> { configured, conversations }
// GET /api/ghl/conversations?conversationId=<id>
//   -> { configured, conversationId, messages }
// With no GHL token configured, lists are empty and configured is false.
export async function GET(req: NextRequest) {
  const configured = ghlConfigured();
  if (!configured) {
    return NextResponse.json({
      configured: false,
      conversations: [],
      messages: [],
    });
  }

  const conversationId = req.nextUrl.searchParams.get("conversationId");
  try {
    if (conversationId) {
      const messages = await getConversationMessages(conversationId);
      return NextResponse.json({ configured: true, conversationId, messages });
    }
    const locationId = ghlLocationId();
    if (!locationId) {
      return NextResponse.json({
        configured: true,
        conversations: [],
        error: "GHL_LOCATION_ID is not set.",
      });
    }
    const conversations = await searchConversations(locationId);
    return NextResponse.json({ configured: true, conversations });
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        conversations: [],
        messages: [],
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

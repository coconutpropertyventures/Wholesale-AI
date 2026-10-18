import { NextResponse, type NextRequest } from "next/server";
import {
  buildGmailCookie,
  getMessage,
  getThread,
  getValidAccessToken,
  gmailConfigured,
  listMessages,
  readGmailTokens,
  summarizeThreads,
  toConversationMessage,
  type GmailTokens,
} from "@/lib/gmail/client";
import { DEFAULT_ORG_ID, type Conversation } from "@/lib/types";
import { sortMessagesAscending } from "@/lib/messages";

export const dynamic = "force-dynamic";

// GET /api/gmail/messages
//   -> { configured, connected, conversations } — recent mail grouped by
//      thread, newest first.
// GET /api/gmail/messages?threadId=<id>
//   -> { configured, connected, conversation, messages, subject }
//      with messages in chat order (oldest → newest).
// Without client credentials or stored tokens this returns an explicit
// not-configured / not-connected state with an empty list — never sample mail.

const LIST_QUERY = "-in:spam -in:trash";
const LIST_MAX = 25;

interface ReadyTokens {
  accessToken: string;
  refreshedCookie?: string;
}

async function readyTokens(
  req: NextRequest,
): Promise<ReadyTokens | { error: string; status: number }> {
  const tokens: GmailTokens | null = readGmailTokens(req);
  if (!tokens?.refreshToken) {
    return { error: "Gmail is not connected.", status: 401 };
  }
  try {
    const valid = await getValidAccessToken(tokens);
    return {
      accessToken: valid.accessToken,
      refreshedCookie: valid.refreshed
        ? buildGmailCookie(valid.tokens)
        : undefined,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      status: 502,
    };
  }
}

function withCookie<T extends NextResponse>(
  res: T,
  cookie: string | undefined,
): T {
  if (cookie) res.headers.append("Set-Cookie", cookie);
  return res;
}

export async function GET(req: NextRequest) {
  const configured = gmailConfigured();
  if (!configured) {
    return NextResponse.json({
      configured: false,
      connected: false,
      conversations: [],
    });
  }
  const tokens: GmailTokens | null = readGmailTokens(req);
  if (!tokens?.refreshToken) {
    return NextResponse.json({
      configured: true,
      connected: false,
      conversations: [],
    });
  }
  const ready = await readyTokens(req);
  if ("error" in ready) {
    return NextResponse.json(
      {
        configured: true,
        connected: true,
        conversations: [],
        error: ready.error,
      },
      { status: ready.status },
    );
  }
  const threadId = req.nextUrl.searchParams.get("threadId");
  try {
    if (threadId) {
      const messages = await getThread(ready.accessToken, threadId);
      const summaries = summarizeThreads(messages);
      const conversation: Conversation = summaries[0] ?? {
        id: threadId,
        organizationId: DEFAULT_ORG_ID,
        feed: "gmail",
        contactId: threadId,
      };
      const subject =
        messages.find((m) => m.subject)?.subject ?? undefined;
      return withCookie(
        NextResponse.json({
          configured: true,
          connected: true,
          conversation,
          // Chat order (oldest → newest), same contract as the GHL
          // messages route — getThread already sorts ascending, and
          // this keeps the guarantee explicit at the API boundary.
          messages: sortMessagesAscending(messages.map(toConversationMessage)),
          subject: subject ?? null,
        }),
        ready.refreshedCookie,
      );
    }
    const stubs = await listMessages(ready.accessToken, LIST_QUERY, LIST_MAX);
    const full = await Promise.all(
      stubs.map((s) => getMessage(ready.accessToken, s.id)),
    );
    return withCookie(
      NextResponse.json({
        configured: true,
        connected: true,
        conversations: summarizeThreads(full),
      }),
      ready.refreshedCookie,
    );
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        connected: true,
        conversations: [],
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

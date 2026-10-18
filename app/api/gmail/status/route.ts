import { NextResponse, type NextRequest } from "next/server";
import { gmailConfigured, readGmailTokens } from "@/lib/gmail/client";

export const dynamic = "force-dynamic";

// GET /api/gmail/status -> { configured, connected, email? }
// configured = the server has the user's Google client credentials;
// connected = this browser session carries stored OAuth tokens.
export async function GET(req: NextRequest) {
  const configured = gmailConfigured();
  const tokens = configured ? readGmailTokens(req) : null;
  const connected = Boolean(tokens?.refreshToken);
  return NextResponse.json({
    configured,
    connected,
    ...(connected && tokens?.email ? { email: tokens.email } : {}),
  });
}

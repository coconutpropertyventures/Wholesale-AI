import { NextResponse, type NextRequest } from "next/server";
import { buildConsentUrl, gmailConfigured } from "@/lib/gmail/client";

export const dynamic = "force-dynamic";

// GET /api/gmail/connect — start the Google OAuth flow with the user's own
// Google Cloud client. Without client credentials in env there is nothing
// to connect to: bounce back with an honest flag instead of a broken page.
export async function GET(req: NextRequest) {
  if (!gmailConfigured()) {
    return NextResponse.redirect(new URL("/?gmail=not_configured", req.url));
  }
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${req.nextUrl.origin}/api/gmail/callback`;
  return NextResponse.redirect(buildConsentUrl(redirectUri));
}

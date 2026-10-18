import { NextResponse, type NextRequest } from "next/server";
import {
  buildGmailCookie,
  exchangeCode,
  gmailConfigured,
} from "@/lib/gmail/client";

export const dynamic = "force-dynamic";

// GET /api/gmail/callback?code=... — finish the OAuth flow: exchange the
// code, store the tokens in the encrypted httpOnly cookie, and return to
// the dashboard with the Gmail tab flagged open. Any failure lands back on
// the dashboard with ?gmail=error rather than an error page.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!gmailConfigured() || !code) {
    return NextResponse.redirect(new URL("/?gmail=error", req.url));
  }
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${req.nextUrl.origin}/api/gmail/callback`;
  try {
    const tokens = await exchangeCode(code, redirectUri);
    const res = NextResponse.redirect(new URL("/?gmail=connected", req.url));
    res.headers.append("Set-Cookie", buildGmailCookie(tokens));
    return res;
  } catch {
    return NextResponse.redirect(new URL("/?gmail=error", req.url));
  }
}

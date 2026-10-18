import { NextResponse } from "next/server";
import { turnkeyOpener } from "@/lib/ai/templates";

/**
 * POST /api/offers
 * Body: { firstName: string, street: string }
 * Returns { message } — Bradley's approved turnkey opener (lib/comms/scripts.ts),
 * personalized. Generation only: nothing is sent by this route.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be a JSON object." },
      { status: 400 },
    );
  }
  const { firstName, street } = body as Record<string, unknown>;
  if (typeof firstName !== "string" || firstName.trim().length === 0) {
    return NextResponse.json(
      { error: 'Field "firstName" is required (non-empty string).' },
      { status: 400 },
    );
  }
  if (typeof street !== "string" || street.trim().length === 0) {
    return NextResponse.json(
      { error: 'Field "street" is required (non-empty string).' },
      { status: 400 },
    );
  }
  return NextResponse.json({
    message: turnkeyOpener(firstName.trim(), street.trim()),
  });
}

import { NextResponse } from "next/server";
import { runAiCommand } from "@/lib/ai/provider";

/**
 * POST /api/ai/command
 * Body: { command: string }
 * Returns { text, provider, ruleBased, note? } — a DRAFT only. This route
 * never sends a message; with no AI key configured it answers from Bradley's
 * approved templates and labels the result as rule-based.
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
  const { command } = body as Record<string, unknown>;
  if (typeof command !== "string" || command.trim().length === 0) {
    return NextResponse.json(
      { error: 'Field "command" is required (non-empty string).' },
      { status: 400 },
    );
  }
  if (command.length > 4000) {
    return NextResponse.json(
      { error: 'Field "command" is too long (max 4000 characters).' },
      { status: 400 },
    );
  }
  const result = await runAiCommand(command.trim());
  return NextResponse.json(result);
}

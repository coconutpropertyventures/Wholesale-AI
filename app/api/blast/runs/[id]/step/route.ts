import { NextResponse } from "next/server";
import { BlastError, stepBlastRun } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// POST /api/blast/runs/[id]/step — manual single step (testing /
// recovery). Sends AT MOST one item through the shared engine; every
// pacing rail is enforced server-side. A refused step (run not
// approved/sending) returns 409 — nothing was sent.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await stepBlastRun(id);
    if (result.outcome.kind === "refused") {
      return NextResponse.json(
        { ok: false, reason: result.outcome.reason, ...result },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BlastError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.code === "not_found" ? 404 : 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

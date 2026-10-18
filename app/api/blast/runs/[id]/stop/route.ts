import { NextResponse } from "next/server";
import { BlastError, stopBlastRun } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// POST /api/blast/runs/[id]/stop — stop the run for good. Queued items
// stay queued in the record (history), but the run can no longer send.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const detail = await stopBlastRun(id);
    return NextResponse.json({ ok: true, ...detail });
  } catch (err) {
    if (err instanceof BlastError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: err.code === "not_found" ? 404 : 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

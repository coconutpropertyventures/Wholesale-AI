import { NextResponse } from "next/server";
import { BlastError, pauseBlastRun } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// POST /api/blast/runs/[id]/pause — pause the run. The background tick
// skips paused runs; approve again to resume.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const detail = await pauseBlastRun(id);
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

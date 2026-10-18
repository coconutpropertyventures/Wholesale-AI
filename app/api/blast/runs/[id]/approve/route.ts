import { NextResponse } from "next/server";
import { BlastError, approveBlastRun } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// POST /api/blast/runs/[id]/approve — Bradley's approval click. Moves a
// draft (or paused) run to "approved". Approval never sends anything by
// itself; sends happen only via step/tick on an approved run.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const detail = await approveBlastRun(id);
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

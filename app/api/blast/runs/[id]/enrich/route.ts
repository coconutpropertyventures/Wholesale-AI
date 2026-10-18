import { NextResponse } from "next/server";
import { BlastError, enrichBlastRunStep } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// POST /api/blast/runs/[id]/enrich — advance the agent-lookup
// enrichment by ONE short step: start the Redfin detail run, report
// it still running, or apply its rows when it lands. The detail Actor
// takes ~50s per property, so no single request ever waits on it;
// the Blast panel polls this endpoint (~10s) while items enrich.
// Idempotent: calling it with nothing to do returns phase "idle".
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await enrichBlastRunStep(id);
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

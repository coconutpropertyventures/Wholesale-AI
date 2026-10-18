import { NextResponse } from "next/server";
import { getBlastRunDetail } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// GET /api/blast/runs/[id] -> { run, items, counts, sentToday }
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = await getBlastRunDetail(id);
  if (!detail) {
    return NextResponse.json(
      { ok: false, error: `Blast run ${id} not found.` },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, ...detail });
}

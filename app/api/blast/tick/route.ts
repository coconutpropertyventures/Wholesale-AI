import { NextResponse, type NextRequest } from "next/server";
import { tickBlast } from "@/lib/blast/service";

export const dynamic = "force-dynamic";

// POST /api/blast/tick — the background driver. Steps EVERY run in
// approved/sending status by at most one due item each, through the
// shared engine (all pacing rails enforced server-side). An external
// scheduler should call this about once a minute (see README —
// Vercel Hobby cron only runs daily, so it is NOT wired in vercel.json).
//
// Guard: when BLAST_TICK_SECRET is set, the caller must send it in the
// x-blast-secret header. Production should always set it — without it
// anyone who finds this URL can advance (never start) approved runs.
export async function POST(req: NextRequest) {
  const secret = process.env.BLAST_TICK_SECRET?.trim();
  if (secret && req.headers.get("x-blast-secret") !== secret) {
    return NextResponse.json(
      { ok: false, error: "Missing or wrong x-blast-secret header." },
      { status: 401 },
    );
  }
  try {
    const results = await tickBlast();
    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      results,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Blast tick failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

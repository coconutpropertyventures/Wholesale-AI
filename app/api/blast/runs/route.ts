import { NextResponse, type NextRequest } from "next/server";
import { ghlConfigured } from "@/lib/ghl/client";
import {
  BlastError,
  buildBlastRun,
  getBlastRunDetail,
} from "@/lib/blast/service";
import { listBlastRuns } from "@/lib/store/store";
import type { DealPrefill } from "@/lib/deals/prefill";
import type { BlastScriptKey, BlastSource } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET /api/blast/runs -> { configured, runs: [{ run, counts, sentToday }] }
// POST /api/blast/runs { source, stageRef?, properties?, scriptKey, dailyCap?, autoApprove? }
//   -> builds a DRAFT run (nothing sends; approval is a separate click).
//   With autoApprove: true (the workbench "Send to all" button — the
//   click is Bradley's send instruction for that list) the run is
//   created already approved and the engine starts it on the next
//   tick; safety exclusions and pacing rails are unchanged.

export async function GET() {
  const runs = await listBlastRuns();
  const detailed = [];
  for (const run of runs) {
    const detail = await getBlastRunDetail(run.id);
    if (detail) {
      detailed.push({
        run: detail.run,
        counts: detail.counts,
        sentToday: detail.sentToday,
      });
    }
  }
  return NextResponse.json({
    configured: ghlConfigured(),
    runs: detailed.reverse(),
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const source = body.source === "stage" ? "stage" : "search";
  const scriptKey: BlastScriptKey =
    body.scriptKey === "distressed_opener"
      ? "distressed_opener"
      : "turnkey_opener";
  const stageRef =
    source === "stage" &&
    typeof body.stageRef === "object" &&
    body.stageRef !== null
      ? (body.stageRef as { pipelineId: string; stageId: string })
      : undefined;
  const properties = Array.isArray(body.properties)
    ? (body.properties as DealPrefill[])
    : undefined;
  const dailyCap =
    typeof body.dailyCap === "number" && body.dailyCap > 0
      ? Math.floor(body.dailyCap)
      : undefined;
  const autoApprove = body.autoApprove === true;
  try {
    const detail = await buildBlastRun({
      source: source as BlastSource,
      stageRef,
      properties,
      scriptKey,
      dailyCap,
      autoApprove,
    });
    return NextResponse.json({ ok: true, configured: true, ...detail });
  } catch (err) {
    if (err instanceof BlastError && err.code === "not_configured") {
      return NextResponse.json({
        ok: false,
        configured: false,
        error: err.message,
      });
    }
    if (err instanceof BlastError) {
      return NextResponse.json(
        { ok: false, error: err.message },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: `Blast queue build failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import {
  aggregateStageCounts,
  countOpportunities,
  ghlConfigured,
  ghlLocationId,
  listPipelines,
  stagePinRank,
} from "@/lib/ghl/client";

export const dynamic = "force-dynamic";

// GET /api/ghl/pipeline
//   -> { configured, stages: [{ stage, count }], totals: { open, won, lost } }
// Live open-opportunity counts per stage NAME, summed across all pipelines
// in the location (the same stage name in two pipelines is one number).
// Cached in-memory for 60s — the dashboard strip polls this, HighLevel
// does not need the hammering. Not configured -> { configured: false, stages: [] }.

const CACHE_TTL_MS = 60_000;
let cache: { at: number; payload: unknown } | null = null;

const PRIORITY_STAGES = ["New Prospect", "Contacted"];
const MAX_STAGES = 6;

export async function GET() {
  if (!ghlConfigured()) {
    return NextResponse.json({ configured: false, stages: [] });
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.payload);
  }
  const locationId = ghlLocationId();
  if (!locationId) {
    return NextResponse.json({
      configured: true,
      stages: [],
      totals: { open: 0, won: 0, lost: 0 },
      error: "GHL_LOCATION_ID is not set.",
    });
  }
  try {
    const pipelines = await listPipelines(locationId);
    const byStage = await aggregateStageCounts(pipelines, (pipelineId, stageId) =>
      countOpportunities({ locationId, pipelineId, stageId, status: "open" }),
    );
    const [open, won, lost] = await Promise.all([
      countOpportunities({ locationId, status: "open" }),
      countOpportunities({ locationId, status: "won" }),
      countOpportunities({ locationId, status: "lost" }),
    ]);
    const stages = [...byStage.entries()]
      .map(([stage, count]) => ({ stage, count }))
      .sort((a, b) => {
        // Pin matching is normalized (see stagePinRank): real stage names
        // carry decoration like "🚨 NEW PROSPECT 🚨". Display names are
        // passed through exactly as HighLevel returns them.
        const pa = stagePinRank(a.stage, PRIORITY_STAGES);
        const pb = stagePinRank(b.stage, PRIORITY_STAGES);
        if (pa !== -1 || pb !== -1) {
          if (pa === -1) return 1;
          if (pb === -1) return -1;
          return pa - pb;
        }
        return b.count - a.count;
      })
      .slice(0, MAX_STAGES);
    const payload = {
      configured: true,
      stages,
      totals: { open, won, lost },
    };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        stages: [],
        totals: { open: 0, won: 0, lost: 0 },
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

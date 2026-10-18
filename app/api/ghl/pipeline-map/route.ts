import { NextResponse } from "next/server";
import {
  ghlConfigured,
  ghlLocationId,
  listOpenOpportunities,
} from "@/lib/ghl/client";
import {
  buildPipelineMap,
  stageCounts,
} from "@/lib/ghl/pipelineMap";

export const dynamic = "force-dynamic";

// GET /api/ghl/pipeline-map
//   -> { configured, byContact, stageCounts }
// byContact maps a HighLevel contactId to their open-opportunity pipeline
// entries (badges + inbox filtering); stageCounts is keyed
// `${pipelineId}:${stageId}` for the grouped card strip. Backed by
// listOpenOpportunities' 60s cache. Not configured -> empty maps.
export async function GET() {
  if (!ghlConfigured()) {
    return NextResponse.json({
      configured: false,
      byContact: {},
      stageCounts: {},
    });
  }
  const locationId = ghlLocationId();
  if (!locationId) {
    return NextResponse.json({
      configured: true,
      byContact: {},
      stageCounts: {},
      error: "GHL_LOCATION_ID is not set.",
    });
  }
  try {
    const opps = await listOpenOpportunities(locationId);
    return NextResponse.json({
      configured: true,
      byContact: buildPipelineMap(opps),
      stageCounts: stageCounts(opps),
    });
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        byContact: {},
        stageCounts: {},
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

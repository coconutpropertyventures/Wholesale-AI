import { NextResponse, type NextRequest } from "next/server";
import { ghlConfigured, ghlLocationId, listContacts } from "@/lib/ghl/client";

export const dynamic = "force-dynamic";

// GET /api/ghl/contacts?limit=25
// Returns { configured, contacts }. With no GHL token configured the list is
// empty and configured is false — never sample data.
export async function GET(req: NextRequest) {
  const configured = ghlConfigured();
  if (!configured) {
    return NextResponse.json({ configured: false, contacts: [] });
  }
  const locationId = ghlLocationId();
  if (!locationId) {
    return NextResponse.json({
      configured: true,
      contacts: [],
      error: "GHL_LOCATION_ID is not set.",
    });
  }
  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "25");
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 25;
  try {
    const contacts = await listContacts(locationId, limit);
    return NextResponse.json({ configured: true, contacts });
  } catch (err) {
    return NextResponse.json(
      {
        configured: true,
        contacts: [],
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

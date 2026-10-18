import { NextResponse } from "next/server";
import { listAiUsage } from "@/lib/store/store";
import {
  aiDraftConfigured,
  aiMonthlyBudgetUsd,
  monthCostUsd,
} from "@/lib/ai/draft";

export const dynamic = "force-dynamic";

// GET /api/ai/usage -> { configured, monthCostUsd, budgetUsd, calls }
// This month's estimated AI drafting spend for the DraftsPanel header.
export async function GET() {
  const entries = await listAiUsage();
  const now = new Date();
  const monthEntries = entries.filter((e) => {
    const d = new Date(e.createdAt);
    return (
      d.getUTCFullYear() === now.getUTCFullYear() &&
      d.getUTCMonth() === now.getUTCMonth()
    );
  });
  return NextResponse.json({
    configured: aiDraftConfigured(),
    monthCostUsd: monthCostUsd(entries, now),
    budgetUsd: aiMonthlyBudgetUsd(),
    calls: monthEntries.length,
  });
}

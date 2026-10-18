// Learning loop v1 — deliberately modest. A message pattern "worked"
// when a draft created from the workbench (a wai_message_outcomes row)
// names an address that later matches an opportunity in DEALS ASSIGNED
// (Dispositions) or Closed (Wholesale). That is the whole claim; counts
// are reported plainly and no model is trained on them (yet).
import type { GhlOpportunity } from "@/lib/ghl/client";
import type { Draft, MessageOutcome } from "@/lib/types";
import { oppNameMatchesKey, streetKey } from "@/lib/deals/underContract";

export const DEALS_ASSIGNED_STAGE = "d1fe69fc-c8c7-4c9e-88dc-5eae4a2e8323";
export const WHOLESALE_CLOSED_STAGE = "096e7186-19ef-43dc-b78a-f4ba11f1de2c";

/** Opportunities that represent a finished deal (assigned / closed). */
export function assignedOpportunities(
  opps: GhlOpportunity[],
): GhlOpportunity[] {
  return opps.filter(
    (o) =>
      o.pipelineStageId === DEALS_ASSIGNED_STAGE ||
      o.pipelineStageId === WHOLESALE_CLOSED_STAGE,
  );
}

/** Does this outcome's address match any assigned/closed opportunity? */
export function outcomeReachedAssignedDeal(
  outcome: Pick<MessageOutcome, "address">,
  assigned: GhlOpportunity[],
): boolean {
  const key = streetKey(outcome.address);
  if (!key) return false;
  return assigned.some((o) => oppNameMatchesKey(o.name, key));
}

/**
 * Per-draftId usage counts: for each draft, how many assigned/closed
 * deals share its (variant + mode) pattern AND include the draft itself
 * when its own address reached an assigned deal. Drafts whose own deal
 * assigned get the pattern's count; others get 0 (no label shown).
 */
export function assignedUsesByDraftId(
  outcomes: MessageOutcome[],
  opps: GhlOpportunity[],
): Record<string, number> {
  const assigned = assignedOpportunities(opps);
  const wins = outcomes.filter((o) => outcomeReachedAssignedDeal(o, assigned));
  const patternCounts = new Map<string, number>();
  for (const w of wins) {
    const key = `${w.variant}:${w.mode}`;
    patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
  }
  const winIds = new Set(wins.map((w) => w.draftId));
  const out: Record<string, number> = {};
  for (const o of outcomes) {
    if (winIds.has(o.draftId)) {
      out[o.draftId] = patternCounts.get(`${o.variant}:${o.mode}`) ?? 0;
    }
  }
  return out;
}

/** Winning example bodies for a variant (newest first), for AI drafting. */
export function winningExamples(
  outcomes: MessageOutcome[],
  opps: GhlOpportunity[],
  variant: MessageOutcome["variant"],
  limit = 3,
): MessageOutcome[] {
  const assigned = assignedOpportunities(opps);
  return outcomes
    .filter(
      (o) => o.variant === variant && outcomeReachedAssignedDeal(o, assigned),
    )
    .slice(-limit)
    .reverse();
}

/** One rejected example for a variant (its Draft was rejected), if any. */
export function rejectedExample(
  outcomes: MessageOutcome[],
  drafts: Draft[],
  variant: MessageOutcome["variant"],
): MessageOutcome | null {
  const rejectedIds = new Set(
    drafts.filter((d) => d.status === "rejected").map((d) => d.id),
  );
  const found = outcomes
    .filter((o) => o.variant === variant && rejectedIds.has(o.draftId))
    .slice(-1)[0];
  return found ?? null;
}

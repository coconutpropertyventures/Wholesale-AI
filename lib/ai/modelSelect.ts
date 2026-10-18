// Context-dependent model selection for AI drafting (Bradley's rule,
// 2026-10-18): routine pre-deal / pre-contract communication drafts on
// Haiku; anything involving $$ or contracts escalates to Sonnet. Pure
// and dependency-free — the matrix is unit-tested in
// tests/modelSelect.test.ts.
//
// Tiers map to concrete model ids in lib/ai/draft.ts:
//   haiku  -> AI_DRAFT_MODEL        (default claude-haiku-4-5)
//   sonnet -> AI_ESCALATION_MODEL   (default claude-sonnet-5)

export type ModelTier = "haiku" | "sonnet";

export type DraftIntent = "reply" | "offer" | "followup";

export interface ModelSelectContext {
  /** Contact has an opportunity that is a live deal (Dispositions, or a
   *  contract stage) per lib/ghl/pipelineMap. */
  isDeal?: boolean;
  /** Pipeline stage ids of the contact's open opportunities. */
  stageIds?: string[];
  /** What kind of message is being drafted. */
  intent: DraftIntent;
  /** Opportunity monetary value in dollars, when known. */
  monetaryValue?: number;
  /** Modeled assignment fee in dollars, when known. */
  fee?: number;
}

export interface ModelSelection {
  model: ModelTier;
  /** Human-readable reason — shown in the UI chip and logged to
   *  wai_ai_usage with every model call. */
  reason: string;
}

/** Escalation thresholds (dollars). */
export const ESCALATION_FEE_USD = 25_000;
export const ESCALATION_VALUE_USD = 200_000;

/**
 * Deal / contract stages that escalate to Sonnet on their own.
 * Dispositions (all stages — a property under contract being worked):
 *   f6e2c6c4 NEW DEAL/CONTRACT, 241ead91 AVAILABLE DEALS,
 *   fea8858d INBOUND OFFERS, d0f3e234 PENDING ASSIGNMENT,
 *   d1fe69fc DEALS ASSIGNED
 * Acquisitions: 3658f3b1 NEGOTIATING, e9f87b5e DRAFT AGREEMENT,
 *   dabf7b4b MOVED TO DISPO, fbd1a3ad OFFERS MADE
 * Wholesale: 3091dd5c Under Contract, 096e7186 Closed
 */
export const SONNET_STAGE_IDS: ReadonlySet<string> = new Set([
  "f6e2c6c4-4b6d-49a8-bbd1-46280c1d5594",
  "241ead91-e3c7-49e2-ba0c-be46d8e7a60f",
  "fea8858d-7f99-4d2b-b922-37939c72fe40",
  "d0f3e234-72e6-49e2-b0ba-5e6c75ea9f4a",
  "d1fe69fc-c8c7-4c9e-88dc-5eae4a2e8323",
  "3658f3b1-ec00-4161-b191-81449a236e8e",
  "e9f87b5e-c4aa-4c74-9ebd-d0051aa403a0",
  "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902",
  "fbd1a3ad-31fb-4030-b63c-88dbd4e4c61f",
  "3091dd5c-b4a1-481d-8d37-a62ff4ea247f",
  "096e7186-19ef-43dc-b78a-f4ba11f1de2c",
]);

/** Stages whose mere presence means an active contract/deal — the
 *  reason reads "deal under contract" rather than "negotiation stage". */
const CONTRACT_STAGE_IDS: ReadonlySet<string> = new Set([
  // All Dispositions stages (property under contract, being disposed)
  "f6e2c6c4-4b6d-49a8-bbd1-46280c1d5594",
  "241ead91-e3c7-49e2-ba0c-be46d8e7a60f",
  "fea8858d-7f99-4d2b-b922-37939c72fe40",
  "d0f3e234-72e6-49e2-b0ba-5e6c75ea9f4a",
  "d1fe69fc-c8c7-4c9e-88dc-5eae4a2e8323",
  // Acquisitions MOVED TO DISPO, Wholesale Under Contract / Closed
  "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902",
  "3091dd5c-b4a1-481d-8d37-a62ff4ea247f",
  "096e7186-19ef-43dc-b78a-f4ba11f1de2c",
]);

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Pick the drafting model tier for a message. Sonnet when ANY of:
 * the contact is on a live deal; any of their stages is a
 * deal/contract stage; the message is an offer; the modeled fee is
 * >= $25,000; the property value is >= $200,000. Haiku otherwise.
 * Reason precedence: deal > contract stage > negotiation stage >
 * offer > fee > value.
 */
export function selectModel(ctx: ModelSelectContext): ModelSelection {
  if (ctx.isDeal) {
    return { model: "sonnet", reason: "deal under contract" };
  }
  const stages = ctx.stageIds ?? [];
  if (stages.some((id) => SONNET_STAGE_IDS.has(id))) {
    if (stages.some((id) => CONTRACT_STAGE_IDS.has(id))) {
      return { model: "sonnet", reason: "deal under contract" };
    }
    return { model: "sonnet", reason: "negotiation stage" };
  }
  if (ctx.intent === "offer") {
    return { model: "sonnet", reason: "offer message" };
  }
  if (typeof ctx.fee === "number" && ctx.fee >= ESCALATION_FEE_USD) {
    return { model: "sonnet", reason: `fee ${money(ctx.fee)}` };
  }
  if (
    typeof ctx.monetaryValue === "number" &&
    ctx.monetaryValue >= ESCALATION_VALUE_USD
  ) {
    return {
      model: "sonnet",
      reason: `property value ${money(ctx.monetaryValue)}`,
    };
  }
  return { model: "haiku", reason: "routine pre-deal communication" };
}

// Model-backed drafting for the OFFER message only (first messages and
// openers stay pure approved templates — zero model calls). The model
// personalizes Bradley's approved offer script in his voice; it never
// sends anything, and when no ANTHROPIC_API_KEY is set the caller falls
// back to the plain template and says so.
//
// Cost control is in code, not vibes:
//   - max_tokens is capped at 220 (a text message, not an essay).
//   - The style guide + approved script ride in a prompt-cached system
//     block, so repeat drafts bill that block at the cache-read rate.
//   - Every call is logged to wai_ai_usage, and before each call the
//     month-to-date estimated spend is checked against the monthly
//     budget (AI_MONTHLY_BUDGET_USD, default $25). Over budget = refuse.
import { addAiUsage, listAiUsage } from "@/lib/store/store";
import { OFFER_MESSAGE } from "@/lib/comms/scripts";
import type { AiUsageEntry, MessageOutcome } from "@/lib/types";

export const AI_DRAFT_PURPOSE = "draft-offer";
export const MAX_DRAFT_TOKENS = 220;
export const ESCALATION_FEE_THRESHOLD = 25_000;
export const MAX_WINNING_EXAMPLES = 3;

export function aiDraftConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function aiMonthlyBudgetUsd(): number {
  const n = Number(process.env.AI_MONTHLY_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

export function draftModel(): string {
  return process.env.AI_DRAFT_MODEL?.trim() || "claude-haiku-4-5";
}

export function escalationModel(): string {
  return process.env.AI_ESCALATION_MODEL?.trim() || "claude-sonnet-5";
}

/** Escalate on big modeled fees or when the caller explicitly asks. */
export function selectDraftModel(
  fee: number | undefined,
  escalate?: boolean,
): { model: string; escalated: boolean } {
  const shouldEscalate = escalate === true || (fee ?? 0) >= ESCALATION_FEE_THRESHOLD;
  return {
    model: shouldEscalate ? escalationModel() : draftModel(),
    escalated: shouldEscalate,
  };
}

// ---------- Pricing / cost estimation (pure) ----------

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
}

/** Published per-1M-token rates for the configured model families.
 *  Cache reads bill at 10% of the input rate (Haiku: $0.10/1M). */
export function pricingFor(model: string): ModelPricing {
  const m = model.toLowerCase();
  if (m.includes("sonnet")) {
    return { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 };
  }
  // Haiku family (the default drafting model) and any unknown model.
  return { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1 };
}

export interface TokenUsage {
  inputTokens: number; // fresh input tokens (Anthropic semantics: excludes cache reads)
  outputTokens: number;
  cachedTokens: number; // cache-read input tokens, billed at the cache rate
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = pricingFor(model);
  return (
    (usage.inputTokens * p.inputPerM +
      usage.cachedTokens * p.cacheReadPerM +
      usage.outputTokens * p.outputPerM) /
    1_000_000
  );
}

/** Estimated spend for the calendar month containing `now` (UTC). */
export function monthCostUsd(entries: AiUsageEntry[], now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let total = 0;
  for (const e of entries) {
    const d = new Date(e.createdAt);
    if (d.getUTCFullYear() === y && d.getUTCMonth() === m) {
      total += estimateCostUsd(e.model, e);
    }
  }
  return total;
}

/** Budget gate decision: a new call is allowed only while under budget. */
export function withinBudget(spentUsd: number, budgetUsd: number): boolean {
  return spentUsd < budgetUsd;
}

// ---------- Prompt assembly (pure) ----------

export const STYLE_GUIDE = [
  "You draft short SMS messages for Bradley Post of Coconut Property Ventures.",
  "Voice rules (non-negotiable):",
  "- Casual and brief — a text message, not an email. No greeting fluff, no sign-off block.",
  "- Bradley is an investor who works with partners: say \"my partners\". NEVER say wholesaler, never mention assignments or flipping the contract.",
  "- Never quote repair or work dollar figures (no contractor quotes exist) — if condition comes up, say \"based on the property condition\" without numbers.",
  "- One clear ask. No hype, no emojis, no pressure tactics.",
  "- Use the facts given; invent nothing (no dates, no guarantees, no extra terms).",
].join("\n");

export interface DraftPromptInput {
  first: string;
  street: string;
  address: string;
  offerFormatted: string;
  mode: string;
  fee?: number;
  threadSummary?: string;
  examples?: MessageOutcome[]; // winning patterns (capped here)
  avoidExample?: MessageOutcome | null;
}

export interface DraftPrompt {
  systemText: string;
  userText: string;
  exampleCount: number;
}

export function buildDraftPrompt(input: DraftPromptInput): DraftPrompt {
  const examples = (input.examples ?? []).slice(0, MAX_WINNING_EXAMPLES);
  const lines: string[] = [
    "Draft the offer message for this property, personalizing the approved script in the system prompt.",
    "",
    `Agent first name: ${input.first}`,
    `Property: ${input.address} (street: ${input.street})`,
    `Calculated initial offer: ${input.offerFormatted}`,
    `Deal mode: ${input.mode}`,
  ];
  if (input.fee !== undefined) {
    lines.push(`Modeled assignment fee at this offer: $${Math.round(input.fee).toLocaleString("en-US")} (internal context — never mention the fee in the message)`);
  }
  if (input.threadSummary && input.threadSummary.trim().length > 0) {
    lines.push("", `Thread summary so far: ${input.threadSummary.trim()}`);
  }
  if (examples.length > 0) {
    lines.push("", "Examples that worked (messages tied to deals that later got assigned/closed — mirror their tone and structure):");
    for (const ex of examples) lines.push(`- "${ex.body}"`);
  }
  if (input.avoidExample) {
    lines.push("", "Avoid this style (a draft in this pattern was rejected):", `- "${input.avoidExample.body}"`);
  }
  lines.push("", "Return only the message text.");
  return {
    systemText: `${STYLE_GUIDE}\n\nApproved offer script to personalize:\n${OFFER_MESSAGE}`,
    userText: lines.join("\n"),
    exampleCount: examples.length,
  };
}

// ---------- The model call (server-side) ----------

export type DraftOfferResult =
  | {
      ok: true;
      configured: true;
      text: string;
      model: string;
      escalated: boolean;
      usage: TokenUsage & { estCostUsd: number };
    }
  | { ok: false; configured: false }
  | {
      ok: false;
      configured: true;
      reason: "budget";
      spentUsd: number;
      budgetUsd: number;
    }
  | { ok: false; configured: true; reason: "api_error"; error: string };

export interface DraftOfferCallInput extends DraftPromptInput {
  fee?: number;
  escalate?: boolean;
}

export async function draftOfferWithModel(
  input: DraftOfferCallInput,
): Promise<DraftOfferResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { ok: false, configured: false };

  const budgetUsd = aiMonthlyBudgetUsd();
  const spentUsd = monthCostUsd(await listAiUsage(), new Date());
  if (!withinBudget(spentUsd, budgetUsd)) {
    return { ok: false, configured: true, reason: "budget", spentUsd, budgetUsd };
  }

  const { model, escalated } = selectDraftModel(input.fee, input.escalate);
  const prompt = buildDraftPrompt(input);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_DRAFT_TOKENS,
        system: [
          {
            type: "text",
            text: prompt.systemText,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: prompt.userText }],
      }),
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      configured: true,
      reason: "api_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data as { error?: { message?: string } } | null)?.error?.message ??
      `Anthropic API error ${res.status}`;
    return { ok: false, configured: true, reason: "api_error", error: msg };
  }

  const rec = data as {
    content?: { type?: string; text?: string }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const text = (rec.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  const usage: TokenUsage = {
    inputTokens: rec.usage?.input_tokens ?? 0,
    outputTokens: rec.usage?.output_tokens ?? 0,
    cachedTokens: rec.usage?.cache_read_input_tokens ?? 0,
  };
  await addAiUsage({ model, ...usage, purpose: AI_DRAFT_PURPOSE });
  if (!text) {
    return {
      ok: false,
      configured: true,
      reason: "api_error",
      error: "The model returned an empty draft.",
    };
  }
  return {
    ok: true,
    configured: true,
    text,
    model,
    escalated,
    usage: { ...usage, estCostUsd: estimateCostUsd(model, usage) },
  };
}

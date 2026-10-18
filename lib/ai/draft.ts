// Model-backed drafting for the OFFER message and for thread REPLIES
// (first messages and openers stay pure approved templates — zero
// model calls). The model writes in Bradley's voice from the shared
// style guide; it never sends anything. When no ANTHROPIC_API_KEY is
// set, offer drafting falls back to the plain template and says so —
// reply drafting has NO template fallback and reports
// { configured: false } so the UI can say that plainly.
//
// Which model runs is context-dependent (lib/ai/modelSelect.ts):
// routine pre-deal replies draft on Haiku; offers, deal/contract
// threads, big fees and big values escalate to Sonnet. The chosen
// model AND the selection reason are logged to wai_ai_usage per call.
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
import {
  selectModel,
  type ModelSelection,
  type ModelTier,
} from "@/lib/ai/modelSelect";
import type { AiUsageEntry, MessageOutcome } from "@/lib/types";

export const AI_DRAFT_PURPOSE = "draft-offer";
export const AI_REPLY_PURPOSE = "draft-reply";
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

/** Escalate on big modeled fees or when the caller explicitly asks.
 *  Kept for backward compatibility — new code picks models through
 *  selectModel (lib/ai/modelSelect.ts) and modelIdForTier below. */
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

/** Map a selectModel tier to the configured concrete model id. */
export function modelIdForTier(tier: ModelTier): string {
  return tier === "sonnet" ? escalationModel() : draftModel();
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

// ---------- The model call (server-side, shared) ----------

type ModelCallResult =
  | {
      ok: true;
      text: string;
      model: string;
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

/**
 * One budget-gated, usage-logged Anthropic call behind every drafting
 * feature. `reason` is the model-selection reason (selectModel) and is
 * stored on the wai_ai_usage row alongside the model and purpose.
 */
async function callDraftModel(args: {
  model: string;
  purpose: string;
  reason?: string;
  systemText: string;
  userText: string;
}): Promise<ModelCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { ok: false, configured: false };

  const budgetUsd = aiMonthlyBudgetUsd();
  const spentUsd = monthCostUsd(await listAiUsage(), new Date());
  if (!withinBudget(spentUsd, budgetUsd)) {
    return { ok: false, configured: true, reason: "budget", spentUsd, budgetUsd };
  }

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
        model: args.model,
        max_tokens: MAX_DRAFT_TOKENS,
        system: [
          {
            type: "text",
            text: args.systemText,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: args.userText }],
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
  await addAiUsage({
    model: args.model,
    ...usage,
    purpose: args.purpose,
    reason: args.reason,
  });
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
    text,
    model: args.model,
    usage: { ...usage, estCostUsd: estimateCostUsd(args.model, usage) },
  };
}

// ---------- Offer drafting ----------

export type DraftOfferResult =
  | {
      ok: true;
      configured: true;
      text: string;
      model: string;
      modelTier: ModelTier;
      /** selectModel reason, e.g. "offer message". */
      reason: string;
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
  // Offers carry a dollar figure, so they route through the shared
  // context-dependent selection with intent "offer" (Sonnet tier);
  // an explicit escalate request lands on the same tier.
  const selection: ModelSelection = selectModel({
    intent: "offer",
    fee: input.fee,
  });
  const model = modelIdForTier(selection.model);
  const prompt = buildDraftPrompt(input);
  const result = await callDraftModel({
    model,
    purpose: AI_DRAFT_PURPOSE,
    reason: selection.reason,
    systemText: prompt.systemText,
    userText: prompt.userText,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    configured: true,
    text: result.text,
    model: result.model,
    modelTier: selection.model,
    reason: selection.reason,
    escalated: selection.model === "sonnet",
    usage: result.usage,
  };
}

// ---------- Reply drafting (per-thread "Draft with AI") ----------

export interface ReplyThreadMessage {
  direction: "inbound" | "outbound";
  body: string;
}

export interface ReplyPromptInput {
  contactName?: string;
  /** Thread messages, oldest → newest (truncated inside). */
  messages: ReplyThreadMessage[];
  /** Human stage labels for the contact's pipeline entries, e.g.
   *  "Pre-Screening · New Prospect" (internal context only). */
  stageLabels?: string[];
  opportunityName?: string;
  monetaryValue?: number;
  /** Bradley's optional steering note for this draft. */
  note?: string;
}

export const MAX_REPLY_CONTEXT_MESSAGES = 10;
const MAX_REPLY_MESSAGE_CHARS = 600;

export function buildReplyPrompt(input: ReplyPromptInput): DraftPrompt {
  const recent = input.messages.slice(-MAX_REPLY_CONTEXT_MESSAGES);
  const lines: string[] = [
    "Draft Bradley's next reply in this conversation. Read the thread, work out where the deal stands, and answer the most recent message appropriately.",
  ];
  if (input.contactName) lines.push(`Contact: ${input.contactName}`);
  if (input.opportunityName) {
    lines.push(`Opportunity: ${input.opportunityName}`);
  }
  if (typeof input.monetaryValue === "number" && input.monetaryValue > 0) {
    lines.push(
      `Opportunity value: $${Math.round(input.monetaryValue).toLocaleString("en-US")} (internal context — never quote a value or fee back unless the thread already put a number on the table)`,
    );
  }
  if (input.stageLabels && input.stageLabels.length > 0) {
    lines.push(
      `Pipeline stage (internal context — never mention stages, pipelines, or a CRM in the message): ${input.stageLabels.join("; ")}`,
    );
  }
  lines.push("", "Thread (oldest first):");
  const them = input.contactName?.trim() || "Contact";
  for (const m of recent) {
    const body =
      m.body.length > MAX_REPLY_MESSAGE_CHARS
        ? `${m.body.slice(0, MAX_REPLY_MESSAGE_CHARS)}…`
        : m.body;
    lines.push(`${m.direction === "inbound" ? them : "Bradley"}: ${body}`);
  }
  if (input.note && input.note.trim().length > 0) {
    lines.push("", `Bradley's note for this draft: ${input.note.trim()}`);
  }
  lines.push("", "Return only the reply text.");
  return {
    systemText: `${STYLE_GUIDE}\n\nTask: draft a reply to the latest message in an ongoing conversation with a listing agent. Continue naturally from the thread — answer what was asked using only the facts given, keep it to one clear next step, and never invent numbers, dates, or terms that are not in the thread.`,
    userText: lines.join("\n"),
    exampleCount: 0,
  };
}

export type DraftReplyResult =
  | {
      ok: true;
      configured: true;
      text: string;
      model: string;
      modelTier: ModelTier;
      /** selectModel reason, e.g. "routine pre-deal communication". */
      reason: string;
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

export interface DraftReplyCallInput extends ReplyPromptInput {
  /** selectModel context: the contact's deal flag + stage ids. */
  isDeal?: boolean;
  stageIds?: string[];
  fee?: number;
}

export async function draftReplyWithModel(
  input: DraftReplyCallInput,
): Promise<DraftReplyResult> {
  const selection = selectModel({
    isDeal: input.isDeal,
    stageIds: input.stageIds ?? [],
    intent: "reply",
    monetaryValue: input.monetaryValue,
    fee: input.fee,
  });
  const model = modelIdForTier(selection.model);
  const prompt = buildReplyPrompt(input);
  const result = await callDraftModel({
    model,
    purpose: AI_REPLY_PURPOSE,
    reason: selection.reason,
    systemText: prompt.systemText,
    userText: prompt.userText,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    configured: true,
    text: result.text,
    model: result.model,
    modelTier: selection.model,
    reason: selection.reason,
    usage: result.usage,
  };
}

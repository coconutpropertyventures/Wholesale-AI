// Provider-agnostic AI drafting layer.
// If ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY is set (checked in
// that order), the command is sent to that provider's chat API with plain
// fetch — no SDK dependencies. Model names can be overridden with
// ANTHROPIC_MODEL / OPENAI_MODEL / GEMINI_MODEL.
// If no key is configured — or the provider call fails — a rule-based
// response built from Bradley's approved templates is returned instead and
// CLEARLY labeled as rule-based. This layer only drafts text; it never sends
// anything and never claims a message went out.
import { turnkeyIntake, turnkeyOpener } from "@/lib/ai/templates";

export type AiProviderName = "anthropic" | "openai" | "gemini" | "rule-based";

export interface AiCommandResult {
  text: string;
  provider: AiProviderName;
  /** True when the text came from the template fallback, not a live model. */
  ruleBased: boolean;
  /** e.g. why the fallback was used (no key configured, provider error). */
  note?: string;
}

const SYSTEM_PROMPT = [
  "You are the drafting assistant inside Wholesale AI, used by Bradley Post of Coconut Property Ventures LLC, a real estate investor / acquisition partner working with a network of buyers.",
  "Draft concise, casual outreach text for listing agents or buyers. Rules:",
  "- Present Bradley as an investor / acquisition partner. NEVER use the words wholesaler, wholesale, or assignment.",
  "- Keep it short and minimal. Never invent property facts, prices, repair figures, or comps that were not provided.",
  "- Never claim a message was sent. Output only the draft text.",
].join("\n");

const RULE_BASED_LABEL = "rule-based (no AI key configured)";

function configuredProvider(): AiProviderName | null {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";
  return null;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) {
    const msg =
      (parsed as { error?: { message?: string } } | undefined)?.error
        ?.message ?? `HTTP ${res.status}`;
    throw new Error(`Provider request failed: ${msg}`);
  }
  return (parsed ?? {}) as Record<string, unknown>;
}

async function callAnthropic(command: string): Promise<string> {
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5";
  const data = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!.trim(),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: command }],
    }),
  });
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: string }).text ?? "")
        : "",
    )
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned an empty response.");
  return text;
}

async function callOpenAi(command: string): Promise<string> {
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const data = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: command },
      ],
    }),
  });
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as
    | { message?: { content?: string } }
    | undefined;
  const text = first?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty response.");
  return text;
}

async function callGemini(command: string): Promise<string> {
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY!.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: command }] }],
      }),
    },
  );
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const first = candidates[0] as
    | { content?: { parts?: { text?: string }[] } }
    | undefined;
  const text = (first?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

// ---------- Rule-based fallback ----------

const FIRST_NAME_RE = /\b(?:for|to)\s+([A-Za-z][A-Za-z'-]*)/i;
const STREET_RE =
  /\b(\d{1,6}\s+[A-Za-z0-9 .]+?\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ct|Court|Ln|Lane|Blvd|Way|Pl|Place))\b/i;

/**
 * Template-driven response used when no AI provider key is configured.
 * Recognizes "intake" requests and opener requests that name an agent
 * and/or a street; anything else gets an honest description of what the
 * fallback can do. Placeholders stay visible when a value is missing.
 */
export function ruleBasedResponse(command: string): string {
  const lower = command.toLowerCase();
  const nameMatch = command.match(FIRST_NAME_RE);
  const streetMatch = command.match(STREET_RE);
  const first = nameMatch?.[1];
  const street = streetMatch?.[1]?.trim();

  let body: string;
  if (lower.includes("intake")) {
    body = turnkeyIntake(first ?? "{first}");
    if (!first) {
      body += "\n\n(Send it with an agent's first name and the {first} placeholder fills in.)";
    }
  } else if (first || street) {
    body = turnkeyOpener(first ?? "{first}", street ?? "{street}");
    if (!first || !street) {
      body +=
        "\n\n(Fill in the remaining {first} / {street} placeholders — e.g. \"draft an opener for Debra at 2309 S Meridian St\".)";
    }
  } else {
    body = [
      "I can draft from Bradley's approved templates. Try:",
      '- "Draft an opener for Debra at 2309 S Meridian St" — the approved turnkey first-touch.',
      '- "Draft intake questions for Debra" — the approved 4-question intake.',
      "For free-form drafting, add an AI provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY) in the server environment.",
    ].join("\n");
  }
  return `[${RULE_BASED_LABEL}]\n\n${body}`;
}

// ---------- Entry point ----------

export async function runAiCommand(command: string): Promise<AiCommandResult> {
  const provider = configuredProvider();
  if (!provider) {
    return {
      text: ruleBasedResponse(command),
      provider: "rule-based",
      ruleBased: true,
      note: RULE_BASED_LABEL,
    };
  }
  try {
    const text =
      provider === "anthropic"
        ? await callAnthropic(command)
        : provider === "openai"
          ? await callOpenAi(command)
          : await callGemini(command);
    return { text, provider, ruleBased: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: ruleBasedResponse(command),
      provider: "rule-based",
      ruleBased: true,
      note: `${provider} call failed (${message}); fell back to ${RULE_BASED_LABEL}.`,
    };
  }
}

import { NextResponse } from "next/server";
import {
  underwrite,
  type DealMode,
  type UnderwritingInputs,
} from "@/lib/underwriting/model";

const MODES: readonly DealMode[] = ["turnkey", "flip", "land"];

const OPTIONAL_NUMBERS = [
  "monthlyRent",
  "annualTaxes",
  "annualInsurance",
  "monthlyHoa",
  "marketValue",
  "dom",
  "priceCuts",
  "arv",
  "repairEstimate",
  "landCompValue",
  "targetFee",
  "targetCapRate",
] as const;

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * POST /api/underwrite
 * Body: UnderwritingInputs as JSON (mode + listPrice required).
 * Returns the UnderwritingResult verbatim — assumptions and unverified
 * inputs included, so the UI can render the calculation transparently.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  if (!MODES.includes(b.mode as DealMode)) {
    return bad('Field "mode" must be one of: turnkey, flip, land.');
  }
  const listPrice = b.listPrice;
  if (
    typeof listPrice !== "number" ||
    !Number.isFinite(listPrice) ||
    listPrice <= 0
  ) {
    return bad('Field "listPrice" is required and must be a positive number.');
  }

  const inputs: UnderwritingInputs = {
    mode: b.mode as DealMode,
    listPrice,
  };
  for (const key of OPTIONAL_NUMBERS) {
    const value = b[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return bad(`Field "${key}" must be a non-negative number when provided.`);
    }
    inputs[key] = value;
  }

  return NextResponse.json(underwrite(inputs));
}

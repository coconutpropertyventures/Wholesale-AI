// Under-contract detection for the RentCast gate (Bradley's rule:
// RentCast is spent ONLY on deals already under contract).
// A deal counts as under contract when an OPEN opportunity whose name
// carries the property address sits in:
//   - the Dispositions pipeline (any stage — a deal enters Dispo at
//     contract), or
//   - the Wholesale pipeline's Under Contract / Closed stages, or
//   - Acquisitions' MOVED TO DISPO stage.
// Matching is by street key: house number + first significant street
// word, so "2309 S Meridian St" matches "2309 S Meridian St, Indianapolis"
// and "2309 Meridian St".
import {
  ACQUISITIONS_ID,
  DISPOSITIONS_ID,
  WHOLESALE_ID,
} from "@/lib/ghl/pipelineMap";
import type { GhlOpportunity } from "@/lib/ghl/client";

const WHOLESALE_CONTRACT_STAGES = new Set([
  "3091dd5c-b4a1-481d-8d37-a62ff4ea247f", // Under Contract
  "096e7186-19ef-43dc-b78a-f4ba11f1de2c", // Closed
]);
const ACQ_MOVED_TO_DISPO = "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902";

export function isUnderContractOpp(
  opp: Pick<GhlOpportunity, "pipelineId" | "pipelineStageId">,
): boolean {
  if (opp.pipelineId === DISPOSITIONS_ID) return true;
  if (opp.pipelineId === WHOLESALE_ID) {
    return WHOLESALE_CONTRACT_STAGES.has(opp.pipelineStageId);
  }
  if (opp.pipelineId === ACQUISITIONS_ID) {
    return opp.pipelineStageId === ACQ_MOVED_TO_DISPO;
  }
  return false;
}

const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);

/**
 * "2309 S Meridian St, Indianapolis, IN" -> "2309 meridian".
 * Returns null when no leading house number can be found.
 */
export function streetKey(address: string): string | null {
  const tokens = address
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const numIdx = tokens.findIndex((t) => /^\d+$/.test(t));
  if (numIdx === -1) return null;
  const number = tokens[numIdx];
  for (let i = numIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) continue;
    if (DIRECTIONALS.has(t)) continue;
    return `${number} ${t}`;
  }
  return null;
}

/** Does an opportunity name carry this street key? */
export function oppNameMatchesKey(name: string, key: string): boolean {
  const [number, word] = key.split(" ");
  const nameNorm = ` ${name.toLowerCase().replace(/[^a-z0-9\s]/g, " ")} `;
  const numRe = new RegExp(`\\s${number}\\s`);
  if (!numRe.test(nameNorm)) return false;
  return nameNorm.includes(` ${word} `) || nameNorm.includes(` ${word},`);
}

/** The first under-contract opportunity matching this address, if any. */
export function matchUnderContract(
  opps: GhlOpportunity[],
  address: string,
): GhlOpportunity | null {
  const key = streetKey(address);
  if (!key) return null;
  for (const opp of opps) {
    if (!isUnderContractOpp(opp)) continue;
    if (oppNameMatchesKey(opp.name, key)) return opp;
  }
  return null;
}

// Pure helpers mapping HighLevel opportunities to per-contact pipeline
// badges, card filtering, and deal flags. The pipeline/stage IDs and names
// below were verified live against Bradley's location on 2026-10-18 — the
// stage names keep HighLevel's emoji decoration; display code shortens
// them with shortStageName(). Opportunity payloads carry only stage IDs,
// so names must come from this map.
import type { GhlOpportunity } from "@/lib/ghl/client";

export interface PipelineStageDef {
  id: string;
  name: string; // raw HighLevel stage name (may carry emoji)
}

export interface PipelineDef {
  id: string;
  shortName: string; // Pre-Screening / Acquisitions / Dispositions / Wholesale
  stages: PipelineStageDef[];
}

export const PRE_SCREENING_ID = "nH1Mlq7ZiJo4rAtZXiSx";
export const ACQUISITIONS_ID = "Xh8HFHDO9PIkyGMYra5f";
export const DISPOSITIONS_ID = "P29oTdnJw4C9fer7zLVJ";
export const WHOLESALE_ID = "YMvldhZa6RBhPnF2qFZ9";

export const PIPELINE_DEFS: PipelineDef[] = [
  {
    id: PRE_SCREENING_ID,
    shortName: "Pre-Screening",
    stages: [
      { id: "b6db489b-8214-4f32-8cdc-3d2404747b3b", name: "🚨 NEW PROSPECT 🚨" },
      { id: "e74fabe8-113b-4d69-9b3e-9ac4e2c56f6d", name: "CALLED BACK / REPLIED 📲" },
      { id: "57a5c338-aecf-4d9f-9f83-5d7096b64f97", name: "PRE-QUALIFY PROSPECT 🚧" },
      { id: "2846b7d4-ae99-4e51-84eb-c314e2f16494", name: "SCHEDULED FOLLOW-UP 📆" },
      { id: "52df5d7d-0f4c-4ceb-a96d-6057b030c284", name: "⬆️ QUALIFIED LEAD ⬆️" },
      { id: "a8085f32-32b0-42a2-b9ab-2533188a9612", name: "30-90 DAY FOLLOW-UPS 🥶" },
      { id: "0b402487-0dec-4020-9464-2d953163156f", name: "OVERPRICED 📈" },
      { id: "9d531be5-6953-4c49-8927-3a91727232c1", name: "NOT INTERESTED 🚫" },
      { id: "af8fd769-855a-4174-a766-e6b5cfdc3fda", name: "NO RESPONSE 👻" },
    ],
  },
  {
    id: ACQUISITIONS_ID,
    shortName: "Acquisitions",
    stages: [
      { id: "d6e2ace3-8388-496e-8a3b-a0848d06ebdc", name: "NEW LEADS 📬" },
      { id: "706e72a5-8827-4341-b091-1faabbffe5f8", name: "REVIEWING / OFFER PREP 🔎" },
      { id: "ac064737-4ad5-4af9-b897-8fe5766389ca", name: "🚨 READY FOR OFFER 🚨" },
      { id: "fbd1a3ad-31fb-4030-b63c-88dbd4e4c61f", name: "OFFERS MADE ✅" },
      { id: "44dd49e2-3933-488d-b3cb-65039b47aa81", name: "ATTEMPTED TO CONTACT 📲" },
      { id: "0ce5c670-acca-4415-ae23-bbf081257987", name: "NURTURING LEADS ⏳" },
      { id: "3658f3b1-ec00-4161-b191-81449a236e8e", name: "NEGOTIATING OFFERS 🤼" },
      { id: "e9f87b5e-c4aa-4c74-9ebd-d0051aa403a0", name: "DRAFT AGREEMENT 📝" },
      { id: "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902", name: "🔒 MOVED TO DISPO 🔒" },
      { id: "e3539c25-c99a-460e-85b1-d49270c0c302", name: "DECLINED OFFERS 🚫" },
      { id: "247928fd-d95b-4bac-9d8c-8f5b19ff409a", name: "GHOSTED / NCM LEADS 👻" },
    ],
  },
  {
    id: DISPOSITIONS_ID,
    shortName: "Dispositions",
    stages: [
      { id: "f6e2c6c4-4b6d-49a8-bbd1-46280c1d5594", name: "🎊 NEW DEAL / CONTRACT 🎊" },
      { id: "241ead91-e3c7-49e2-ba0c-be46d8e7a60f", name: "AVAILABLE DEALS 🌎" },
      { id: "fea8858d-7f99-4d2b-b922-37939c72fe40", name: "INBOUND OFFERS 📫" },
      { id: "d0f3e234-72e6-49e2-b0ba-5e6c75ea9f4a", name: "PENDING ASSIGNMENT ⏳" },
      { id: "d1fe69fc-c8c7-4c9e-88dc-5eae4a2e8323", name: "🤑 DEALS ASSIGNED 🤑" },
    ],
  },
  {
    id: WHOLESALE_ID,
    shortName: "Wholesale",
    stages: [
      { id: "e655c448-9d7c-41b3-8d69-e2de8ea8a03d", name: "New Lead" },
      { id: "6bdb617e-b58c-4a20-aaee-79edcc0a49ff", name: "Contacted" },
      { id: "32770d77-d4e6-439c-a173-b96fcff2f756", name: "Offer Made" },
      { id: "3091dd5c-b4a1-481d-8d37-a62ff4ea247f", name: "Under Contract" },
      { id: "096e7186-19ef-43dc-b78a-f4ba11f1de2c", name: "Closed" },
    ],
  },
];

const PIPELINE_BY_ID = new Map(PIPELINE_DEFS.map((p) => [p.id, p]));
const STAGE_NAME_BY_ID = new Map<string, string>();
for (const p of PIPELINE_DEFS) {
  for (const s of p.stages) STAGE_NAME_BY_ID.set(s.id, s.name);
}

export function pipelineShortName(pipelineId: string): string {
  return PIPELINE_BY_ID.get(pipelineId)?.shortName ?? "Pipeline";
}

export function stageName(stageId: string): string {
  return STAGE_NAME_BY_ID.get(stageId) ?? "";
}

/**
 * Display-short stage name: strip emoji/symbols, collapse whitespace, and
 * title-case. "🚨 NEW PROSPECT 🚨" -> "New Prospect",
 * "30-90 DAY FOLLOW-UPS 🥶" -> "30-90 Day Follow-ups".
 */
export function shortStageName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}\s/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((word) => {
      if (word === "/" || word === "-") return word;
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Stage IDs that, anywhere they appear, mark a live deal/contract. */
export const DEAL_STAGE_IDS = new Set<string>([
  "3091dd5c-b4a1-481d-8d37-a62ff4ea247f", // Wholesale · Under Contract
  "096e7186-19ef-43dc-b78a-f4ba11f1de2c", // Wholesale · Closed
  "dabf7b4b-ec31-4117-9e77-f4ce3a1aa902", // Acquisitions · MOVED TO DISPO
  "d0f3e234-72e6-49e2-b0ba-5e6c75ea9f4a", // Dispositions · PENDING ASSIGNMENT
  "d1fe69fc-c8c7-4c9e-88dc-5eae4a2e8323", // Dispositions · DEALS ASSIGNED
]);

export interface PipelineMapEntry {
  pipelineId: string;
  pipelineName: string; // short label
  stageId: string;
  stageName: string; // raw HighLevel stage name
  opportunityName: string;
  isDeal: boolean;
}

export type PipelineMap = Record<string, PipelineMapEntry[]>;

/** A contact entry represents a deal when it sits in Dispositions at all,
 *  or in one of the explicit deal stages in another pipeline. */
export function isDealEntry(pipelineId: string, stageId: string): boolean {
  return pipelineId === DISPOSITIONS_ID || DEAL_STAGE_IDS.has(stageId);
}

/**
 * Group open opportunities by contact. Entries are sorted deal-first,
 * then by pipeline order, so a contact's most relevant badge is entries[0].
 */
export function buildPipelineMap(opps: GhlOpportunity[]): PipelineMap {
  const byContact: PipelineMap = {};
  const pipelineOrder = new Map(PIPELINE_DEFS.map((p, i) => [p.id, i]));
  for (const opp of opps) {
    if (!opp.contactId) continue;
    const entry: PipelineMapEntry = {
      pipelineId: opp.pipelineId,
      pipelineName: pipelineShortName(opp.pipelineId),
      stageId: opp.pipelineStageId,
      stageName: stageName(opp.pipelineStageId),
      opportunityName: opp.name,
      isDeal: isDealEntry(opp.pipelineId, opp.pipelineStageId),
    };
    (byContact[opp.contactId] ??= []).push(entry);
  }
  for (const entries of Object.values(byContact)) {
    entries.sort((a, b) => {
      if (a.isDeal !== b.isDeal) return a.isDeal ? -1 : 1;
      return (
        (pipelineOrder.get(a.pipelineId) ?? 99) -
        (pipelineOrder.get(b.pipelineId) ?? 99)
      );
    });
  }
  return byContact;
}

/** Open-opp counts keyed `${pipelineId}:${stageId}` for the card strip. */
export function stageCounts(
  opps: GhlOpportunity[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const opp of opps) {
    const key = `${opp.pipelineId}:${opp.pipelineStageId}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface InboxFilter {
  pipelineId: string;
  stageId: string;
  label: string;
}

/** Does this contact's entry list place them inside the active filter? */
export function contactMatchesFilter(
  entries: PipelineMapEntry[] | undefined,
  filter: InboxFilter,
): boolean {
  if (!entries) return false;
  return entries.some(
    (e) => e.pipelineId === filter.pipelineId && e.stageId === filter.stageId,
  );
}

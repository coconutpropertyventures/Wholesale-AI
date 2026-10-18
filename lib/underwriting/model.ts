/**
 * Wholesale Model v3.2 — Coconut Property Ventures underwriting.
 * The assignment fee is the OUTPUT, never an input.
 * Every result carries its assumptions and flags which inputs are unverified.
 *
 * v3.2 ceiling change (Bradley, 2026-10-18), on-market listings:
 *  - Turnkey buyer ceiling = min(NOI / target cap, list − 5%). Market
 *    value (MV) is NO LONGER a ceiling term — computed and displayed
 *    as a reference figure only.
 *  - Hard invariant, BOTH modes: the buyer ceiling can never exceed
 *    the list price. Traditional keeps its base (wholesale % × ARV)
 *    and gains the clamp: ceiling = min(pct × ARV, list).
 * Everything downstream is unchanged: MAO = min(ceiling − fee, list),
 * fee = ceiling − contract, A–F grade bands, turnkey initial offer =
 * list − 10% after intake.
 */

export type DealMode = "turnkey" | "flip" | "land" | "traditional";

export interface UnderwritingInputs {
  mode: DealMode;
  listPrice: number;              // asking/list price
  monthlyRent?: number;           // use listing-stated rent where stated
  annualTaxes?: number;           // if unknown, estimated and flagged
  annualInsurance?: number;       // if unknown, estimated and flagged
  monthlyHoa?: number;
  marketValue?: number;           // MV estimate (sold comps); v3.2: reference only, never a ceiling term
  dom?: number;                   // days on market
  priceCuts?: number;             // number of price reductions
  arv?: number;                   // flip + traditional mode: after-repair value
  repairEstimate?: number;        // flip + traditional mode
  wholesalePercent?: number;      // traditional mode: buyer all-in % of ARV (default 0.70)
  landCompValue?: number;         // land mode: comparable land value
  targetFee?: number;             // default 15000
  targetCapRate?: number;         // default 0.05
}

export interface UnderwritingResult {
  mode: DealMode;
  noi?: number;
  buyerCeiling?: number;
  /** Which term set the buyer ceiling — display label ("NOI / 5%",
   *  "List − 5%", "List price", "Wholesale % × ARV"). */
  ceilingBinding?: string;
  mao: number;                    // max allowable offer (contract price cap)
  suggestedContract: number;      // realistic contract from motivation discount
  assignmentFee: number;          // ceiling - contract (turnkey) or mao - contract
  discountRate: number;
  grade: "A" | "B" | "C" | "D" | "F";
  capRateAtContract?: number;
  modeledContract?: number;       // realistic contract from motivation discount, before the MAO cap
  initialOffer?: number;          // turnkey: list - 10%, capped at MAO; the default offer after intake
  assumptions: Record<string, number | string>;
  unverified: string[];           // names of inputs that were estimated/not sourced
  explanation: string[];
}

const DEFAULTS = {
  fee: 15000,
  capRate: 0.05,
  vacancy: 0.08,
  management: 0.10,   // % of gross rent
  maintenance: 0.08,  // % of gross rent
  capex: 0.08,        // % of gross rent
  closingBuffer: 1500 // in the quick-NOI rule of thumb
};

/** Motivation discount tiers (operationalized from "slightly below list"):
 *  300+ DOM or 4+ cuts -> 15% | 200+ DOM or 3+ cuts -> 12% | 120+ DOM or 1+ cut -> 8% | else 4% */
export function motivationDiscount(dom = 0, priceCuts = 0): number {
  if (dom >= 300 || priceCuts >= 4) return 0.15;
  if (dom >= 200 || priceCuts >= 3) return 0.12;
  if (dom >= 120 || priceCuts >= 1) return 0.08;
  return 0.04;
}

export function gradeForFee(fee: number): UnderwritingResult["grade"] {
  if (fee < 0) return "F";
  if (fee >= 15000) return "A";
  if (fee >= 10000) return "B";
  if (fee >= 5000) return "C";
  return "D";
}

function underwriteTurnkey(inp: UnderwritingInputs): UnderwritingResult {
  const unverified: string[] = [];
  const fee = inp.targetFee ?? DEFAULTS.fee;
  const cap = inp.targetCapRate ?? DEFAULTS.capRate;
  const rent = inp.monthlyRent ?? 0;
  if (!inp.monthlyRent) unverified.push("monthlyRent");
  const grossAnnual = rent * 12;
  const taxes = inp.annualTaxes ?? Math.round(inp.listPrice * 0.018);
  if (!inp.annualTaxes) unverified.push("annualTaxes");
  const insurance = inp.annualInsurance ?? 1500;
  if (!inp.annualInsurance) unverified.push("annualInsurance");
  const hoa = (inp.monthlyHoa ?? 0) * 12;

  // Full NOI: vacancy, management, maintenance, capex are % of gross rent.
  const noi =
    grossAnnual * (1 - DEFAULTS.vacancy - DEFAULTS.management - DEFAULTS.maintenance - DEFAULTS.capex)
    - taxes - insurance - hoa;

  const noiOnlyCeiling = cap > 0 ? noi / cap : 0;
  // v3.2: ceiling = min(NOI / cap, list − 5%). MV is not a term here
  // anymore (reference only — still flagged unverified when absent,
  // since it is shown for context). Because list × 0.95 < list, the
  // hard invariant — ceiling never above list price — holds by
  // construction.
  const listCap = inp.listPrice * 0.95;
  const ceiling = Math.min(noiOnlyCeiling, listCap);
  const ceilingBinding =
    noiOnlyCeiling <= listCap
      ? `NOI / ${(cap * 100).toFixed(0)}%`
      : "List − 5%";
  if (!inp.marketValue) unverified.push("marketValue");

  // MAO is hard-capped at list price, always.
  const mao = Math.min(ceiling - fee, inp.listPrice);
  const discountRate = motivationDiscount(inp.dom, inp.priceCuts);
  // The modeled (realistic) contract comes from motivation alone; the fee is
  // graded against it and CAN go negative (Grade F). The suggested offer is
  // the modeled contract capped at MAO so a proposal never exceeds it.
  const modeledContract = Math.round(inp.listPrice * (1 - discountRate));
  // Bradley's turnkey rule (2026-10-17): the initial offer after intake is
  // list - 10%. The fee and grade are graded honestly against that raw
  // opener (it can grade F). The suggested contract caps the opener at MAO,
  // and the calculator's modeled contract stays available as an override.
  const initialOffer = Math.round(inp.listPrice * 0.9);
  const suggestedContract = Math.round(Math.min(initialOffer, Math.max(mao, 0)));
  const assignmentFee = Math.round(ceiling - initialOffer);
  const capRateAtContract = suggestedContract > 0 ? noi / (suggestedContract + fee) : undefined;

  return {
    mode: "turnkey",
    noi: Math.round(noi),
    buyerCeiling: Math.round(ceiling),
    ceilingBinding,
    mao: Math.round(mao),
    suggestedContract,
    assignmentFee,
    discountRate,
    grade: gradeForFee(assignmentFee),
    capRateAtContract,
    modeledContract,
    initialOffer,
    assumptions: {
      vacancy: DEFAULTS.vacancy, management: DEFAULTS.management,
      maintenance: DEFAULTS.maintenance, capex: DEFAULTS.capex,
      targetCapRate: cap, targetFee: fee, annualTaxes: taxes, annualInsurance: insurance
    },
    unverified,
    explanation: [
      `NOI $${Math.round(noi).toLocaleString()} at $${rent.toLocaleString()}/mo rent with 8% vacancy, 10% management, 8% maintenance, 8% capex.`,
      `Buyer ceiling = min(NOI / ${(cap * 100).toFixed(0)}% = $${Math.round(noiOnlyCeiling).toLocaleString()}, list − 5% = $${Math.round(listCap).toLocaleString()}) = $${Math.round(ceiling).toLocaleString()} — bound by ${ceilingBinding}.${inp.marketValue ? ` MV $${inp.marketValue.toLocaleString()} is reference only (not a ceiling term).` : ""}`,
      `MAO = min(ceiling - $${fee.toLocaleString()} fee, list $${inp.listPrice.toLocaleString()}) = $${Math.round(mao).toLocaleString()}.`,
      `Initial offer = list - 10% = $${initialOffer.toLocaleString()}, made after intake answers are in. Fee at that offer $${assignmentFee.toLocaleString()}, grade ${gradeForFee(assignmentFee)}.${initialOffer > mao ? ` Opener exceeds MAO ($${Math.round(mao).toLocaleString()}) — suggested contract is capped at MAO; override from the calculator advised.` : ""}`,
      `Calculator advisory: motivation discount ${(discountRate * 100).toFixed(0)}% (DOM ${inp.dom ?? 0}, cuts ${inp.priceCuts ?? 0}) -> modeled contract $${modeledContract.toLocaleString()} — available as an override.`
    ]
  };
}

function underwriteFlip(inp: UnderwritingInputs): UnderwritingResult {
  const unverified: string[] = [];
  if (!inp.arv) unverified.push("arv");
  if (!inp.repairEstimate) unverified.push("repairEstimate");
  const fee = inp.targetFee ?? DEFAULTS.fee;
  const arv = inp.arv ?? 0;
  const repairs = inp.repairEstimate ?? 0;
  // Standard flip rule: MAO = 70% of ARV - repairs - fee.
  const mao = Math.min(arv * 0.7 - repairs - fee, inp.listPrice);
  const discountRate = motivationDiscount(inp.dom, inp.priceCuts);
  const suggestedContract = Math.round(inp.listPrice * (1 - discountRate));
  // MAO already nets out the fee: contracting at MAO yields exactly the fee;
  // contracting below MAO adds spread on top of it.
  const totalSpread = Math.round(fee + (mao - suggestedContract));
  return {
    mode: "flip",
    mao: Math.round(mao),
    suggestedContract,
    assignmentFee: totalSpread,
    discountRate,
    grade: gradeForFee(totalSpread),
    assumptions: { arvRule: "70% of ARV", repairs, targetFee: fee },
    unverified,
    explanation: [
      `Flip MAO = 70% x ARV $${arv.toLocaleString()} - repairs $${repairs.toLocaleString()} - fee $${fee.toLocaleString()} = $${Math.round(mao).toLocaleString()} (capped at list).`,
      `Contracting at $${suggestedContract.toLocaleString()} (${(discountRate * 100).toFixed(0)}% motivation discount) yields total spread $${totalSpread.toLocaleString()}.`
    ]
  };
}

function underwriteLand(inp: UnderwritingInputs): UnderwritingResult {
  const unverified: string[] = [];
  if (!inp.landCompValue) unverified.push("landCompValue");
  const fee = inp.targetFee ?? DEFAULTS.fee;
  const comp = inp.landCompValue ?? inp.listPrice;
  // Land: buyers pay a fraction of finished-lot comp value; default 50% minus fee.
  const mao = Math.min(comp * 0.5 - fee, inp.listPrice);
  const discountRate = motivationDiscount(inp.dom, inp.priceCuts);
  const suggestedContract = Math.round(inp.listPrice * (1 - discountRate));
  const spread = Math.round(mao + fee - suggestedContract);
  return {
    mode: "land",
    mao: Math.round(mao),
    suggestedContract,
    assignmentFee: spread,
    discountRate,
    grade: gradeForFee(spread),
    assumptions: { landFactor: 0.5, targetFee: fee },
    unverified,
    explanation: [
      `Land MAO = 50% x comp value $${comp.toLocaleString()} - fee $${fee.toLocaleString()} = $${Math.round(mao).toLocaleString()} (capped at list).`,
      `Contracting at $${suggestedContract.toLocaleString()} yields spread $${spread.toLocaleString()}.`
    ]
  };
}

function underwriteTraditional(inp: UnderwritingInputs): UnderwritingResult {
  // Traditional wholesale: the end buyer pays a percentage of ARV, all-in.
  // ceiling = min(pct x ARV, list) is the buyer's all-in max (v3.2: the
  // list clamp is the hard invariant — the ceiling never exceeds list);
  // the contract (MAO) must
  // leave room for repairs plus the target fee inside that ceiling. The fee
  // is the OUTPUT: contracting at MAO leaves exactly the target fee, and the
  // MAO cap at list price can push the realized fee above it.
  const unverified: string[] = [];
  if (!inp.arv) unverified.push("arv");
  if (!inp.repairEstimate) unverified.push("repairEstimate");
  const fee = inp.targetFee ?? DEFAULTS.fee;
  const pct = inp.wholesalePercent ?? 0.7;
  const arv = inp.arv ?? 0;
  const repairs = inp.repairEstimate ?? 0;
  const rawCeiling = pct * arv;
  // v3.2 hard invariant: the buyer ceiling can never exceed list price.
  const ceiling =
    inp.listPrice > 0 ? Math.min(rawCeiling, inp.listPrice) : rawCeiling;
  const ceilingBinding =
    ceiling < rawCeiling ? "List price" : "Wholesale % × ARV";
  const rawMao = ceiling - repairs - fee;
  const capped = inp.listPrice > 0 ? Math.min(rawMao, inp.listPrice) : rawMao;
  const mao = Math.max(0, capped);
  const assignmentFee = Math.round(ceiling - repairs - mao);
  const discountRate = motivationDiscount(inp.dom, inp.priceCuts);
  return {
    mode: "traditional",
    buyerCeiling: Math.round(ceiling),
    ceilingBinding,
    mao: Math.round(mao),
    suggestedContract: Math.round(mao),
    initialOffer: Math.round(mao),
    assignmentFee,
    discountRate,
    grade: gradeForFee(assignmentFee),
    assumptions: { wholesalePercent: pct, arv, repairs, targetFee: fee },
    unverified,
    explanation: [
      `Buyer ceiling = ${(pct * 100).toFixed(0)}% x ARV $${arv.toLocaleString()} = $${Math.round(rawCeiling).toLocaleString()} (all-in)${ceiling < rawCeiling ? `, clamped at list price $${inp.listPrice.toLocaleString()} — the ceiling never exceeds list` : ""} -> $${Math.round(ceiling).toLocaleString()}.`,
      `MAO = ceiling - repairs $${repairs.toLocaleString()} - fee $${fee.toLocaleString()} = $${Math.round(rawMao).toLocaleString()}${rawMao > inp.listPrice ? `, capped at list $${inp.listPrice.toLocaleString()}` : ""}${rawMao < 0 ? ", floored at $0" : ""} -> $${Math.round(mao).toLocaleString()}.`,
      `Traditional offers go in at the number: initial offer = MAO = $${Math.round(mao).toLocaleString()}. Fee at that contract = $${assignmentFee.toLocaleString()}, grade ${gradeForFee(assignmentFee)}.`,
    ],
  };
}

export function underwrite(inp: UnderwritingInputs): UnderwritingResult {
  switch (inp.mode) {
    case "flip": return underwriteFlip(inp);
    case "land": return underwriteLand(inp);
    case "traditional": return underwriteTraditional(inp);
    default: return underwriteTurnkey(inp);
  }
}

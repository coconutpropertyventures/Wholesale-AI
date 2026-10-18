"use client";

import { useState } from "react";
import type { DealMode, UnderwritingResult } from "@/lib/underwriting/model";
import type { DealPrefill } from "@/lib/deals/prefill";
import {
  firstMessageTemplate,
  offerMessage,
  personalize,
} from "@/lib/comms/scripts";
import {
  createDraft,
  createOutcome,
  draftOfferAi,
  fmtMoney,
  fmtPct,
  lookupListing,
  searchRedfinListings,
  verifyRentcast,
  type VerifyResult,
} from "@/components/api";

/**
 * Property Workbench — the top of the page.
 * 1. Listing data: paste a Zillow/Redfin link (Apify, cache-first) or run
 *    a Redfin search and load a result card — both prefill the form.
 * 2. Underwriting for the page-level mode (Turnkey / Traditional
 *    Wholesale / Land), full transparent result with UNVERIFIED flags.
 * 3. Realtor messages: "Draft first message" (approved opener template,
 *    NO offer number) and "Draft offer message" (after intake; template
 *    or AI-personalized). Saving creates a Draft + a learning-loop
 *    outcome row. Nothing sends from this panel.
 * 4. RentCast verification — visible only when the deal is marked under
 *    contract; the server enforces the gate regardless.
 */

const INPUT_LABELS: Record<string, string> = {
  monthlyRent: "Monthly rent",
  annualTaxes: "Annual taxes",
  annualInsurance: "Annual insurance",
  marketValue: "Market value (MV)",
  arv: "ARV",
  repairEstimate: "Repair estimate",
  landCompValue: "Land comp value",
};

const ASSUMPTION_LABELS: Record<string, string> = {
  vacancy: "Vacancy",
  management: "Management",
  maintenance: "Maintenance",
  capex: "Capex reserve",
  targetCapRate: "Target cap rate",
  targetFee: "Target fee",
  annualTaxes: "Annual taxes used",
  annualInsurance: "Annual insurance used",
  arvRule: "ARV rule",
  repairs: "Repairs",
  landFactor: "Land factor",
  wholesalePercent: "Wholesale % of ARV",
  arv: "ARV",
};

type Fields = {
  address: string;
  agentFirstName: string;
  street: string;
  listPrice: string;
  monthlyRent: string;
  annualTaxes: string;
  annualInsurance: string;
  monthlyHoa: string;
  marketValue: string;
  dom: string;
  priceCuts: string;
  arv: string;
  repairEstimate: string;
  wholesalePct: string;
  landCompValue: string;
};

const EMPTY: Fields = {
  address: "",
  agentFirstName: "",
  street: "",
  listPrice: "",
  monthlyRent: "",
  annualTaxes: "",
  annualInsurance: "",
  monthlyHoa: "",
  marketValue: "",
  dom: "",
  priceCuts: "",
  arv: "",
  repairEstimate: "",
  wholesalePct: "70",
  landCompValue: "",
};

interface ListingFacts {
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  sourceLabel: string;
}

function num(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

function assumptionValue(v: number | string): string {
  if (typeof v === "string") return v;
  if (v > 0 && v < 1) return fmtPct(v);
  return fmtMoney(v);
}

const MODE_TITLES: Record<string, string> = {
  turnkey: "Turnkey rental",
  traditional: "Traditional wholesale",
  land: "Vacant land",
  flip: "Fix & flip",
};

export default function DealPanel({ mode }: { mode: DealMode }) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [result, setResult] = useState<UnderwritingResult | null>(null);
  const [uwError, setUwError] = useState<string | null>(null);
  const [uwBusy, setUwBusy] = useState(false);

  // Listing data state
  const [linkUrl, setLinkUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [facts, setFacts] = useState<ListingFacts | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<DealPrefill[]>([]);

  // Message drafting state
  const [offerOverride, setOfferOverride] = useState("");
  const [offerText, setOfferText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [intakeReceived, setIntakeReceived] = useState(false);
  const [pendingVariant, setPendingVariant] = useState<"first" | "offer" | null>(null);
  const [pendingOffer, setPendingOffer] = useState<number | undefined>(undefined);
  const [savedSignature, setSavedSignature] = useState("");
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  // RentCast verification state
  const [underContract, setUnderContract] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  function set<K extends keyof Fields>(key: K, value: string) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  function onAddressBlur() {
    if (!f.street.trim() && f.address.includes(",")) {
      set("street", f.address.split(",")[0].trim());
    } else if (!f.street.trim()) {
      set("street", f.address.trim());
    }
  }

  // ---------- Underwriting ----------

  function buildBody(fields: Fields): Record<string, unknown> | null {
    const listPrice = num(fields.listPrice);
    if (listPrice === undefined || listPrice <= 0) return null;
    const body: Record<string, unknown> = { mode, listPrice };
    const put = (key: string, v: number | undefined) => {
      if (v !== undefined) body[key] = v;
    };
    put("dom", num(fields.dom));
    put("priceCuts", num(fields.priceCuts));
    if (mode === "turnkey") {
      put("monthlyRent", num(fields.monthlyRent));
      put("annualTaxes", num(fields.annualTaxes));
      put("annualInsurance", num(fields.annualInsurance));
      put("monthlyHoa", num(fields.monthlyHoa));
      put("marketValue", num(fields.marketValue));
    } else if (mode === "traditional" || mode === "flip") {
      put("arv", num(fields.arv));
      put("repairEstimate", num(fields.repairEstimate));
      if (mode === "traditional") {
        const pct = num(fields.wholesalePct);
        if (pct !== undefined) body.wholesalePercent = pct / 100;
      }
    } else if (mode === "land") {
      put("landCompValue", num(fields.landCompValue));
    }
    return body;
  }

  async function runWith(fields: Fields) {
    setUwError(null);
    const body = buildBody(fields);
    if (!body) {
      setUwError("List price is required and must be a positive number.");
      return;
    }
    setUwBusy(true);
    try {
      const res = await fetch("/api/underwrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg =
          (data as { error?: string })?.error ??
          `Underwriting failed (${res.status})`;
        throw new Error(msg);
      }
      setResult(data as UnderwritingResult);
      setOfferOverride("");
    } catch (err) {
      setResult(null);
      setUwError(err instanceof Error ? err.message : String(err));
    } finally {
      setUwBusy(false);
    }
  }

  // ---------- Listing data ----------

  function applyPrefill(p: DealPrefill, sourceLabel: string) {
    const next: Fields = {
      ...f,
      address: p.address ?? f.address,
      street:
        f.street.trim() ||
        (p.address ? p.address.split(",")[0].trim() : f.street),
      listPrice: p.listPrice !== undefined ? str(p.listPrice) : f.listPrice,
      monthlyRent:
        p.rentEstimate !== undefined ? str(p.rentEstimate) : f.monthlyRent,
      marketValue:
        p.valueEstimate !== undefined ? str(p.valueEstimate) : f.marketValue,
      arv:
        mode === "traditional" && p.valueEstimate !== undefined
          ? str(p.valueEstimate)
          : f.arv,
      dom: p.daysOnMarket !== undefined ? str(p.daysOnMarket) : f.dom,
    };
    setF(next);
    setFacts({
      beds: p.beds,
      baths: p.baths,
      sqft: p.sqft,
      yearBuilt: p.yearBuilt,
      sourceLabel,
    });
    return next;
  }

  async function runLinkLookup() {
    if (!linkUrl.trim()) return;
    setLinkBusy(true);
    setLinkNote(null);
    setLinkError(null);
    try {
      const res = await lookupListing(linkUrl.trim());
      if (!res.ok || !res.prefill) {
        throw new Error(res.reason ?? "Lookup failed.");
      }
      applyPrefill(
        res.prefill,
        res.prefill.source === "redfin" ? "Redfin listing data" : "Zillow listing data",
      );
      if (res.configured === false) {
        setLinkNote(
          "Listing data is not configured on the server (no Apify token) — only the address from the link was prefilled. Everything else is UNVERIFIED.",
        );
      } else if (res.found === false) {
        setLinkNote(
          "No listing match found — only the address from the link was prefilled.",
        );
      } else {
        setLinkNote(
          res.cached
            ? "Prefilled from cached listing data (pulled once, not re-billed)."
            : "Prefilled from listing data.",
        );
      }
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkBusy(false);
    }
  }

  async function runSearch() {
    if (!searchQuery.trim()) return;
    setSearchBusy(true);
    setSearchNote(null);
    setSearchError(null);
    setSearchResults([]);
    try {
      const res = await searchRedfinListings(searchQuery.trim());
      if (!res.ok) throw new Error(res.reason ?? "Search failed.");
      if (res.configured === false) {
        setSearchNote(
          "Redfin search is not configured on the server (no Apify token). No results are shown rather than invented ones.",
        );
        return;
      }
      setSearchResults(res.results);
      setSearchNote(
        res.results.length === 0
          ? "No listings returned for that search."
          : `${res.results.length} listing${res.results.length === 1 ? "" : "s"} — “Run underwriting” loads one into the calculator from the cache.`,
      );
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchBusy(false);
    }
  }

  async function loadAndUnderwrite(p: DealPrefill) {
    const next = applyPrefill(p, "Redfin search result");
    await runWith(next);
  }

  // ---------- Messages ----------

  const pencils =
    result !== null && result.assignmentFee > 0 && result.mao > 0;

  function currentOffer(): number | undefined {
    if (!result) return undefined;
    const override = num(offerOverride);
    return override ?? result.initialOffer ?? result.suggestedContract;
  }

  function requireAgentFields(): boolean {
    if (!f.agentFirstName.trim() || !f.street.trim()) {
      setOfferError("Agent first name and street are required to draft a message.");
      return false;
    }
    return true;
  }

  function draftFirstMessage() {
    setOfferError(null);
    setSaveNote(null);
    if (!requireAgentFields()) return;
    const text = personalize(firstMessageTemplate(mode), {
      first: f.agentFirstName.trim(),
      street: f.street.trim(),
    });
    setOfferText(text);
    setPendingVariant("first");
    setPendingOffer(undefined);
  }

  function fillOfferTemplate() {
    const offer = currentOffer();
    if (offer === undefined) return;
    const text = offerMessage(
      f.agentFirstName.trim(),
      f.street.trim(),
      fmtMoney(offer),
    );
    setOfferText(text);
    setPendingVariant("offer");
    setPendingOffer(offer);
  }

  function draftOfferTemplate() {
    setOfferError(null);
    setSaveNote(null);
    if (!requireAgentFields()) return;
    if (!intakeReceived) {
      setOfferError("Offer messages go out after intake — tick “Intake answers received” first.");
      return;
    }
    setOfferBusy(true);
    try {
      fillOfferTemplate();
    } finally {
      setOfferBusy(false);
    }
  }

  async function draftOfferAiFlow() {
    setOfferError(null);
    setSaveNote(null);
    if (!requireAgentFields()) return;
    if (!intakeReceived) {
      setOfferError("Offer messages go out after intake — tick “Intake answers received” first.");
      return;
    }
    if (!recipient.trim()) {
      setOfferError("Recipient (phone or email) is required for the AI draft — it saves straight into the drafts queue.");
      return;
    }
    const offer = currentOffer();
    if (offer === undefined || !result) return;
    setAiBusy(true);
    try {
      const res = await draftOfferAi({
        address: f.address.trim() || f.street.trim(),
        street: f.street.trim(),
        first: f.agentFirstName.trim(),
        offer,
        mode,
        fee: result.assignmentFee,
        to: recipient.trim(),
      });
      if (res.ok && res.text) {
        setOfferText(res.text);
        setPendingVariant(null);
        setSavedSignature(res.text);
        const cost = res.usage?.estCostUsd;
        setSaveNote(
          `AI draft saved to the queue${res.model ? ` (${res.model}${cost !== undefined ? ` · est. $${cost.toFixed(4)}` : ""})` : ""}. It will NOT send — approve it in the Drafts list.`,
        );
        window.dispatchEvent(new Event("drafts:refresh"));
      } else if (res.configured === false) {
        setSaveNote("AI drafting is not configured on the server (no Anthropic key) — filled the approved template instead.");
        fillOfferTemplate();
      } else if (res.reason === "budget") {
        setSaveNote("This month's AI drafting budget is used up — filled the approved template instead.");
        fillOfferTemplate();
      } else {
        setSaveNote("AI drafting failed — filled the approved template instead.");
        fillOfferTemplate();
      }
    } catch (err) {
      setOfferError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  }

  async function saveDraft() {
    setOfferError(null);
    setSaveNote(null);
    if (!offerText.trim()) {
      setOfferError("Draft or write a message before saving.");
      return;
    }
    if (offerText === savedSignature) {
      setOfferError("This exact text is already saved as a draft.");
      return;
    }
    if (!recipient.trim()) {
      setOfferError("Recipient (phone or email) is required to save a draft.");
      return;
    }
    setSaveBusy(true);
    try {
      const draft = await createDraft({
        feed: "ghl",
        to: recipient.trim(),
        body: offerText,
      });
      // Learning-loop seed: log workbench drafts with their deal context.
      if (pendingVariant) {
        try {
          await createOutcome({
            draftId: draft.id,
            address: f.address.trim() || f.street.trim(),
            mode,
            variant: pendingVariant,
            body: offerText,
            offerAmount: pendingVariant === "offer" ? pendingOffer : undefined,
          });
        } catch {
          // logging must never block the draft itself
        }
      }
      setSavedSignature(offerText);
      setPendingVariant(null);
      setSaveNote(
        "Draft saved. It will NOT send from here — approve it in the Drafts list below to queue it for the sending flow.",
      );
      window.dispatchEvent(new Event("drafts:refresh"));
    } catch (err) {
      setOfferError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaveBusy(false);
    }
  }

  // ---------- RentCast verification ----------

  async function runVerify() {
    if (!f.address.trim()) {
      setVerifyError("Enter the property address first.");
      return;
    }
    setVerifyBusy(true);
    setVerify(null);
    setVerifyError(null);
    try {
      const res = await verifyRentcast(f.address.trim());
      setVerify(res);
      if (!res.ok && res.reason && res.reason !== "not_under_contract") {
        setVerifyError(res.reason);
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyBusy(false);
    }
  }

  function applyVerification() {
    if (!verify?.data) return;
    if (verify.data.valueEstimate !== undefined) {
      set("marketValue", str(verify.data.valueEstimate));
    }
    if (verify.data.rentEstimate !== undefined) {
      set("monthlyRent", str(verify.data.rentEstimate));
    }
  }

  const isHouseArv = mode === "traditional" || mode === "flip";

  return (
    <section className="card workbench" aria-label="Property workbench">
      <h2>
        Property Workbench — {MODE_TITLES[mode] ?? mode}
      </h2>

      <h3>Listing data</h3>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="dp-link">Paste a Zillow or Redfin link</label>
          <div className="inline-row">
            <input
              id="dp-link"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://www.zillow.com/homedetails/…"
            />
            <button
              className="btn secondary"
              onClick={() => void runLinkLookup()}
              disabled={linkBusy || !linkUrl.trim()}
            >
              {linkBusy ? "Pulling…" : "Autopopulate"}
            </button>
          </div>
        </div>
        <div className="field full">
          <label htmlFor="dp-search">Redfin search (city, ZIP, or address)</label>
          <div className="inline-row">
            <input
              id="dp-search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Indianapolis, IN 46225"
            />
            <button
              className="btn secondary"
              onClick={() => void runSearch()}
              disabled={searchBusy || !searchQuery.trim()}
            >
              {searchBusy ? "Searching…" : "Search Redfin"}
            </button>
          </div>
        </div>
      </div>
      {linkNote && <p className="small">{linkNote}</p>}
      {linkError && <div className="error">{linkError}</div>}
      {searchNote && <p className="small">{searchNote}</p>}
      {searchError && <div className="error">{searchError}</div>}

      {searchResults.length > 0 && (
        <div className="search-cards">
          {searchResults.map((p, i) => (
            <div className="search-card" key={`${p.address ?? i}-${i}`}>
              <div className="search-card-addr">{p.address ?? "Unknown address"}</div>
              <div className="search-card-meta">
                {p.listPrice !== undefined && <span>{fmtMoney(p.listPrice)}</span>}
                {p.beds !== undefined && <span>{p.beds} bd</span>}
                {p.baths !== undefined && <span>{p.baths} ba</span>}
                {p.sqft !== undefined && <span>{p.sqft.toLocaleString()} sqft</span>}
                {p.daysOnMarket !== undefined && <span>{p.daysOnMarket} DOM</span>}
                {p.valueEstimate !== undefined && (
                  <span>Est. {fmtMoney(p.valueEstimate)}</span>
                )}
              </div>
              <button
                className="btn"
                onClick={() => void loadAndUnderwrite(p)}
                disabled={uwBusy}
              >
                Run underwriting
              </button>
            </div>
          ))}
        </div>
      )}

      <h3>Underwriting</h3>
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="dp-address">Property address</label>
          <input
            id="dp-address"
            value={f.address}
            onChange={(e) => set("address", e.target.value)}
            onBlur={onAddressBlur}
            placeholder="2309 S Meridian St, Indianapolis, IN 46225"
          />
        </div>
        <div className="field">
          <label htmlFor="dp-list">List price ($)</label>
          <input
            id="dp-list"
            inputMode="decimal"
            value={f.listPrice}
            onChange={(e) => set("listPrice", e.target.value)}
            placeholder="154900"
          />
        </div>
        {mode === "turnkey" && (
          <>
            <div className="field">
              <label htmlFor="dp-rent">Monthly rent ($)</label>
              <input id="dp-rent" inputMode="decimal" value={f.monthlyRent} onChange={(e) => set("monthlyRent", e.target.value)} placeholder="2150" />
            </div>
            <div className="field">
              <label htmlFor="dp-mv">Market value / MV ($)</label>
              <input id="dp-mv" inputMode="decimal" value={f.marketValue} onChange={(e) => set("marketValue", e.target.value)} placeholder="215000" />
            </div>
            <div className="field">
              <label htmlFor="dp-taxes">Annual taxes ($)</label>
              <input id="dp-taxes" inputMode="decimal" value={f.annualTaxes} onChange={(e) => set("annualTaxes", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-ins">Annual insurance ($)</label>
              <input id="dp-ins" inputMode="decimal" value={f.annualInsurance} onChange={(e) => set("annualInsurance", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-hoa">Monthly HOA ($)</label>
              <input id="dp-hoa" inputMode="decimal" value={f.monthlyHoa} onChange={(e) => set("monthlyHoa", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-dom">Days on market</label>
              <input id="dp-dom" inputMode="numeric" value={f.dom} onChange={(e) => set("dom", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-cuts">Price cuts</label>
              <input id="dp-cuts" inputMode="numeric" value={f.priceCuts} onChange={(e) => set("priceCuts", e.target.value)} />
            </div>
          </>
        )}
        {isHouseArv && (
          <>
            <div className="field">
              <label htmlFor="dp-arv">ARV ($)</label>
              <input id="dp-arv" inputMode="decimal" value={f.arv} onChange={(e) => set("arv", e.target.value)} placeholder="215000" />
            </div>
            <div className="field">
              <label htmlFor="dp-repairs">Repair estimate ($)</label>
              <input id="dp-repairs" inputMode="decimal" value={f.repairEstimate} onChange={(e) => set("repairEstimate", e.target.value)} />
            </div>
            {mode === "traditional" && (
              <div className="field">
                <label htmlFor="dp-pct">Buyer all-in % of ARV</label>
                <input id="dp-pct" inputMode="decimal" value={f.wholesalePct} onChange={(e) => set("wholesalePct", e.target.value)} placeholder="70" />
              </div>
            )}
            <div className="field">
              <label htmlFor="dp-dom">Days on market</label>
              <input id="dp-dom" inputMode="numeric" value={f.dom} onChange={(e) => set("dom", e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="dp-cuts">Price cuts</label>
              <input id="dp-cuts" inputMode="numeric" value={f.priceCuts} onChange={(e) => set("priceCuts", e.target.value)} />
            </div>
          </>
        )}
        {mode === "land" && (
          <div className="field">
            <label htmlFor="dp-land">Land comp value ($)</label>
            <input id="dp-land" inputMode="decimal" value={f.landCompValue} onChange={(e) => set("landCompValue", e.target.value)} />
          </div>
        )}
      </div>
      {facts && (
        <p className="small facts-line">
          <span className="badge ok">via {facts.sourceLabel}</span>{" "}
          {facts.beds !== undefined && <>{facts.beds} bd · </>}
          {facts.baths !== undefined && <>{facts.baths} ba · </>}
          {facts.sqft !== undefined && <>{facts.sqft.toLocaleString()} sqft · </>}
          {facts.yearBuilt !== undefined && <>built {facts.yearBuilt}</>}
        </p>
      )}
      <div className="btn-row">
        <button className="btn" onClick={() => void runWith(f)} disabled={uwBusy}>
          {uwBusy ? "Running…" : "Run underwriting"}
        </button>
      </div>
      {uwError && <div className="error">{uwError}</div>}

      {result && (
        <div>
          <h3>
            Result — {result.mode}{" "}
            <span className="badge grade">Grade {result.grade}</span>
          </h3>
          <div className="kpis">
            {result.noi !== undefined && (
              <div className="kpi">
                <div className="k">NOI / yr</div>
                <div className="v">{fmtMoney(result.noi)}</div>
              </div>
            )}
            {result.buyerCeiling !== undefined && (
              <div className="kpi">
                <div className="k">
                  {result.mode === "traditional" ? "Buyer ceiling (all-in)" : "Buyer ceiling"}
                </div>
                <div className="v">{fmtMoney(result.buyerCeiling)}</div>
              </div>
            )}
            <div className="kpi">
              <div className="k">MAO (max contract)</div>
              <div className="v">{fmtMoney(result.mao)}</div>
            </div>
            <div className="kpi hero">
              <div className="k">
                {result.mode === "turnkey"
                  ? "Initial offer (list − 10%, after intake)"
                  : result.mode === "traditional"
                    ? "Initial offer (= MAO)"
                    : "Suggested offer"}
              </div>
              <div className="v">
                {fmtMoney(result.initialOffer ?? result.suggestedContract)}
              </div>
            </div>
            <div className="kpi">
              <div className="k">Assignment fee / spread</div>
              <div className="v">{fmtMoney(result.assignmentFee)}</div>
            </div>
            {result.capRateAtContract !== undefined && (
              <div className="kpi">
                <div className="k">Cap rate at offer</div>
                <div className="v">{fmtPct(result.capRateAtContract, 2)}</div>
              </div>
            )}
          </div>
          {result.mode === "turnkey" && result.buyerCeiling !== undefined && (
            <div className="offer-override">
              <label>
                Offer to make (override the calculator any time)
                <input
                  inputMode="numeric"
                  placeholder={String(result.initialOffer ?? result.suggestedContract)}
                  value={offerOverride}
                  onChange={(e) => setOfferOverride(e.target.value)}
                />
              </label>
              <button type="button" onClick={() => setOfferOverride(String(result.mao))}>
                Use MAO
              </button>
              {result.modeledContract !== undefined && (
                <button
                  type="button"
                  onClick={() => setOfferOverride(String(result.modeledContract))}
                >
                  Use modeled contract
                </button>
              )}
              <span className="fee-at-offer">
                Fee at your offer:{" "}
                {fmtMoney(
                  result.buyerCeiling -
                    (offerOverride.trim() !== "" && Number.isFinite(Number(offerOverride))
                      ? Number(offerOverride)
                      : result.initialOffer ?? result.suggestedContract),
                )}
              </span>
            </div>
          )}
          <table className="kv">
            <tbody>
              {result.modeledContract !== undefined && result.mode === "turnkey" && (
                <tr>
                  <td>Modeled contract (motivation-based)</td>
                  <td>{fmtMoney(result.modeledContract)}</td>
                </tr>
              )}
              <tr>
                <td>Motivation discount</td>
                <td>{fmtPct(result.discountRate)}</td>
              </tr>
              {Object.entries(result.assumptions).map(([k, v]) => (
                <tr key={k}>
                  <td>{ASSUMPTION_LABELS[k] ?? k}</td>
                  <td>{assumptionValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="explain">
            {result.explanation.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {result.unverified.length > 0 && (
            <div className="unverified-box">
              <strong>Unverified inputs</strong> — estimated or not sourced;
              verify before relying on this case:
              <ul>
                {result.unverified.map((name) => (
                  <li key={name}>
                    {INPUT_LABELS[name] ?? name}{" "}
                    <span className="badge unverified">UNVERIFIED</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <h3>Realtor message</h3>
      {!result && (
        <p className="muted">Run underwriting first — message drafts unlock when the deal pencils.</p>
      )}
      {result && !pencils && (
        <p className="muted">
          Doesn&apos;t pencil at these numbers (fee {fmtMoney(result.assignmentFee)}, MAO{" "}
          {fmtMoney(result.mao)}) — no first message generated.
        </p>
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="dp-first">Listing agent first name</label>
          <input id="dp-first" value={f.agentFirstName} onChange={(e) => set("agentFirstName", e.target.value)} placeholder="Debra" />
        </div>
        <div className="field">
          <label htmlFor="dp-street">Street (for outreach)</label>
          <input id="dp-street" value={f.street} onChange={(e) => set("street", e.target.value)} placeholder="2309 S Meridian St" />
        </div>
        <div className="field full">
          <label htmlFor="dp-recipient">Recipient (phone or email)</label>
          <input id="dp-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="+1 317-555-0100" />
        </div>
      </div>
      <label className="check intake-check">
        <input
          type="checkbox"
          checked={intakeReceived}
          onChange={(e) => setIntakeReceived(e.target.checked)}
        />
        Intake answers received (offer messages unlock)
      </label>
      <div className="btn-row">
        <button className="btn secondary" onClick={draftFirstMessage} disabled={!pencils}>
          Draft first message
        </button>
        <button
          className="btn secondary"
          onClick={draftOfferTemplate}
          disabled={!pencils || !intakeReceived || offerBusy}
        >
          Draft offer message
        </button>
        <button
          className="btn"
          onClick={() => void draftOfferAiFlow()}
          disabled={!pencils || !intakeReceived || aiBusy}
        >
          {aiBusy ? "Drafting…" : "Draft offer message (AI)"}
        </button>
      </div>
      <div className="field full" style={{ marginTop: 10 }}>
        <label htmlFor="dp-offer">Message (editable)</label>
        <textarea
          id="dp-offer"
          className="ta"
          value={offerText}
          onChange={(e) => setOfferText(e.target.value)}
          placeholder="Draft a first or offer message, then edit freely before saving."
        />
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => void saveDraft()} disabled={saveBusy}>
          {saveBusy ? "Saving…" : "Save draft"}
        </button>
      </div>
      {saveNote && (
        <p className="small" style={{ color: "var(--accent)" }}>
          {saveNote}
        </p>
      )}
      {offerError && <div className="error">{offerError}</div>}
      <p className="muted">
        Saving stores the draft only. Sending requires approval in the
        Drafts list — nothing sends from this panel. First messages never
        carry an offer number; offer messages go out only after intake.
      </p>

      <h3>Under-contract verification (RentCast)</h3>
      <label className="check intake-check">
        <input
          type="checkbox"
          checked={underContract}
          onChange={(e) => {
            setUnderContract(e.target.checked);
            setVerify(null);
            setVerifyError(null);
          }}
        />
        This deal is under contract
      </label>
      {underContract && (
        <div>
          <div className="btn-row">
            <button
              className="btn secondary"
              onClick={() => void runVerify()}
              disabled={verifyBusy}
            >
              {verifyBusy ? "Verifying…" : "Verify with RentCast"}
            </button>
          </div>
          {verifyError && <div className="error">{verifyError}</div>}
          {verify && !verify.ok && verify.reason === "not_under_contract" && (
            <p className="small">
              No under-contract opportunity in HighLevel matches this
              address, so RentCast was not called. RentCast is reserved for
              deals under contract.
            </p>
          )}
          {verify?.ok && verify.configured === false && (
            <p className="small">
              This deal matches an under-contract opportunity, but RentCast
              is not configured on the server (no RENTCAST_API_KEY) — no
              verification was pulled.
            </p>
          )}
          {verify?.ok && verify.data && (
            <div className="verify-box">
              <span className="badge ok">
                RentCast (under-contract verification){verify.cached ? " · cached" : ""}
              </span>
              <div className="kpis" style={{ marginTop: 8 }}>
                {verify.data.valueEstimate !== undefined && (
                  <div className="kpi">
                    <div className="k">Value estimate</div>
                    <div className="v">{fmtMoney(verify.data.valueEstimate)}</div>
                  </div>
                )}
                {verify.data.rentEstimate !== undefined && (
                  <div className="kpi">
                    <div className="k">Rent estimate / mo</div>
                    <div className="v">{fmtMoney(verify.data.rentEstimate)}</div>
                  </div>
                )}
              </div>
              <div className="btn-row">
                <button className="btn secondary" onClick={applyVerification}>
                  Apply to calculator
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

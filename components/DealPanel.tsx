"use client";

import { useState } from "react";
import type { UnderwritingResult } from "@/lib/underwriting/model";
import { fmtMoney, fmtPct } from "@/components/api";

/**
 * Property intake + transparent underwriting + offer draft.
 * The form posts to /api/underwrite and renders the full result — KPIs,
 * assumptions, explanation, and UNVERIFIED flags on estimated inputs.
 * The offer section generates Bradley's approved opener via /api/offers
 * into an editable textarea; saving posts to /api/ghl/drafts. Nothing
 * sends from this panel.
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
};

type Fields = {
  address: string;
  agentFirstName: string;
  street: string;
  mode: string;
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
  landCompValue: string;
};

const EMPTY: Fields = {
  address: "",
  agentFirstName: "",
  street: "",
  mode: "turnkey",
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
  landCompValue: "",
};

function num(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function assumptionValue(v: number | string): string {
  if (typeof v === "string") return v;
  if (v > 0 && v < 1) return fmtPct(v);
  return fmtMoney(v);
}

export default function DealPanel() {
  const [f, setF] = useState<Fields>(EMPTY);
  const [result, setResult] = useState<UnderwritingResult | null>(null);
  const [uwError, setUwError] = useState<string | null>(null);
  const [uwBusy, setUwBusy] = useState(false);

  const [offerOverride, setOfferOverride] = useState("");
  const [offerText, setOfferText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  function set<K extends keyof Fields>(key: K, value: string) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  function onAddressBlur() {
    // The outreach street defaults to the first segment of the address.
    if (!f.street.trim() && f.address.includes(",")) {
      set("street", f.address.split(",")[0].trim());
    } else if (!f.street.trim()) {
      set("street", f.address.trim());
    }
  }

  async function runUnderwriting() {
    setUwError(null);
    const listPrice = num(f.listPrice);
    if (listPrice === undefined || listPrice <= 0) {
      setUwError("List price is required and must be a positive number.");
      return;
    }
    const body: Record<string, unknown> = { mode: f.mode, listPrice };
    const optionals: [keyof Fields, string][] = [
      ["monthlyRent", "monthlyRent"],
      ["annualTaxes", "annualTaxes"],
      ["annualInsurance", "annualInsurance"],
      ["monthlyHoa", "monthlyHoa"],
      ["marketValue", "marketValue"],
      ["dom", "dom"],
      ["priceCuts", "priceCuts"],
      ["arv", "arv"],
      ["repairEstimate", "repairEstimate"],
      ["landCompValue", "landCompValue"],
    ];
    for (const [field, key] of optionals) {
      const v = num(f[field]);
      if (v !== undefined) body[key] = v;
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

  async function generateOffer() {
    setOfferError(null);
    setSaveNote(null);
    if (!f.agentFirstName.trim() || !f.street.trim()) {
      setOfferError(
        "Agent first name and street are required to generate the opener.",
      );
      return;
    }
    setOfferBusy(true);
    try {
      const res = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: f.agentFirstName.trim(),
          street: f.street.trim(),
        }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const msg =
          (data as { error?: string })?.error ??
          `Offer generation failed (${res.status})`;
        throw new Error(msg);
      }
      setOfferText((data as { message: string }).message);
    } catch (err) {
      setOfferError(err instanceof Error ? err.message : String(err));
    } finally {
      setOfferBusy(false);
    }
  }

  async function saveDraft() {
    setOfferError(null);
    setSaveNote(null);
    if (!offerText.trim()) {
      setOfferError("Generate or write a message before saving a draft.");
      return;
    }
    if (!recipient.trim()) {
      setOfferError(
        "Recipient (phone or email) is required to save a draft.",
      );
      return;
    }
    setSaveBusy(true);
    try {
      const res = await fetch("/api/ghl/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feed: "ghl",
          to: recipient.trim(),
          body: offerText,
        }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          (data as { error?: string } | null)?.error ??
          `Save failed (${res.status})`;
        throw new Error(msg);
      }
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

  return (
    <section className="card" aria-label="Property intake and underwriting">
      <h2>Property Intake &amp; Underwriting</h2>
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
          <label htmlFor="dp-mode">Mode</label>
          <select
            id="dp-mode"
            value={f.mode}
            onChange={(e) => set("mode", e.target.value)}
          >
            <option value="turnkey">Turnkey rental</option>
            <option value="flip">Fix &amp; flip</option>
            <option value="land">Vacant land</option>
          </select>
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
        <div className="field">
          <label htmlFor="dp-rent">Monthly rent ($)</label>
          <input
            id="dp-rent"
            inputMode="decimal"
            value={f.monthlyRent}
            onChange={(e) => set("monthlyRent", e.target.value)}
            placeholder="2150"
          />
        </div>
        <div className="field">
          <label htmlFor="dp-mv">Market value / MV ($)</label>
          <input
            id="dp-mv"
            inputMode="decimal"
            value={f.marketValue}
            onChange={(e) => set("marketValue", e.target.value)}
            placeholder="215000"
          />
        </div>
        <div className="field">
          <label htmlFor="dp-taxes">Annual taxes ($)</label>
          <input
            id="dp-taxes"
            inputMode="decimal"
            value={f.annualTaxes}
            onChange={(e) => set("annualTaxes", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-ins">Annual insurance ($)</label>
          <input
            id="dp-ins"
            inputMode="decimal"
            value={f.annualInsurance}
            onChange={(e) => set("annualInsurance", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-hoa">Monthly HOA ($)</label>
          <input
            id="dp-hoa"
            inputMode="decimal"
            value={f.monthlyHoa}
            onChange={(e) => set("monthlyHoa", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-dom">Days on market</label>
          <input
            id="dp-dom"
            inputMode="numeric"
            value={f.dom}
            onChange={(e) => set("dom", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-cuts">Price cuts</label>
          <input
            id="dp-cuts"
            inputMode="numeric"
            value={f.priceCuts}
            onChange={(e) => set("priceCuts", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-arv">ARV — flip ($)</label>
          <input
            id="dp-arv"
            inputMode="decimal"
            value={f.arv}
            onChange={(e) => set("arv", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-repairs">Repair estimate — flip ($)</label>
          <input
            id="dp-repairs"
            inputMode="decimal"
            value={f.repairEstimate}
            onChange={(e) => set("repairEstimate", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="dp-land">Land comp value — land ($)</label>
          <input
            id="dp-land"
            inputMode="decimal"
            value={f.landCompValue}
            onChange={(e) => set("landCompValue", e.target.value)}
          />
        </div>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => void runUnderwriting()} disabled={uwBusy}>
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
                <div className="k">Buyer ceiling</div>
                <div className="v">{fmtMoney(result.buyerCeiling)}</div>
              </div>
            )}
            <div className="kpi">
              <div className="k">MAO (max contract)</div>
              <div className="v">{fmtMoney(result.mao)}</div>
            </div>
            <div className="kpi hero">
              <div className="k">
                {result.initialOffer !== undefined
                  ? "Initial offer (list − 10%, after intake)"
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
          {result.buyerCeiling !== undefined && (
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
                      : result.initialOffer ?? result.suggestedContract)
                )}
              </span>
            </div>
          )}
          <table className="kv">
            <tbody>
              {result.modeledContract !== undefined && (
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

      <h3>Offer Draft</h3>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="dp-first">Listing agent first name</label>
          <input
            id="dp-first"
            value={f.agentFirstName}
            onChange={(e) => set("agentFirstName", e.target.value)}
            placeholder="Debra"
          />
        </div>
        <div className="field">
          <label htmlFor="dp-street">Street (for outreach)</label>
          <input
            id="dp-street"
            value={f.street}
            onChange={(e) => set("street", e.target.value)}
            placeholder="2309 S Meridian St"
          />
        </div>
        <div className="field full">
          <label htmlFor="dp-recipient">Recipient (phone or email)</label>
          <input
            id="dp-recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="+1 317-555-0100"
          />
        </div>
      </div>
      <div className="btn-row">
        <button
          className="btn secondary"
          onClick={() => void generateOffer()}
          disabled={offerBusy}
        >
          {offerBusy ? "Generating…" : "Generate opener"}
        </button>
      </div>
      <div className="field full" style={{ marginTop: 10 }}>
        <label htmlFor="dp-offer">Message (editable)</label>
        <textarea
          id="dp-offer"
          className="ta"
          value={offerText}
          onChange={(e) => setOfferText(e.target.value)}
          placeholder="Generate the approved turnkey opener, then edit freely before saving."
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
        Drafts list — nothing sends from this panel.
      </p>
    </section>
  );
}

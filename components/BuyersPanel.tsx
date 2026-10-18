"use client";

import { useMemo, useState } from "react";

/**
 * Buyer database (milestone 1: seed list).
 * These are DEMO records to show the shape of the buyer book — real buyers
 * sync from HighLevel contacts in a later milestone. Labeled DEMO.
 */
interface DemoBuyer {
  name: string;
  lane: string;
  criteria: string;
  markets: string;
}

const DEMO_BUYERS: DemoBuyer[] = [
  {
    name: "Demo Buyer — Turnkey Landlord A",
    lane: "Turnkey rental",
    criteria: "3+ bd SFR, $150K–$250K all-in, 5%+ cap at ask, rent $1,800+/mo",
    markets: "Indianapolis, IN",
  },
  {
    name: "Demo Buyer — Turnkey Landlord B",
    lane: "Turnkey rental",
    criteria: "Move-in ready only, minor cosmetic OK, long-term hold",
    markets: "Memphis / Southaven, MS",
  },
  {
    name: "Demo Buyer — Fix & Flip",
    lane: "Flip",
    criteria: "Buys at ~70% of ARV minus repairs; closes in 14 days",
    markets: "Atlanta metro, GA",
  },
  {
    name: "Demo Buyer — Land",
    lane: "Vacant land",
    criteria: "Buildable lots near growth corridors; quick close",
    markets: "Georgia (Augusta, Columbus, Macon)",
  },
];

export default function BuyersPanel() {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DEMO_BUYERS;
    return DEMO_BUYERS.filter((b) =>
      [b.name, b.lane, b.criteria, b.markets]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  return (
    <section className="card" aria-label="Buyers">
      <h2>
        Buyers <span className="badge demo">DEMO data</span>
      </h2>
      <div className="field" style={{ marginBottom: 10 }}>
        <label htmlFor="buyers-search">Search buyers</label>
        <input
          id="buyers-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="lane, market, criteria…"
        />
      </div>
      {filtered.length === 0 && (
        <p className="muted">No demo buyers match that search.</p>
      )}
      {filtered.map((b) => (
        <div className="buyer" key={b.name}>
          <div className="name">
            {b.name} <span className="badge demo">DEMO</span>
          </div>
          <div className="small">
            <strong>{b.lane}</strong> · {b.markets}
          </div>
          <div className="small muted">{b.criteria}</div>
        </div>
      ))}
      <p className="muted">
        Seed list only — your real buyer book syncs from HighLevel in a later
        milestone.
      </p>
    </section>
  );
}

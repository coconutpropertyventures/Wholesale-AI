"use client";

import { useCallback, useEffect, useState } from "react";
import Header from "@/components/Header";
import PipelineStrip from "@/components/PipelineStrip";
import Inbox from "@/components/Inbox";
import DealPanel from "@/components/DealPanel";
import BlastPanel from "@/components/BlastPanel";
import DraftsPanel from "@/components/DraftsPanel";
import {
  fetchPipelineMap,
  type BlastRunDetailData,
  type PipelineMapData,
} from "@/components/api";
import type { InboxFilter } from "@/lib/ghl/pipelineMap";
import type { DealMode } from "@/lib/underwriting/model";
import type { DealPrefill } from "@/lib/deals/prefill";

/**
 * Wholesale AI — command center (milestone 3 layout).
 * Top to bottom: Header → Property Workbench (listing data + modes +
 * underwriting) → pipeline cards → the full-width unified inbox →
 * blast → drafts. (The old fixed bottom AI command bar was removed —
 * AI drafting now lives per-thread in the inbox: Send + "Draft with
 * AI" under each composer.) Mode ([Houses|Land], Houses:
 * [Turnkey|Traditional Wholesale]) is page state, persisted to
 * localStorage, and passed into the workbench.
 */

type TopMode = "houses" | "land";
type HouseMode = "turnkey" | "traditional";

const LS_TOP = "wai.mode.top";
const LS_HOUSE = "wai.mode.house";

export default function HomePage() {
  const [topMode, setTopMode] = useState<TopMode>("houses");
  const [houseMode, setHouseMode] = useState<HouseMode>("turnkey");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter | null>(null);
  const [pipelineMap, setPipelineMap] = useState<PipelineMapData | null>(null);
  // Workbench properties checked for a blast run — shared between the
  // DealPanel result cards (checkboxes) and the Blast panel (queue source).
  const [selectedListings, setSelectedListings] = useState<DealPrefill[]>([]);
  // A blast run just created from the workbench toolbar — the Blast
  // panel opens it and scrolls into view when this changes.
  const [blastFocus, setBlastFocus] = useState<{
    id: string;
    nonce: number;
  } | null>(null);

  const onBlastRunCreated = useCallback((detail: BlastRunDetailData) => {
    setBlastFocus({ id: detail.run.id, nonce: Date.now() });
  }, []);

  const toggleListing = useCallback(
    (property: DealPrefill, checked: boolean) => {
      setSelectedListings((prev) => {
        const rest = prev.filter((p) => p.address !== property.address);
        return checked ? [...rest, property] : rest;
      });
    },
    [],
  );

  // Restore persisted mode after mount (defaults render identically on
  // the server, so no hydration mismatch).
  useEffect(() => {
    try {
      const top = window.localStorage.getItem(LS_TOP);
      if (top === "houses" || top === "land") setTopMode(top);
      const house = window.localStorage.getItem(LS_HOUSE);
      if (house === "turnkey" || house === "traditional") setHouseMode(house);
    } catch {
      // storage unavailable — defaults stand
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_TOP, topMode);
      window.localStorage.setItem(LS_HOUSE, houseMode);
    } catch {
      // non-fatal
    }
  }, [topMode, houseMode]);

  useEffect(() => {
    let cancelled = false;
    fetchPipelineMap()
      .then((data) => {
        if (!cancelled) setPipelineMap(data);
      })
      .catch(() => {
        if (!cancelled) {
          setPipelineMap({ configured: false, byContact: {}, stageCounts: {} });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: DealMode = topMode === "land" ? "land" : houseMode;

  return (
    <>
      <Header />
      <main className="shell">
        <div className="mode-switch" role="group" aria-label="Deal mode">
          <div className="segmented" role="tablist" aria-label="Property type">
            <button
              role="tab"
              aria-selected={topMode === "houses"}
              className={`seg ${topMode === "houses" ? "active" : ""}`}
              onClick={() => setTopMode("houses")}
            >
              Houses
            </button>
            <button
              role="tab"
              aria-selected={topMode === "land"}
              className={`seg ${topMode === "land" ? "active" : ""}`}
              onClick={() => setTopMode("land")}
            >
              Land
            </button>
          </div>
          {topMode === "houses" && (
            <div className="segmented" role="tablist" aria-label="House strategy">
              <button
                role="tab"
                aria-selected={houseMode === "turnkey"}
                className={`seg ${houseMode === "turnkey" ? "active" : ""}`}
                onClick={() => setHouseMode("turnkey")}
              >
                Turnkey
              </button>
              <button
                role="tab"
                aria-selected={houseMode === "traditional"}
                className={`seg ${houseMode === "traditional" ? "active" : ""}`}
                onClick={() => setHouseMode("traditional")}
              >
                Traditional Wholesale
              </button>
            </div>
          )}
        </div>

        <DealPanel
          mode={mode}
          selectedListings={selectedListings}
          onToggleListing={toggleListing}
          onBlastRunCreated={onBlastRunCreated}
        />

        <PipelineStrip
          pipelineMap={pipelineMap}
          inboxFilter={inboxFilter}
          onSelectFilter={setInboxFilter}
        />

        <Inbox
          pipelineMap={pipelineMap}
          inboxFilter={inboxFilter}
          onClearFilter={() => setInboxFilter(null)}
        />

        <BlastPanel
          pipelineMap={pipelineMap}
          selectedListings={selectedListings}
          onClearSelection={() => setSelectedListings([])}
          focusRun={blastFocus}
        />

        <DraftsPanel />
      </main>
    </>
  );
}

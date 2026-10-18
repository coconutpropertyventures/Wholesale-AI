"use client";

import { useEffect, useState } from "react";
import Header from "@/components/Header";
import PipelineStrip from "@/components/PipelineStrip";
import Inbox from "@/components/Inbox";
import DealPanel from "@/components/DealPanel";
import DraftsPanel from "@/components/DraftsPanel";
import AiCommand from "@/components/AiCommand";
import {
  fetchPipelineMap,
  type PipelineMapData,
} from "@/components/api";
import type { InboxFilter } from "@/lib/ghl/pipelineMap";
import type { DealMode } from "@/lib/underwriting/model";

/**
 * Wholesale AI — command center (milestone 3 layout).
 * Top to bottom: Header → Property Workbench (listing data + modes +
 * underwriting) → pipeline cards → the full-width unified inbox →
 * drafts. The AI command bar is fixed to the bottom of the viewport.
 * Mode ([Houses|Land], Houses: [Turnkey|Traditional Wholesale]) is page
 * state, persisted to localStorage, and passed into the workbench.
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

        <DealPanel mode={mode} />

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

        <DraftsPanel />
      </main>
      <AiCommand />
    </>
  );
}

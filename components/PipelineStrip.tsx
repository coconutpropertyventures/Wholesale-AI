"use client";

import { useEffect, useState } from "react";
import { fetchPipeline, type PipelineData } from "@/components/api";

/**
 * Pipeline stage strip.
 * - HighLevel configured: REAL open-opportunity counts per stage from
 *   /api/ghl/pipeline (summed across pipelines by stage name). No DEMO
 *   badge, no placeholder note — these are live numbers.
 * - Not configured: clearly-labeled DEMO placeholders, never presented
 *   as live data.
 */
const DEMO_STAGES: { stage: string; count: number }[] = [
  { stage: "New Prospect", count: 12 },
  { stage: "Contacted", count: 5 },
  { stage: "Under Contract", count: 1 },
  { stage: "Dispositions", count: 1 },
];

export default function PipelineStrip() {
  const [data, setData] = useState<PipelineData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPipeline()
      .then((v) => {
        if (!cancelled) setData(v);
      })
      .catch(() => {
        if (!cancelled) setData({ configured: false, stages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = data?.configured === true;
  const stages = live ? data.stages : DEMO_STAGES;

  return (
    <section aria-label="Pipeline">
      <div className="pipeline">
        {stages.map(({ stage, count }) => (
          <div className="pipe-col" key={stage}>
            <div className="stage">
              {stage}
              {!live && <span className="badge demo">DEMO</span>}
            </div>
            <div className="count">{count}</div>
          </div>
        ))}
        {live && data.totals && (
          <>
            <div className="pipe-col" key="__won">
              <div className="stage">Won (all time)</div>
              <div className="count">{data.totals.won}</div>
            </div>
            <div className="pipe-col" key="__lost">
              <div className="stage">Lost (all time)</div>
              <div className="count">{data.totals.lost}</div>
            </div>
          </>
        )}
      </div>
      {live && data.stages.length === 0 && (
        <p className="muted" style={{ marginTop: -8 }}>
          HighLevel is connected, but no pipeline stages were returned for
          this location.
        </p>
      )}
    </section>
  );
}

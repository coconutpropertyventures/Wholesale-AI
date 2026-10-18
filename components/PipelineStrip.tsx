"use client";

import { useEffect, useState } from "react";
import {
  fetchPipeline,
  type PipelineData,
  type PipelineMapData,
} from "@/components/api";
import {
  PIPELINE_DEFS,
  shortStageName,
  type InboxFilter,
} from "@/lib/ghl/pipelineMap";

/**
 * Pipeline cards, grouped by pipeline (Pre-Screening / Acquisitions /
 * Dispositions / Wholesale). Counts are live open-opportunity counts from
 * the pipeline map. Clicking a stage card filters the inbox below to the
 * contacts holding opportunities in that stage; clicking it again (or
 * "All conversations") clears. When HighLevel is not configured, clearly
 * labeled DEMO placeholders render instead — never presented as live.
 */
const DEMO_STAGES: { stage: string; count: number }[] = [
  { stage: "New Prospect", count: 12 },
  { stage: "Contacted", count: 5 },
  { stage: "Under Contract", count: 1 },
  { stage: "Dispositions", count: 1 },
];

interface Props {
  pipelineMap: PipelineMapData | null;
  inboxFilter: InboxFilter | null;
  onSelectFilter: (filter: InboxFilter | null) => void;
}

export default function PipelineStrip({
  pipelineMap,
  inboxFilter,
  onSelectFilter,
}: Props) {
  const [totalsData, setTotalsData] = useState<PipelineData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPipeline()
      .then((v) => {
        if (!cancelled) setTotalsData(v);
      })
      .catch(() => {
        if (!cancelled) setTotalsData({ configured: false, stages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = pipelineMap?.configured === true;

  if (!live) {
    return (
      <section aria-label="Pipeline">
        <div className="pipeline">
          {DEMO_STAGES.map(({ stage, count }) => (
            <div className="pipe-col" key={stage}>
              <div className="stage">
                {stage}
                <span className="badge demo">DEMO</span>
              </div>
              <div className="count">{count}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const counts = pipelineMap.stageCounts;

  return (
    <section aria-label="Pipeline" className="pipeline-groups">
      {inboxFilter && (
        <div className="filter-bar">
          <span>
            Inbox filtered to <strong>{inboxFilter.label}</strong> — only
            conversations with people in that stage are shown.
          </span>
          <button
            className="btn ghost"
            onClick={() => onSelectFilter(null)}
          >
            All conversations
          </button>
        </div>
      )}
      {PIPELINE_DEFS.map((pipeline) => (
        <div className="pipe-group" key={pipeline.id}>
          <div className="pipe-group-label">{pipeline.shortName}</div>
          <div className="pipe-cards">
            {pipeline.stages.map((stage) => {
              const count = counts[`${pipeline.id}:${stage.id}`] ?? 0;
              const active =
                inboxFilter?.pipelineId === pipeline.id &&
                inboxFilter?.stageId === stage.id;
              const short = shortStageName(stage.name);
              return (
                <button
                  key={stage.id}
                  className={`pipe-col clickable ${active ? "active" : ""}`}
                  aria-pressed={active}
                  title={`${pipeline.shortName} · ${short} — click to filter the inbox`}
                  onClick={() =>
                    onSelectFilter(
                      active
                        ? null
                        : {
                            pipelineId: pipeline.id,
                            stageId: stage.id,
                            label: `${pipeline.shortName} · ${short}`,
                          },
                    )
                  }
                >
                  <div className="stage">{short}</div>
                  <div className="count">{count}</div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {totalsData?.configured && totalsData.totals && (
        <p className="muted">
          Open {totalsData.totals.open} · Won (all time){" "}
          {totalsData.totals.won} · Lost (all time) {totalsData.totals.lost}
        </p>
      )}
    </section>
  );
}

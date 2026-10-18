"use client";

import { useEffect, useState } from "react";
import { fetchGhlConfigured } from "@/components/api";

/**
 * Pipeline stage strip. Stage counts are DEMO placeholders until the
 * HighLevel opportunities sync lands — they are labeled DEMO whenever
 * shown, and never presented as live numbers.
 */
const DEMO_STAGES: { stage: string; count: number }[] = [
  { stage: "New Prospect", count: 12 },
  { stage: "Contacted", count: 5 },
  { stage: "Under Contract", count: 1 },
  { stage: "Dispositions", count: 1 },
];

export default function PipelineStrip() {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGhlConfigured()
      .then((v) => {
        if (!cancelled) setConfigured(v);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = configured === true;

  return (
    <section aria-label="Pipeline">
      <div className="pipeline">
        {DEMO_STAGES.map(({ stage, count }) => (
          <div className="pipe-col" key={stage}>
            <div className="stage">
              {stage}
              {!live && <span className="badge demo">DEMO</span>}
            </div>
            <div className="count">{live ? "—" : count}</div>
          </div>
        ))}
      </div>
      {live && (
        <p className="muted" style={{ marginTop: -8 }}>
          HighLevel is connected; live stage counts arrive with the
          opportunities sync (next milestone).
        </p>
      )}
    </section>
  );
}

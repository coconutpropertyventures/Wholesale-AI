import { describe, it, expect } from "vitest";
import {
  aggregateStageCounts,
  type GhlPipeline,
} from "../lib/ghl/client";

const PIPELINES: GhlPipeline[] = [
  {
    id: "pipe-1",
    name: "Acquisitions",
    stages: [
      { id: "s1", name: "New Prospect" },
      { id: "s2", name: "Contacted" },
    ],
  },
  {
    id: "pipe-2",
    name: "Dispositions",
    stages: [
      { id: "s3", name: "New Prospect" },
      { id: "s4", name: "Under Contract" },
    ],
  },
];

describe("aggregateStageCounts", () => {
  it("sums counts by stage NAME across pipelines", async () => {
    const counts: Record<string, number> = { s1: 10, s2: 3, s3: 5, s4: 2 };
    const totals = await aggregateStageCounts(
      PIPELINES,
      async (_pipelineId, stageId) => counts[stageId] ?? 0,
    );
    expect(totals.get("New Prospect")).toBe(15);
    expect(totals.get("Contacted")).toBe(3);
    expect(totals.get("Under Contract")).toBe(2);
    expect(totals.size).toBe(3);
  });

  it("returns an empty map for no pipelines", async () => {
    const totals = await aggregateStageCounts([], async () => 7);
    expect(totals.size).toBe(0);
  });

  it("passes the right pipeline/stage pairs to the lookup", async () => {
    const seen: string[] = [];
    await aggregateStageCounts(PIPELINES, async (p, s) => {
      seen.push(`${p}:${s}`);
      return 0;
    });
    expect(seen.sort()).toEqual([
      "pipe-1:s1",
      "pipe-1:s2",
      "pipe-2:s3",
      "pipe-2:s4",
    ]);
  });
});

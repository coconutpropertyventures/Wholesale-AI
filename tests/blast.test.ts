import { describe, expect, it } from "vitest";
import {
  contactStreetKey,
  personalizedBody,
  planBlastItems,
  scriptForKey,
  streetFromListingName,
  type BlastCandidate,
} from "@/lib/blast/build";
import {
  GROUP_PAUSE_SECONDS,
  SEND_CADENCE_SECONDS,
  afterSend,
  decidePacing,
  nextWaitAfterSend,
  planTick,
} from "@/lib/blast/pacing";
import { DISTRESSED_OPENER, TURNKEY_OPENER } from "@/lib/comms/scripts";
import type { BlastRun } from "@/lib/types";

const NOW = Date.parse("2026-10-18T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function run(partial: Partial<BlastRun>): BlastRun {
  return {
    id: "run-1",
    organizationId: "org",
    source: "search",
    scriptKey: "turnkey_opener",
    status: "sending",
    dailyCap: 250,
    groupSentCount: 0,
    createdAt: iso(NOW),
    ...partial,
  };
}

// ---------- Personalization: the exact approved constants ----------

describe("blast scripts", () => {
  it("uses the approved opener constants verbatim", () => {
    expect(scriptForKey("turnkey_opener")).toBe(TURNKEY_OPENER);
    expect(scriptForKey("distressed_opener")).toBe(DISTRESSED_OPENER);
  });

  it("personalizes {first}/{street} and nothing else", () => {
    const body = personalizedBody("turnkey_opener", "Jane", "2309 S Meridian St");
    expect(body).toBe(
      TURNKEY_OPENER.replace("{first}", "Jane").replace(
        "{street}",
        "2309 S Meridian St",
      ),
    );
    expect(body).not.toContain("{first}");
    const distressed = personalizedBody(
      "distressed_opener",
      "Bob",
      "3105 Walker Ave",
    );
    expect(distressed).toContain("3105 Walker Ave");
    expect(distressed.startsWith("Hi Bob,")).toBe(true);
  });
});

// ---------- Street helpers ----------

describe("streetFromListingName", () => {
  it("takes the street before the first comma", () => {
    expect(
      streetFromListingName("2309 S Meridian St, Indianapolis, IN 46225"),
    ).toBe("2309 S Meridian St");
  });
  it("strips lane suffixes", () => {
    expect(streetFromListingName("3105 Walker Ave (distressed)")).toBe(
      "3105 Walker Ave",
    );
    expect(
      streetFromListingName("9115 E Washington St, Indianapolis, IN (turnkey)"),
    ).toBe("9115 E Washington St");
  });
});

// ---------- Queue builder exclusions ----------

describe("planBlastItems", () => {
  const candidate = (partial: Partial<BlastCandidate>): BlastCandidate => ({
    contactId: "c1",
    contactName: "Jane Agent",
    firstName: "Jane",
    opportunityId: "o1",
    street: "2309 S Meridian St",
    phone: "+1 (317) 555-0100",
    ...partial,
  });
  const emptyCtx = () => ({
    suppressedPhones: new Set<string>(),
    activeKeys: new Set<string>(),
    recentKeys: new Set<string>(),
  });

  it("queues a clean candidate", () => {
    const { items, counts } = planBlastItems([candidate({})], emptyCtx());
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("queued");
    expect(counts.ready).toBe(1);
  });

  it("marks a phoneless candidate missing_phone — never invents a number", () => {
    const { items, counts } = planBlastItems(
      [candidate({ phone: undefined, contactId: undefined })],
      emptyCtx(),
    );
    expect(items[0].status).toBe("missing_phone");
    expect(items[0].phone).toBeUndefined();
    expect(counts.noPhone).toBe(1);
    expect(counts.ready).toBe(0);
  });

  it("excludes suppressed phones (format-insensitive)", () => {
    const ctx = emptyCtx();
    ctx.suppressedPhones.add("3175550100");
    const { items, counts } = planBlastItems([candidate({})], ctx);
    expect(items[0].status).toBe("skipped_suppressed");
    expect(counts.suppressed).toBe(1);
  });

  it("excludes pairs already in an active run", () => {
    const ctx = emptyCtx();
    ctx.activeKeys.add(contactStreetKey("c1", "2309 S Meridian St"));
    const { items, counts } = planBlastItems([candidate({})], ctx);
    expect(items[0].status).toBe("skipped_active");
    expect(counts.active).toBe(1);
  });

  it("excludes pairs sent within 30 days", () => {
    const ctx = emptyCtx();
    ctx.recentKeys.add(contactStreetKey("c1", "2309 S Meridian St"));
    const { items, counts } = planBlastItems([candidate({})], ctx);
    expect(items[0].status).toBe("skipped_recent");
    expect(counts.recent).toBe(1);
  });

  it("dedupes the same contact+street within one build", () => {
    const { items, counts } = planBlastItems(
      [candidate({}), candidate({ opportunityId: "o2" })],
      emptyCtx(),
    );
    expect(items).toHaveLength(1);
    expect(counts.duplicate).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("keeps the same contact for a different street", () => {
    const { items, counts } = planBlastItems(
      [candidate({}), candidate({ street: "411 Gimber Ct", opportunityId: "o9" })],
      emptyCtx(),
    );
    expect(items).toHaveLength(2);
    expect(counts.ready).toBe(2);
  });
});

// ---------- Pacing gate ----------

describe("decidePacing", () => {
  it("allows the first send of an approved run", () => {
    expect(decidePacing(run({ status: "approved" }), 0, NOW)).toEqual({
      kind: "ok",
    });
  });

  it("refuses runs that are not approved/sending", () => {
    for (const status of ["draft", "paused", "stopped", "complete"] as const) {
      expect(decidePacing(run({ status }), 0, NOW).kind).toBe("bad_status");
    }
  });

  it("waits out the 45s minimum gap", () => {
    const d = decidePacing(
      run({ lastSentAt: iso(NOW - 20_000), groupSentCount: 3 }),
      3,
      NOW,
    );
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") {
      expect(d.why).toBe("gap");
      expect(d.waitSeconds).toBe(25);
    }
  });

  it("allows a send once the gap has elapsed", () => {
    expect(
      decidePacing(
        run({ lastSentAt: iso(NOW - 46_000), groupSentCount: 3 }),
        3,
        NOW,
      ).kind,
    ).toBe("ok");
  });

  it("enforces the 180s group pause after 10 sends", () => {
    const d = decidePacing(
      run({ lastSentAt: iso(NOW - 60_000), groupSentCount: 10 }),
      10,
      NOW,
    );
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") {
      expect(d.why).toBe("group_pause");
      expect(d.waitSeconds).toBe(120);
    }
  });

  it("opens a new group after the pause elapses", () => {
    expect(
      decidePacing(
        run({
          lastSentAt: iso(NOW - (GROUP_PAUSE_SECONDS + 1) * 1000),
          groupSentCount: 10,
        }),
        10,
        NOW,
      ).kind,
    ).toBe("ok");
  });

  it("caps at the daily limit", () => {
    expect(decidePacing(run({ dailyCap: 250 }), 250, NOW).kind).toBe("capped");
    expect(decidePacing(run({ dailyCap: 5 }), 4, NOW).kind).toBe("ok");
  });
});

describe("send bookkeeping", () => {
  it("counts up within a group and reports the cadence", () => {
    const after = afterSend(
      { groupSentCount: 4, currentGroupStartedAt: iso(NOW - 200_000) },
      iso(NOW),
    );
    expect(after.groupSentCount).toBe(5);
    expect(after.lastSentAt).toBe(iso(NOW));
    expect(after.currentGroupStartedAt).toBe(iso(NOW - 200_000));
    expect(nextWaitAfterSend(after.groupSentCount)).toBe(SEND_CADENCE_SECONDS);
  });

  it("completing a group triggers the group pause; the next send opens a fresh group", () => {
    const after10 = afterSend({ groupSentCount: 9 }, iso(NOW));
    expect(after10.groupSentCount).toBe(10);
    expect(nextWaitAfterSend(10)).toBe(GROUP_PAUSE_SECONDS);
    const fresh = afterSend(
      { groupSentCount: 10, currentGroupStartedAt: iso(NOW - 400_000) },
      iso(NOW),
    );
    expect(fresh.groupSentCount).toBe(1);
    expect(fresh.currentGroupStartedAt).toBe(iso(NOW));
  });
});

// ---------- Tick planning over multiple runs ----------

describe("planTick", () => {
  it("decides per run: send, waiting, cap, idle, paused", () => {
    const plan = planTick(
      [
        { run: run({ id: "due" }), sentToday: 0, hasQueued: true },
        {
          run: run({ id: "soon", lastSentAt: iso(NOW - 10_000), groupSentCount: 2 }),
          sentToday: 2,
          hasQueued: true,
        },
        { run: run({ id: "capped", dailyCap: 10 }), sentToday: 10, hasQueued: true },
        { run: run({ id: "done", status: "sending" }), sentToday: 3, hasQueued: false },
        { run: run({ id: "held", status: "paused" }), sentToday: 0, hasQueued: true },
      ],
      NOW,
    );
    const byId = new Map(plan.map((p) => [p.runId, p]));
    expect(byId.get("due")?.action).toBe("send");
    expect(byId.get("soon")?.action).toBe("waiting");
    expect(byId.get("soon")?.waitSeconds).toBe(35);
    expect(byId.get("capped")?.action).toBe("cap");
    expect(byId.get("done")?.action).toBe("idle");
    expect(byId.get("held")?.action).toBe("paused");
  });

  it("never sends more than one item per run per tick", () => {
    const plan = planTick(
      [{ run: run({ id: "a" }), sentToday: 0, hasQueued: true }],
      NOW,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].action).toBe("send");
  });
});

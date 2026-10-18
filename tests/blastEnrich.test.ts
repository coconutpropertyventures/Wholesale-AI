import { beforeEach, describe, expect, it, vi } from "vitest";

// The enrich step machine: buildBlastRun + enrichBlastRunStep against
// the real store (file backend — vitest.config forces DATABASE_URL="")
// with HighLevel, the property cache, and the Apify async layer
// stubbed. The Apify stub is driven by `hoisted` so a test can walk a
// detail run through RUNNING -> SUCCEEDED / FAILED exactly like the
// panel's polling does in production.

const hoisted = vi.hoisted(() => ({
  apifyStatus: "RUNNING" as string,
  apifyRows: [] as Record<string, unknown>[],
  startInputs: [] as Record<string, unknown>[],
  cachePuts: [] as { key: string; prefill: unknown; source: string }[],
}));

vi.mock("@/lib/ghl/client", () => ({
  ghlConfigured: () => true,
  ghlLocationId: () => "loc-test",
  listOpenOpportunities: async () => [],
  getContact: async () => {
    throw new Error("not used in this test");
  },
  findContactByPhone: async (_loc: string, phone: string) =>
    phone.replace(/\D/g, "").includes("3175500700")
      ? {
          id: "c-tim",
          name: "Timothy Birky",
          firstName: "Timothy",
          phone: "317-550-0700",
        }
      : null,
  createContact: async (args: { phone?: string; name?: string }) => ({
    id: "c-created",
    name: args.name,
    phone: args.phone,
  }),
  createOpportunity: async (args: {
    contactId: string;
    name: string;
    pipelineId: string;
    pipelineStageId: string;
  }) => ({
    id: `opp-${args.contactId}-${args.name.length}`,
    contactId: args.contactId,
    name: args.name,
    pipelineId: args.pipelineId,
    pipelineStageId: args.pipelineStageId,
  }),
  addContactNote: async () => undefined,
  updateOpportunityStage: async () => undefined,
  normalizePhoneDigits: (v?: string) => (v ?? "").replace(/\D/g, ""),
}));

vi.mock("@/lib/deals/cache", () => ({
  getCachedPrefill: async () => null,
  putCachedPrefill: async (key: string, prefill: unknown, source: string) => {
    hoisted.cachePuts.push({ key, prefill, source });
  },
  cacheKey: (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, " "),
}));

vi.mock("@/lib/apify/client", () => ({
  apifyConfigured: () => true,
  redfinDetailActorId: () => "memo23/apify-redfin-cheerio",
  startActorRun: async (_actor: string, input: Record<string, unknown>) => {
    hoisted.startInputs.push(input);
    return { runId: "apify-run-1", datasetId: "ds-1", status: "RUNNING" };
  },
  getActorRun: async () => ({
    runId: "apify-run-1",
    status: hoisted.apifyStatus,
    datasetId: "ds-1",
  }),
  getDatasetItems: async () => hoisted.apifyRows,
}));

vi.mock("@/lib/comms/send", () => ({
  sendApprovedDraft: async () => ({ ok: false, outcome: "not_used" }),
}));

import {
  approveBlastRun,
  buildBlastRun,
  enrichBlastRunStep,
} from "../lib/blast/service";
import type { DealPrefill } from "../lib/deals/prefill";

function detailRow(url: string, agent: Record<string, unknown> | null) {
  return {
    url,
    streetAddress: "1 Detail Way",
    city: "Indianapolis",
    stateOrProvinceCode: "IN",
    postalCode: "46204",
    ...(agent
      ? {
          mlsDisclaimerInfo: agent,
          primaryListingAgentName: agent.listingAgentName,
        }
      : {}),
    // Decoy: Redfin's own touring agent — never the listing agent.
    askAgent: { agent: { name: "Craig McLaurin" }, phoneNumber: "(317) 854-4904" },
    contactPhone: "",
    contactEmail: "",
  };
}

const TIM = {
  listingAgentName: "Timothy Birky",
  listingAgentNumber: "317-550-0700",
  listingBrokerName: "F.C. Tucker Company",
  listingBrokerNumber: "317-843-7766",
};
const NO_PHONE_NANCY = {
  listingAgentName: "No Phone Nancy",
  listingBrokerName: "Some Broker LLC",
  listingBrokerNumber: "317-843-7766",
};

beforeEach(() => {
  hoisted.apifyStatus = "RUNNING";
  hoisted.apifyRows = [];
  hoisted.startInputs = [];
  hoisted.cachePuts = [];
});

describe("buildBlastRun agent-lookup hand-off", () => {
  it("marks URL'd phoneless workbench items enriching; URL-less stay missing_phone", async () => {
    const properties: DealPrefill[] = [
      {
        address: "10 Enrich Alpha St, Indianapolis, IN 46204",
        sourceUrl: "https://www.redfin.com/IN/Indianapolis/alpha/home/1",
        source: "redfin",
      },
      {
        address: "20 Enrich Beta St, Indianapolis, IN 46204",
        sourceUrl: "https://www.redfin.com/IN/Indianapolis/beta/home/2",
        source: "redfin",
      },
      {
        address: "30 Enrich Gamma St, Indianapolis, IN 46204",
        source: "redfin",
      },
    ];
    const detail = await buildBlastRun({
      source: "search",
      properties,
      scriptKey: "turnkey_opener",
    });
    expect(detail.counts.total).toBe(3);
    expect(detail.counts.enriching).toBe(2);
    expect(detail.counts.noPhone).toBe(1);
    const byStreet = new Map(detail.items.map((i) => [i.street, i]));
    expect(byStreet.get("10 Enrich Alpha St")?.status).toBe("enriching");
    expect(byStreet.get("10 Enrich Alpha St")?.sourceUrl).toContain("alpha");
    expect(byStreet.get("30 Enrich Gamma St")?.status).toBe("missing_phone");

    // Approval is refused while lookups are outstanding.
    await expect(approveBlastRun(detail.run.id)).rejects.toThrow(
      /Agent lookup still running/,
    );
  });

  it("autoApprove holds the run as a draft while items enrich", async () => {
    const detail = await buildBlastRun({
      source: "search",
      properties: [
        {
          address: "40 Enrich Delta St, Indianapolis, IN 46204",
          sourceUrl: "https://www.redfin.com/IN/Indianapolis/delta/home/4",
          source: "redfin",
        },
      ],
      scriptKey: "turnkey_opener",
      autoApprove: true,
    });
    expect(detail.counts.enriching).toBe(1);
    expect(detail.run.status).toBe("draft");
    expect(detail.run.note).toContain("Agent lookup");
  });
});

describe("enrichBlastRunStep state machine", () => {
  const URL_A = "https://www.redfin.com/IN/Indianapolis/one/home/11";
  const URL_B = "https://www.redfin.com/IN/Indianapolis/two/home/22";
  // The file-backed store persists across suite executions, and the
  // enrich "applied" path runs the real build-time rails — a leftover
  // (contact, street) pair from a previous run would legitimately
  // exclude the candidate as skipped_active. Unique streets per
  // execution keep the pair space hermetic.
  const uniq = Math.random().toString(36).slice(2, 8);
  const STREET_A = `100 Step One ${uniq} St`;
  const STREET_B = `200 Step Two ${uniq} St`;

  async function buildTwo() {
    return buildBlastRun({
      source: "search",
      properties: [
        {
          address: `${STREET_A}, Indianapolis, IN 46204`,
          sourceUrl: URL_A,
          source: "redfin",
        },
        {
          address: `${STREET_B}, Indianapolis, IN 46204`,
          sourceUrl: URL_B,
          source: "redfin",
        },
      ],
      scriptKey: "turnkey_opener",
    });
  }

  it("start -> running -> applied: one item ready, one missing_phone", async () => {
    const built = await buildTwo();
    expect(built.counts.enriching).toBe(2);

    // Step 1: starts ONE detail run with plain-string startUrls.
    const started = await enrichBlastRunStep(built.run.id);
    expect(started.phase).toBe("started");
    expect(started.pending).toBe(2);
    expect(started.run.enrichRunId).toBe("apify-run-1");
    expect(hoisted.startInputs).toHaveLength(1);
    expect(hoisted.startInputs[0].startUrls).toEqual([URL_A, URL_B]);

    // Step 2: still running — nothing resolves yet.
    const running = await enrichBlastRunStep(built.run.id);
    expect(running.phase).toBe("running");
    expect(running.pending).toBe(2);
    expect(running.counts.enriching).toBe(2);

    // Step 3: succeeded — rows applied. A has the agent's direct
    // number; B's detail names the agent but no number (the broker
    // office line must NOT be substituted).
    hoisted.apifyStatus = "SUCCEEDED";
    hoisted.apifyRows = [detailRow(URL_A, TIM), detailRow(URL_B, NO_PHONE_NANCY)];
    const applied = await enrichBlastRunStep(built.run.id);
    expect(applied.phase).toBe("applied");
    expect(applied.resolved).toBe(1);
    expect(applied.missing).toBe(1);
    expect(applied.pending).toBe(0);
    expect(applied.run.enrichRunId).toBeUndefined();

    const byStreet = new Map(applied.items.map((i) => [i.street, i]));
    const a = byStreet.get(STREET_A);
    expect(a?.status).toBe("queued");
    expect(a?.contactId).toBe("c-tim");
    expect(a?.phone).toBe("317-550-0700");
    const b = byStreet.get(STREET_B);
    expect(b?.status).toBe("missing_phone");
    expect(b?.error).toContain("no agent phone");
    expect(b?.phone).toBeUndefined();

    // The enriched record was merged into the property cache.
    const put = hoisted.cachePuts.find((p) => p.source === "apify-detail");
    expect(put).toBeDefined();
    expect((put?.prefill as DealPrefill).agentPhone).toBe("317-550-0700");
    expect((put?.prefill as DealPrefill).agentName).toBe("Timothy Birky");

    // With the lookup finished, the approval gate lifts.
    const approved = await approveBlastRun(built.run.id);
    expect(approved.run.status).toBe("approved");

    // And a further step is a no-op.
    const idle = await enrichBlastRunStep(built.run.id);
    expect(idle.phase).toBe("idle");
    expect(idle.pending).toBe(0);
  });

  it("failed detail run: enriching items fall back to missing_phone", async () => {
    const built = await buildBlastRun({
      source: "search",
      properties: [
        {
          address: "300 Fail Whale St, Indianapolis, IN 46204",
          sourceUrl: "https://www.redfin.com/IN/Indianapolis/fail/home/33",
          source: "redfin",
        },
      ],
      scriptKey: "turnkey_opener",
    });
    const started = await enrichBlastRunStep(built.run.id);
    expect(started.phase).toBe("started");

    hoisted.apifyStatus = "FAILED";
    const failed = await enrichBlastRunStep(built.run.id);
    expect(failed.phase).toBe("failed");
    expect(failed.missing).toBe(1);
    expect(failed.pending).toBe(0);
    expect(failed.run.enrichRunId).toBeUndefined();
    expect(failed.items[0].status).toBe("missing_phone");
    expect(failed.items[0].error).toContain("Agent lookup failed");
  });
});

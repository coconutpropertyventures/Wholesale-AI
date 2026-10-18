import { describe, expect, it, vi } from "vitest";

// buildBlastRun talks to HighLevel and the property cache; both are
// mocked so the test exercises only the run-building + approval
// lifecycle against the real store (file backend in tests —
// vitest.config forces DATABASE_URL=""). The single test property
// has NO agent phone, so no contact/opportunity writes can happen:
// it lands as a visible missing_phone item, exactly like production.
vi.mock("@/lib/ghl/client", () => ({
  ghlConfigured: () => true,
  ghlLocationId: () => "loc-test",
  listOpenOpportunities: async () => [],
  getContact: async () => {
    throw new Error("not used in this test");
  },
  findContactByPhone: async () => null,
  createContact: async () => {
    throw new Error("must not create contacts for phoneless properties");
  },
  createOpportunity: async () => {
    throw new Error("must not create opportunities for phoneless properties");
  },
  addContactNote: async () => undefined,
  updateOpportunityStage: async () => undefined,
  normalizePhoneDigits: (v?: string) => (v ?? "").replace(/\D/g, ""),
}));

vi.mock("@/lib/deals/cache", () => ({
  getCachedPrefill: async () => null,
}));

vi.mock("@/lib/comms/send", () => ({
  sendApprovedDraft: async () => ({ sent: false, outcome: "not_used" }),
}));

import { buildBlastRun } from "../lib/blast/service";
import type { DealPrefill } from "../lib/deals/prefill";

const PHONELESS: DealPrefill[] = [
  { address: "123 Test Blast Way, Indianapolis, IN 46201", source: "redfin" },
];

describe("buildBlastRun autoApprove (workbench 'Send to all')", () => {
  it("review path (default): run is created as a draft", async () => {
    const detail = await buildBlastRun({
      source: "search",
      properties: PHONELESS,
      scriptKey: "turnkey_opener",
    });
    expect(detail.run.status).toBe("draft");
    expect(detail.counts.total).toBe(1);
    expect(detail.counts.noPhone).toBe(1);
    expect(detail.items[0].status).toBe("missing_phone");
  });

  it("autoApprove: true: run is created already approved, exclusions intact", async () => {
    const detail = await buildBlastRun({
      source: "search",
      properties: PHONELESS,
      scriptKey: "turnkey_opener",
      autoApprove: true,
    });
    expect(detail.run.status).toBe("approved");
    // Safety exclusions still applied at build time: the phoneless
    // property is excluded, not queued.
    expect(detail.counts.total).toBe(1);
    expect(detail.counts.queued).toBe(0);
    expect(detail.counts.noPhone).toBe(1);
    expect(detail.items[0].status).toBe("missing_phone");
  });
});

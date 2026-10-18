import { describe, expect, it } from "vitest";
import { selectModel } from "../lib/ai/modelSelect";

// Stage ids from the live pipeline map (see lib/ghl/pipelineMap.ts).
const NEW_PROSPECT = "b6db489b-8214-4f32-8cdc-3d2404747b3b"; // Pre-Screening
const NEGOTIATING = "3658f3b1-ec00-4161-b191-81449a236e8e"; // Acquisitions
const OFFERS_MADE = "fbd1a3ad-31fb-4030-b63c-88dbd4e4c61f"; // Acquisitions
const DISPO_AVAILABLE = "241ead91-e3c7-49e2-ba0c-be46d8e7a60f"; // Dispositions
const WHOLESALE_UNDER_CONTRACT = "3091dd5c-b4a1-481d-8d37-a62ff4ea247f";

describe("selectModel — context-dependent drafting model", () => {
  it("routine pre-deal reply -> haiku", () => {
    const s = selectModel({
      isDeal: false,
      stageIds: [NEW_PROSPECT],
      intent: "reply",
    });
    expect(s.model).toBe("haiku");
    expect(s.reason).toBe("routine pre-deal communication");
  });

  it("routine follow-up with no context -> haiku", () => {
    const s = selectModel({ intent: "followup" });
    expect(s.model).toBe("haiku");
    expect(s.reason).toBe("routine pre-deal communication");
  });

  it("deal contact -> sonnet with reason", () => {
    const s = selectModel({
      isDeal: true,
      stageIds: [DISPO_AVAILABLE],
      intent: "reply",
    });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toBe("deal under contract");
  });

  it("contract stage alone (no isDeal flag) -> sonnet, deal under contract", () => {
    const s = selectModel({
      stageIds: [WHOLESALE_UNDER_CONTRACT],
      intent: "reply",
    });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toBe("deal under contract");
  });

  it("negotiation stage -> sonnet, negotiation stage", () => {
    const s = selectModel({ stageIds: [NEGOTIATING], intent: "reply" });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toBe("negotiation stage");
  });

  it("offers-made stage -> sonnet", () => {
    const s = selectModel({ stageIds: [OFFERS_MADE], intent: "followup" });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toBe("negotiation stage");
  });

  it("offer intent -> sonnet even for a brand-new prospect", () => {
    const s = selectModel({
      isDeal: false,
      stageIds: [NEW_PROSPECT],
      intent: "offer",
    });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toBe("offer message");
  });

  it("fee at the $25,000 threshold -> sonnet with fee reason", () => {
    const s = selectModel({ intent: "reply", fee: 25_000 });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toContain("fee");
    expect(s.reason).toContain("$25,000");
  });

  it("fee just under the threshold stays haiku", () => {
    const s = selectModel({ intent: "reply", fee: 24_999 });
    expect(s.model).toBe("haiku");
  });

  it("property value at the $200,000 threshold -> sonnet with value reason", () => {
    const s = selectModel({ intent: "reply", monetaryValue: 200_000 });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toContain("property value");
    expect(s.reason).toContain("$200,000");
  });

  it("property value just under the threshold stays haiku", () => {
    const s = selectModel({ intent: "reply", monetaryValue: 199_999 });
    expect(s.model).toBe("haiku");
    expect(s.reason).toBe("routine pre-deal communication");
  });

  it("deal flag wins the reason over fee/value triggers", () => {
    const s = selectModel({
      isDeal: true,
      intent: "reply",
      fee: 40_000,
      monetaryValue: 500_000,
    });
    expect(s.model).toBe("sonnet");
    expect(s.reason).toBe("deal under contract");
  });
});

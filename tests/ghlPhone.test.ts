import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createContact, toE164Phone } from "../lib/ghl/client";

describe("toE164Phone", () => {
  it("converts a dashed 10-digit US number", () => {
    expect(toE164Phone("317-550-0700")).toBe("+13175500700");
  });

  it("converts a parenthesized US number", () => {
    expect(toE164Phone("(317) 550-0700")).toBe("+13175500700");
  });

  it("converts an 11-digit number with country code 1", () => {
    expect(toE164Phone("1-317-550-0700")).toBe("+13175500700");
    expect(toE164Phone("13175500700")).toBe("+13175500700");
  });

  it("leaves an already-E.164 number unchanged", () => {
    expect(toE164Phone("+13175500700")).toBe("+13175500700");
  });

  it("strips formatting from an international + number", () => {
    expect(toE164Phone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("passes a too-short number through trimmed and untouched", () => {
    expect(toE164Phone("  550-0700 ")).toBe("550-0700");
  });

  it("passes an unrecognized shape through untouched", () => {
    expect(toE164Phone("call the office")).toBe("call the office");
  });

  it("returns undefined for undefined", () => {
    expect(toE164Phone(undefined)).toBeUndefined();
  });
});

describe("createContact", () => {
  const prevToken = process.env.GHL_PRIVATE_TOKEN;

  beforeEach(() => {
    process.env.GHL_PRIVATE_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevToken === undefined) delete process.env.GHL_PRIVATE_TOKEN;
    else process.env.GHL_PRIVATE_TOKEN = prevToken;
  });

  it("sends the phone in E.164 form in the request body", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          contact: { id: "contact-123", phone: "+13175500700" },
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const contact = await createContact({
      locationId: "loc-1",
      firstName: "Timothy",
      lastName: "Birky",
      phone: "317-550-0700",
      customFields: [{ id: "field-1", value: "225 N New Jersey St" }],
    });

    expect(contact.id).toBe("contact-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.phone).toBe("+13175500700");
    expect(body.customFields).toEqual([
      { id: "field-1", field_value: "225 N New Jersey St" },
    ]);
  });
});

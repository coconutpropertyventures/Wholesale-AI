import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  findContactByPhone,
  createContact,
  GhlApiError,
} from "../lib/ghl/client";

// findContactByPhone must use GET /contacts/lookup (locationId + E.164
// phone): v2's /contacts/search is POST-only and a GET there 400s — that
// was the live blast agent-resolution failure on 2026-10-18. These tests
// pin the endpoint, the params, the exact-digit filter, and the richer
// ghlFetch error (status + response-body snippet).

const prevToken = process.env.GHL_PRIVATE_TOKEN;

beforeEach(() => {
  process.env.GHL_PRIVATE_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevToken === undefined) delete process.env.GHL_PRIVATE_TOKEN;
  else process.env.GHL_PRIVATE_TOKEN = prevToken;
});

function stubFetch(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    text: async () =>
      typeof payload === "string" ? payload : JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("findContactByPhone", () => {
  it("queries /contacts/lookup with locationId and the E.164 phone", async () => {
    const fetchMock = stubFetch({ contacts: [] });

    await findContactByPhone("loc-1", "317-550-0700");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://services.leadconnectorhq.com/contacts/lookup",
    );
    expect(parsed.searchParams.get("locationId")).toBe("loc-1");
    expect(parsed.searchParams.get("phone")).toBe("+13175500700");
    expect(parsed.searchParams.get("query")).toBeNull();
    expect(init.method ?? "GET").toBe("GET");
  });

  it("returns the contact whose digits match exactly", async () => {
    stubFetch({
      contacts: [
        { id: "near-miss", phone: "+13175500701", firstName: "Not" },
        { id: "match-1", phone: "+13175500700", firstName: "Timothy" },
      ],
    });

    const contact = await findContactByPhone("loc-1", "(317) 550-0700");

    expect(contact?.id).toBe("match-1");
    expect(contact?.firstName).toBe("Timothy");
  });

  it("matches a contact stored without the country code", async () => {
    stubFetch({
      contacts: [{ id: "match-2", phone: "3175500700" }],
    });

    const contact = await findContactByPhone("loc-1", "+1 317 550 0700");

    expect(contact?.id).toBe("match-2");
  });

  it("returns null when the lookup list is empty", async () => {
    stubFetch({ contacts: [] });

    const contact = await findContactByPhone("loc-1", "317-550-0700");

    expect(contact).toBeNull();
  });

  it("does NOT return a contact whose digits differ", async () => {
    stubFetch({
      contacts: [{ id: "other", phone: "+13175500799" }],
    });

    const contact = await findContactByPhone("loc-1", "317-550-0700");

    expect(contact).toBeNull();
  });

  it("returns null without calling the API for a too-short number", async () => {
    const fetchMock = stubFetch({ contacts: [] });

    const contact = await findContactByPhone("loc-1", "550-070");

    expect(contact).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ghlFetch error diagnosability", () => {
  it("includes the status and HighLevel's response body in the error", async () => {
    stubFetch(
      { message: "phone must be a valid phone number", status: 400 },
      false,
      400,
    );

    const err = await createContact({
      locationId: "loc-1",
      phone: "317-550-0700",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GhlApiError);
    expect((err as GhlApiError).status).toBe(400);
    expect((err as Error).message).toContain("HighLevel API error 400");
    expect((err as Error).message).toContain(
      "phone must be a valid phone number",
    );
  });

  it("truncates a long error body to about 200 characters", async () => {
    const longBody = JSON.stringify({ message: "x".repeat(500) });
    stubFetch(longBody, false, 422);

    const err = await createContact({
      locationId: "loc-1",
      phone: "317-550-0700",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GhlApiError);
    const message = (err as Error).message;
    expect(message).toContain("HighLevel API error 422");
    // "HighLevel API error 422: " prefix + at most 200 chars of body.
    expect(message.length).toBeLessThanOrEqual(200 + 30);
    expect(message).not.toContain("x".repeat(300));
  });

  it("propagates lookup failures instead of swallowing them", async () => {
    stubFetch({ message: "Invalid location" }, false, 400);

    await expect(
      findContactByPhone("loc-1", "317-550-0700"),
    ).rejects.toThrow(/HighLevel API error 400/);
  });
});

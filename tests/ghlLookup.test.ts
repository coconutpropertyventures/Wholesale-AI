import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  findContactByPhone,
  createContact,
  GhlApiError,
} from "../lib/ghl/client";

// findContactByPhone must use POST /contacts/search with a
// `phone eq <E.164>` filter (body format verified live on 2026-10-18).
// GET /contacts/search 400s (POST-only), and GET /contacts/lookup —
// which works over OAuth — is mis-routed as /contacts/{id} under the
// app's Private Integration Token auth. These tests pin the method,
// the path, the request body, the exact-digit post-filter, and the
// richer ghlFetch error (status + response-body snippet).

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
  it("POSTs /contacts/search with locationId and a phone eq E.164 filter", async () => {
    const fetchMock = stubFetch({ contacts: [], total: 0 });

    await findContactByPhone("loc-1", "317-550-0700");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://services.leadconnectorhq.com/contacts/search",
    );
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      locationId?: string;
      pageLimit?: number;
      filters?: { field: string; operator: string; value: string }[];
    };
    expect(body.locationId).toBe("loc-1");
    expect(body.pageLimit).toBe(25);
    expect(body.filters).toHaveLength(1);
    expect(body.filters?.[0]).toEqual({
      field: "phone",
      operator: "eq",
      value: "+13175500700",
    });
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

  it("surfaces HighLevel's own error body from a failed search", async () => {
    stubFetch(
      { error: "Contact with id lookup not found" },
      false,
      400,
    );

    const err = await findContactByPhone("loc-1", "317-550-0700").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GhlApiError);
    expect((err as GhlApiError).status).toBe(400);
    expect((err as Error).message).toContain(
      "Contact with id lookup not found",
    );
  });
});

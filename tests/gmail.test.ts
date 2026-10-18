import { describe, it, expect, beforeAll } from "vitest";
import {
  decryptTokens,
  encryptTokens,
  parseGmailMessage,
  summarizeThreads,
} from "../lib/gmail/client";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function gmailFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hello Bradley, the seller may be open",
    internalDate: "1792162440000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Jane Agent <jane@example.com>" },
        { name: "To", value: "offers@coconutpropertyventures.com" },
        { name: "Subject", value: "Re: 2309 S Meridian St" },
        { name: "Date", value: "Fri, 16 Oct 2026 09:54:00 -0400" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: b64url(
              "Hello Bradley,\nThe seller may be open to a number.\n",
            ),
          },
        },
        {
          mimeType: "text/html",
          body: { data: b64url("<p>Hello Bradley,</p>") },
        },
      ],
    },
    ...overrides,
  };
}

describe("parseGmailMessage", () => {
  it("parses headers, sender name/email, and subject", () => {
    const m = parseGmailMessage(gmailFixture());
    expect(m.id).toBe("msg-1");
    expect(m.threadId).toBe("thread-1");
    expect(m.fromName).toBe("Jane Agent");
    expect(m.fromEmail).toBe("jane@example.com");
    expect(m.toEmail).toBe("offers@coconutpropertyventures.com");
    expect(m.subject).toBe("Re: 2309 S Meridian St");
  });

  it("decodes the base64url text/plain part as bodyText (preferred over HTML)", () => {
    const m = parseGmailMessage(gmailFixture());
    expect(m.bodyText).toBe(
      "Hello Bradley,\nThe seller may be open to a number.",
    );
  });

  it("falls back to stripped HTML when no plain part exists", () => {
    const raw = gmailFixture();
    (raw.payload as { parts: unknown[] }).parts = [
      {
        mimeType: "text/html",
        body: { data: b64url("<p>Hello &amp; welcome</p><p>Second</p>") },
      },
    ];
    const m = parseGmailMessage(raw);
    expect(m.bodyText).toBe("Hello & welcome\nSecond");
  });

  it("marks INBOX mail inbound and SENT mail outbound", () => {
    expect(parseGmailMessage(gmailFixture()).direction).toBe("inbound");
    const sent = parseGmailMessage(
      gmailFixture({ labelIds: ["SENT"] }),
    );
    expect(sent.direction).toBe("outbound");
  });

  it("uses the Date header for dateIso", () => {
    const m = parseGmailMessage(gmailFixture());
    expect(m.dateIso).toBe("2026-10-16T13:54:00.000Z");
  });
});

describe("summarizeThreads", () => {
  it("groups by thread, picks the other party, and counts unread inbound", () => {
    const inbound = parseGmailMessage(gmailFixture());
    const outbound = parseGmailMessage(
      gmailFixture({
        id: "msg-2",
        labelIds: ["SENT"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "offers@coconutpropertyventures.com" },
            { name: "To", value: "Jane Agent <jane@example.com>" },
            { name: "Subject", value: "Re: 2309 S Meridian St" },
            { name: "Date", value: "Fri, 16 Oct 2026 10:05:00 -0400" },
          ],
          body: { data: b64url("Thanks Jane — running numbers now.") },
        },
      }),
    );
    const summaries = summarizeThreads([inbound, outbound]);
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.id).toBe("thread-1");
    expect(s.feed).toBe("gmail");
    // Latest message is outbound -> other party is its recipient.
    expect(s.contactId).toBe("jane@example.com");
    expect(s.lastMessageDirection).toBe("outbound");
    expect(s.lastMessageBody).toBe("Thanks Jane — running numbers now.");
    expect(s.unreadCount).toBe(1);
  });
});

describe("token cookie encryption", () => {
  beforeAll(() => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  });

  it("round-trips tokens through AES-256-GCM encryption", () => {
    const tokens = {
      refreshToken: "refresh-123",
      accessToken: "access-456",
      expiresAt: 1792162440000,
      email: "offers@coconutpropertyventures.com",
    };
    const blob = encryptTokens(tokens);
    expect(blob).not.toContain("refresh-123");
    expect(decryptTokens(blob)).toEqual(tokens);
  });

  it("returns null for a tampered blob", () => {
    const blob = encryptTokens({ refreshToken: "refresh-123" });
    const tampered = blob.slice(0, -2) + "AA";
    expect(decryptTokens(tampered)).toBeNull();
    expect(decryptTokens("not-a-token")).toBeNull();
  });
});

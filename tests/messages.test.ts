import { describe, it, expect } from "vitest";
import { sortMessagesAscending } from "../lib/messages";
import type { ConversationMessage } from "../lib/types";

function msg(
  id: string,
  dateAdded: string,
  direction: "inbound" | "outbound" = "inbound",
): ConversationMessage {
  return { id, direction, body: `body-${id}`, dateAdded, type: "SMS" };
}

describe("sortMessagesAscending", () => {
  it("reorders a newest-first GHL thread into chat order (oldest → newest)", () => {
    // HighLevel returns conversation messages newest-first.
    const newestFirst = [
      msg("c", "2026-10-16T13:54:00.000Z"),
      msg("b", "2026-10-15T18:20:00.000Z", "outbound"),
      msg("a", "2026-10-15T14:02:00.000Z", "outbound"),
    ];
    const sorted = sortMessagesAscending(newestFirst);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
    // Newest message is last — it renders at the bottom of the thread.
    expect(sorted[sorted.length - 1].id).toBe("c");
  });

  it("leaves an already-ascending (Gmail) thread in the same order", () => {
    const ascending = [
      msg("a", "2026-10-15T14:02:00.000Z"),
      msg("b", "2026-10-16T09:54:00.000Z"),
      msg("c", "2026-10-16T13:54:00.000Z"),
    ];
    expect(sortMessagesAscending(ascending).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("compares real instants, not strings, across timezone offsets", () => {
    // Gmail maps RFC 2822 dates into ISO with offsets; GHL uses Zulu.
    // 09:54 at -04:00 is 13:54Z — the same instant as the Zulu one, and
    // both are AFTER 12:00Z even though "09:54" sorts earlier as text.
    const mixed = [
      msg("offset", "2026-10-16T09:54:00-04:00"),
      msg("zulu-noon", "2026-10-16T12:00:00.000Z"),
      msg("early", "2026-10-16T08:00:00.000Z"),
    ];
    expect(sortMessagesAscending(mixed).map((m) => m.id)).toEqual([
      "early",
      "zulu-noon",
      "offset",
    ]);
  });

  it("is stable for equal timestamps and does not mutate the input", () => {
    const input = [
      msg("first", "2026-10-16T10:00:00.000Z"),
      msg("second", "2026-10-16T10:00:00.000Z"),
      msg("third", "2026-10-16T09:00:00.000Z"),
    ];
    const snapshot = [...input];
    const sorted = sortMessagesAscending(input);
    expect(sorted.map((m) => m.id)).toEqual(["third", "first", "second"]);
    expect(input).toEqual(snapshot);
    expect(sorted).not.toBe(input);
  });

  it("handles empty and single-message lists", () => {
    expect(sortMessagesAscending([])).toEqual([]);
    const one = [msg("only", "2026-10-16T10:00:00.000Z")];
    expect(sortMessagesAscending(one).map((m) => m.id)).toEqual(["only"]);
  });

  it("does not throw on an unparseable date and stays deterministic", () => {
    const input = [
      msg("bad", "not-a-date"),
      msg("good", "2026-10-16T10:00:00.000Z"),
    ];
    const sorted = sortMessagesAscending(input);
    expect(sorted).toHaveLength(2);
    expect(sortMessagesAscending(input).map((m) => m.id)).toEqual(
      sorted.map((m) => m.id),
    );
  });
});

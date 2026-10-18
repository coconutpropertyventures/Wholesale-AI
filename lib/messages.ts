import type { ConversationMessage } from "@/lib/types";

/**
 * Chat order for thread views: oldest first, newest last (the newest
 * message sits at the very bottom of the thread pane). Both feeds map
 * their messages into ConversationMessage, whose timestamp field is
 * `dateAdded` (an ISO string) — GHL message objects and Gmail messages
 * alike — so one helper normalizes both.
 *
 * Pure and non-mutating: returns a new array, keeps the input order for
 * equal timestamps (stable), and never throws on a malformed date —
 * unparseable values fall back to string comparison, then to the
 * original position.
 */
export function sortMessagesAscending(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const ta = Date.parse(a.message.dateAdded);
      const tb = Date.parse(b.message.dateAdded);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
        return ta - tb;
      }
      if (
        Number.isNaN(ta) !== Number.isNaN(tb) ||
        a.message.dateAdded !== b.message.dateAdded
      ) {
        // One side unparseable, or equal parsed times with different
        // raw strings: ISO strings compare chronologically as text.
        const cmp = String(a.message.dateAdded).localeCompare(
          String(b.message.dateAdded),
        );
        if (cmp !== 0) return cmp;
      }
      return a.index - b.index;
    })
    .map(({ message }) => message);
}

"use client";

import { useEffect, useState } from "react";
import type { Conversation, ConversationMessage, Feed } from "@/lib/types";
import {
  fetchConversationMessages,
  fetchConversations,
  fmtDate,
} from "@/components/api";

/**
 * Unified inbox with three feed tabs.
 * - GHL tab: live conversations from /api/ghl/conversations. When HighLevel
 *   is not configured, a single clearly-labeled DEMO conversation is shown
 *   instead — never presented as real data.
 * - Gmail / Voice tabs: honest setup states. Gmail needs Google OAuth;
 *   Google Voice has no official API, so it is planned as a relay through
 *   Gmail notifications and is flagged accordingly.
 */

const DEMO_CONVERSATION: Conversation = {
  id: "demo-conversation-1",
  organizationId: "demo",
  feed: "ghl",
  contactId: "demo-contact-1",
  contactName: "Demo Agent",
  lastMessageBody:
    "Hi Bradley — the seller may be open to a number. What's your timeline?",
  lastMessageDate: "2026-10-16T13:54:00.000Z",
  lastMessageDirection: "inbound",
  unreadCount: 1,
  messages: [
    {
      id: "demo-msg-1",
      direction: "outbound",
      body: "Hi Demo, I'm Bradley Post, an acquisition partner with Coconut Property Ventures. I work with a network of buyers across the U.S. I saw your listing at 123 Demo Street has been on the market for a while. Is the seller open to negotiating? Reply STOP to unsubscribe.",
      dateAdded: "2026-10-15T14:02:00.000Z",
      type: "SMS",
    },
    {
      id: "demo-msg-2",
      direction: "inbound",
      body: "Hi Bradley — the seller may be open to a number. What's your timeline?",
      dateAdded: "2026-10-16T13:54:00.000Z",
      type: "SMS",
    },
  ],
};

const TABS: { id: Feed; label: string }[] = [
  { id: "ghl", label: "GHL number" },
  { id: "gmail", label: "Gmail" },
  { id: "voice", label: "Google Voice" },
];

export default function Inbox() {
  const [tab, setTab] = useState<Feed>("ghl");
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchConversations()
      .then((data) => {
        if (cancelled) return;
        if (data.configured) {
          setDemo(false);
          setConversations(data.conversations);
        } else {
          setDemo(true);
          setConversations([DEMO_CONVERSATION]);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Endpoint unreachable (e.g. API not up): fall back to the labeled
        // demo rather than a blank panel.
        setDemo(true);
        setConversations([DEMO_CONVERSATION]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected =
    conversations.find((c) => c.id === selectedId) ?? null;

  async function selectConversation(c: Conversation) {
    setSelectedId(c.id);
    if (c.messages && c.messages.length > 0) {
      setMessages(c.messages);
      return;
    }
    if (demo) {
      setMessages([]);
      return;
    }
    setMessages([]);
    setMessagesLoading(true);
    try {
      setMessages(await fetchConversationMessages(c.id));
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }

  return (
    <section className="card" aria-label="Unified inbox">
      <h2>
        Unified Inbox
        {demo && tab === "ghl" && <span className="badge demo">DEMO data</span>}
      </h2>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "gmail" && (
        <div>
          <div className="banner">
            Setup required — Gmail is not connected yet.
          </div>
          <p className="small">
            This feed needs Google OAuth (a Google Cloud project with the
            Gmail API enabled, plus client credentials stored server-side).
            Once connected, offers@ email threads will appear here next to
            your SMS. No email data is shown until then.
          </p>
        </div>
      )}

      {tab === "voice" && (
        <div>
          <div className="banner">
            Setup required — Google Voice has no official API.
          </div>
          <p className="small">
            There is no supported Google Voice API for reading or sending
            texts. The planned approach is a relay: Voice forwards text
            notifications to Gmail, and this feed reads them from there
            (send support is limited and flagged). Until the Gmail relay is
            connected, no Voice messages are shown.
          </p>
        </div>
      )}

      {tab === "ghl" && (
        <div>
          {demo && (
            <div className="banner demo">
              DEMO — HighLevel is not configured on the server, so this is a
              sample conversation with a test contact (&ldquo;Demo
              Agent&rdquo;). Add the HighLevel token via the secure secret
              store to see live conversations. Nothing here is real.
            </div>
          )}
          {loading ? (
            <p className="muted">Loading conversations…</p>
          ) : conversations.length === 0 ? (
            <p className="muted">No conversations found.</p>
          ) : (
            <div className="convo-list">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  className={`convo ${selected?.id === c.id ? "active" : ""}`}
                  onClick={() => void selectConversation(c)}
                >
                  <span className="who">
                    <span>
                      {c.contactName ?? "Unknown contact"}
                      {demo && (
                        <>
                          {" "}
                          <span className="badge demo">DEMO</span>
                        </>
                      )}
                    </span>
                    <span className="when">{fmtDate(c.lastMessageDate)}</span>
                  </span>
                  <span className="preview">
                    {c.lastMessageBody ?? ""}
                    {typeof c.unreadCount === "number" &&
                      c.unreadCount > 0 && (
                        <>
                          {" "}
                          <span className="unread">{c.unreadCount} new</span>
                        </>
                      )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="thread">
              {messagesLoading && (
                <p className="muted">Loading messages…</p>
              )}
              {!messagesLoading && messages.length === 0 && (
                <p className="muted">
                  {demo
                    ? "Select the demo conversation to preview the thread layout."
                    : "No messages loaded for this conversation."}
                </p>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.direction}`}>
                  <div>{m.body}</div>
                  <div className="meta">
                    {m.direction === "inbound" ? "Inbound" : "Outbound"} ·{" "}
                    {m.type} · {fmtDate(m.dateAdded)}
                    {demo && " · DEMO"}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="muted" style={{ marginTop: 10 }}>
            Replies are drafted in the Offer Draft panel and only sent after
            approval — this inbox is read-only.
          </p>
        </div>
      )}
    </section>
  );
}

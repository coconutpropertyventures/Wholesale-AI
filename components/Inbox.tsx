"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation, ConversationMessage, Feed } from "@/lib/types";
import {
  createDraft,
  fetchConversationMessages,
  fetchConversations,
  fetchGmailConversations,
  fetchGmailStatus,
  fetchGmailThread,
  fmtDate,
  type GmailStatus,
} from "@/components/api";

/**
 * Unified inbox with three feed tabs.
 * - GHL tab: live conversations from /api/ghl/conversations. Clicking a
 *   conversation loads its thread; a reply box under the thread saves the
 *   reply as a DRAFT (sending stays in the approval queue). Rows can be
 *   multi-selected to create one personalized draft per contact. When
 *   HighLevel is not configured, a single clearly-labeled DEMO
 *   conversation is shown instead — never presented as real data.
 * - Gmail tab: the user's own Google OAuth connection. Not configured ->
 *   honest setup state; configured but not connected -> a Connect Gmail
 *   button; connected -> real threads with the same draft-reply flow.
 * - Voice tab: honest setup state. Google Voice has no official API, so
 *   it is planned as a relay through Gmail notifications.
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

function DirectionBadge({ direction }: { direction?: string }) {
  if (direction !== "inbound" && direction !== "outbound") return null;
  return (
    <span className={`badge ${direction === "inbound" ? "dir-in" : "dir-out"}`}>
      {direction === "inbound" ? "Inbound" : "Outbound"}
    </span>
  );
}

function ThreadMessages({
  messages,
  demo,
}: {
  messages: ConversationMessage[];
  demo?: boolean;
}) {
  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.direction}`}>
          <div>{m.body}</div>
          <div className="meta">
            {m.direction === "inbound" ? "Inbound" : "Outbound"} · {m.type}{" "}
            · {fmtDate(m.dateAdded)}
            {demo && " · DEMO"}
          </div>
        </div>
      ))}
    </>
  );
}

export default function Inbox() {
  const [tab, setTab] = useState<Feed>("ghl");

  // ----- GHL state -----
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyNote, setReplyNote] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyBusy, setReplyBusy] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const focusReplyOnSelect = useRef(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBody, setBulkBody] = useState("");
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // ----- Gmail state -----
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailConversations, setGmailConversations] = useState<Conversation[]>(
    [],
  );
  const [gmailLoaded, setGmailLoaded] = useState(false);
  const [gmailSelected, setGmailSelected] = useState<Conversation | null>(
    null,
  );
  const [gmailMessages, setGmailMessages] = useState<ConversationMessage[]>(
    [],
  );
  const [gmailMessagesLoading, setGmailMessagesLoading] = useState(false);
  const [gmailSubject, setGmailSubject] = useState<string | undefined>(
    undefined,
  );
  const [gmailReplyBody, setGmailReplyBody] = useState("");
  const [gmailNote, setGmailNote] = useState<string | null>(null);
  const [gmailReplyNote, setGmailReplyNote] = useState<string | null>(null);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailReplyBusy, setGmailReplyBusy] = useState(false);
  const gmailReplyRef = useRef<HTMLTextAreaElement | null>(null);
  const focusGmailReplyOnSelect = useRef(false);

  // Land on the Gmail tab after the OAuth round-trip (?gmail=connected).
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("gmail");
    if (param === "connected") {
      setTab("gmail");
      setGmailNote("Gmail connected.");
    } else if (param === "error") {
      setTab("gmail");
      setGmailError(
        "Gmail connection failed. Try Connect Gmail again; if it keeps failing, check the Google client configuration.",
      );
    } else if (param === "not_configured") {
      setTab("gmail");
    }
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    fetchGmailStatus()
      .then((s) => {
        if (!cancelled) setGmailStatus(s);
      })
      .catch(() => {
        if (!cancelled) setGmailStatus({ configured: false, connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load Gmail conversations the first time the tab is opened connected.
  useEffect(() => {
    if (tab !== "gmail" || !gmailStatus?.connected || gmailLoaded) return;
    let cancelled = false;
    setGmailLoading(true);
    fetchGmailConversations()
      .then((data) => {
        if (cancelled) return;
        setGmailConversations(data.conversations);
        setGmailLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setGmailError(
            err instanceof Error ? err.message : "Gmail load failed.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setGmailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, gmailStatus, gmailLoaded]);

  // Focus the reply box after a "Draft reply" click selects a conversation.
  useEffect(() => {
    if (focusReplyOnSelect.current) {
      focusReplyOnSelect.current = false;
      replyRef.current?.focus();
    }
    if (focusGmailReplyOnSelect.current) {
      focusGmailReplyOnSelect.current = false;
      gmailReplyRef.current?.focus();
    }
  });

  const selected =
    conversations.find((c) => c.id === selectedId) ?? null;

  async function selectConversation(c: Conversation) {
    setSelectedId(c.id);
    setReplyNote(null);
    setReplyError(null);
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

  function draftReplyFor(c: Conversation) {
    focusReplyOnSelect.current = true;
    void selectConversation(c);
  }

  function toggleChecked(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveReplyDraft() {
    if (!selected || replyBody.trim().length === 0) return;
    setReplyBusy(true);
    setReplyNote(null);
    setReplyError(null);
    try {
      await createDraft({
        feed: "ghl",
        contactId: selected.contactId,
        body: replyBody,
      });
      setReplyBody("");
      setReplyNote("Draft saved — approve it in the drafts queue to send.");
      window.dispatchEvent(new Event("drafts:refresh"));
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplyBusy(false);
    }
  }

  async function createBulkDrafts() {
    const targets = conversations.filter((c) => checked.has(c.id));
    if (targets.length === 0 || bulkBody.trim().length === 0) return;
    setBulkBusy(true);
    setBulkNote(null);
    setBulkError(null);
    let created = 0;
    const failedIds: string[] = [];
    let firstError: string | null = null;
    for (const c of targets) {
      try {
        await createDraft({
          feed: "ghl",
          contactId: c.contactId,
          body: bulkBody,
        });
        created += 1;
      } catch (err) {
        failedIds.push(c.id);
        if (!firstError) {
          firstError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    setBulkBusy(false);
    if (created > 0) {
      window.dispatchEvent(new Event("drafts:refresh"));
    }
    if (failedIds.length === 0) {
      setBulkNote(
        `Created ${created} draft${created === 1 ? "" : "s"} — review them in the drafts queue.`,
      );
      setBulkBody("");
      setChecked(new Set());
    } else {
      setBulkError(
        `Created ${created} of ${targets.length} drafts; ${failedIds.length} failed (${firstError ?? "unknown error"}). The failed conversations stay selected.`,
      );
      setChecked(new Set(failedIds));
    }
  }

  async function selectGmailConversation(c: Conversation) {
    setGmailSelected(c);
    setGmailReplyNote(null);
    setGmailError(null);
    setGmailMessages([]);
    setGmailSubject(undefined);
    setGmailMessagesLoading(true);
    try {
      const data = await fetchGmailThread(c.id);
      setGmailMessages(data.messages);
      if (data.conversation) setGmailSelected(data.conversation);
      setGmailSubject(data.subject);
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setGmailMessagesLoading(false);
    }
  }

  async function saveGmailReplyDraft() {
    if (!gmailSelected || gmailReplyBody.trim().length === 0) return;
    setGmailReplyBusy(true);
    setGmailReplyNote(null);
    setGmailError(null);
    const subject = gmailSubject
      ? gmailSubject.toLowerCase().startsWith("re:")
        ? gmailSubject
        : `Re: ${gmailSubject}`
      : "Re:";
    try {
      await createDraft({
        feed: "gmail",
        contactId: gmailSelected.contactId,
        to: gmailSelected.contactId,
        subject,
        threadRef: gmailSelected.id,
        body: gmailReplyBody,
      });
      setGmailReplyBody("");
      setGmailReplyNote(
        "Draft saved — approve it in the drafts queue to send.",
      );
      window.dispatchEvent(new Event("drafts:refresh"));
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setGmailReplyBusy(false);
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
          {gmailNote && <div className="banner ok">{gmailNote}</div>}
          {gmailError && <div className="error">{gmailError}</div>}
          {gmailStatus === null ? (
            <p className="muted">Checking Gmail status…</p>
          ) : !gmailStatus.configured ? (
            <div>
              <div className="banner">
                Setup required — Gmail is not connected yet.
              </div>
              <p className="small">
                This feed uses your own Google Cloud OAuth client: the
                server needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in
                its environment. Until then, no email data is shown.
              </p>
            </div>
          ) : !gmailStatus.connected ? (
            <div>
              <div className="banner">
                Gmail is configured on the server but not connected in this
                browser yet.
              </div>
              <p className="small">
                Connect the offers@ mailbox once — Google will ask you to
                approve read + send access, and the session is stored in an
                encrypted cookie on this device. Threads, replies, and the
                draft queue all work from here afterwards.
              </p>
              <div className="btn-row">
                <a className="btn" href="/api/gmail/connect">
                  Connect Gmail
                </a>
              </div>
            </div>
          ) : (
            <div>
              <p className="small">
                Connected as {gmailStatus.email ?? "your Google account"}.
                Click a thread to read it, then save a reply as a draft —
                sending still goes through the approval queue.
              </p>
              {gmailLoading ? (
                <p className="muted">Loading mail…</p>
              ) : gmailConversations.length === 0 ? (
                <p className="muted">No recent threads found.</p>
              ) : (
                <div className="convo-list">
                  {gmailConversations.map((c) => (
                    <div
                      key={c.id}
                      className={`convo ${gmailSelected?.id === c.id ? "active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => void selectGmailConversation(c)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void selectGmailConversation(c);
                        }
                      }}
                    >
                      <span className="who">
                        <span>{c.contactName ?? "Unknown sender"}</span>
                        <span className="when">
                          {fmtDate(c.lastMessageDate)}
                        </span>
                      </span>
                      <span className="preview">
                        <DirectionBadge direction={c.lastMessageDirection} />{" "}
                        {c.lastMessageBody ?? ""}
                        {typeof c.unreadCount === "number" &&
                          c.unreadCount > 0 && (
                            <>
                              {" "}
                              <span className="unread">
                                {c.unreadCount} new
                              </span>
                            </>
                          )}
                      </span>
                      <span className="row-actions">
                        <button
                          className="btn ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            focusGmailReplyOnSelect.current = true;
                            void selectGmailConversation(c);
                          }}
                        >
                          Draft reply
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {gmailSelected && (
                <div className="thread">
                  {gmailMessagesLoading && (
                    <p className="muted">Loading messages…</p>
                  )}
                  {!gmailMessagesLoading && gmailMessages.length === 0 && (
                    <p className="muted">
                      No messages loaded for this thread.
                    </p>
                  )}
                  <ThreadMessages messages={gmailMessages} />
                  <div className="reply-box">
                    <textarea
                      ref={gmailReplyRef}
                      className="ta"
                      value={gmailReplyBody}
                      onChange={(e) => setGmailReplyBody(e.target.value)}
                      placeholder={`Reply to ${gmailSelected.contactName ?? "this thread"}…`}
                    />
                    <div className="btn-row">
                      <button
                        className="btn"
                        disabled={
                          gmailReplyBusy || gmailReplyBody.trim().length === 0
                        }
                        onClick={() => void saveGmailReplyDraft()}
                      >
                        Save reply as draft
                      </button>
                    </div>
                    {gmailReplyNote && (
                      <p className="small">{gmailReplyNote}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
                <div
                  key={c.id}
                  className={`convo ${selected?.id === c.id ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => void selectConversation(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void selectConversation(c);
                  }}
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
                    <DirectionBadge direction={c.lastMessageDirection} />{" "}
                    {c.lastMessageBody ?? ""}
                    {typeof c.unreadCount === "number" &&
                      c.unreadCount > 0 && (
                        <>
                          {" "}
                          <span className="unread">{c.unreadCount} new</span>
                        </>
                      )}
                  </span>
                  {!demo && (
                    <span className="row-actions">
                      <label
                        className="check"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(c.id)}
                          onChange={() => toggleChecked(c.id)}
                        />
                        Select
                      </label>
                      <button
                        className="btn ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          draftReplyFor(c);
                        }}
                      >
                        Draft reply
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {!demo && checked.size > 0 && (
            <div className="bulk-bar">
              <div className="meta">
                {checked.size} selected — one draft per contact, created in
                the drafts queue (nothing sends from here).
              </div>
              <textarea
                className="ta"
                value={bulkBody}
                onChange={(e) => setBulkBody(e.target.value)}
                placeholder="Message for the selected contacts — {first} is replaced with each contact's first name."
              />
              <div className="btn-row">
                <button
                  className="btn"
                  disabled={bulkBusy || bulkBody.trim().length === 0}
                  onClick={() => void createBulkDrafts()}
                >
                  Create {checked.size} draft{checked.size === 1 ? "" : "s"}
                </button>
                <button
                  className="btn ghost"
                  disabled={bulkBusy}
                  onClick={() => setChecked(new Set())}
                >
                  Clear
                </button>
              </div>
              {bulkNote && <p className="small">{bulkNote}</p>}
              {bulkError && <div className="error">{bulkError}</div>}
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
              <ThreadMessages messages={messages} demo={demo} />
              {!demo && (
                <div className="reply-box">
                  <textarea
                    ref={replyRef}
                    className="ta"
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder={`Reply to ${selected.contactName ?? "this contact"}…`}
                  />
                  <div className="btn-row">
                    <button
                      className="btn"
                      disabled={replyBusy || replyBody.trim().length === 0}
                      onClick={() => void saveReplyDraft()}
                    >
                      Save reply as draft
                    </button>
                  </div>
                  {replyNote && <p className="small">{replyNote}</p>}
                  {replyError && <div className="error">{replyError}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

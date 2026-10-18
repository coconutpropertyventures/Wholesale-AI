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
  type PipelineMapData,
  type PipelineMapEntry,
} from "@/components/api";
import {
  contactMatchesFilter,
  shortStageName,
  type InboxFilter,
} from "@/lib/ghl/pipelineMap";
import { sortMessagesAscending } from "@/lib/messages";

/**
 * Unified inbox, full width, two feed tabs (GHL number + Gmail). Both
 * feeds render iMessage-style: two panes with a scrollable list on the
 * left and a bubble thread on the right.
 * - GHL tab: scrollable contacts list with avatar initials, preview,
 *   blue unread dot, and pipeline badges (stage chip, DEAL chip, +N).
 *   Rows can be multi-selected for per-contact bulk drafts. When a
 *   pipeline card filter is active, only contacts in that stage are
 *   listed. When HighLevel is not configured, a single clearly-labeled
 *   DEMO conversation is shown — never presented as real data.
 * - Gmail tab: same two-pane bubble layout. The list shows threads
 *   (sender, snippet, time, blue unread dot); the thread header shows
 *   the email subject and bubbles use a wider max-width for email
 *   bodies. Reply saves a draft, same as GHL.
 * Thread messages always render oldest → newest with the newest
 * pinned to the bottom (auto-scroll on open/append), while the
 * conversation lists themselves stay most-recent-activity first.
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
];

function initials(name?: string): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

/** Badge row for a contact's pipeline entries (stage chip, DEAL, +N). */
function PipelineBadges({
  entries,
  showAll,
}: {
  entries?: PipelineMapEntry[];
  showAll?: boolean;
}) {
  if (!entries || entries.length === 0) return null;
  const primary = entries[0];
  const hasDeal = entries.some((e) => e.isDeal);
  const list = showAll ? entries : [primary];
  return (
    <span className="badge-row">
      {list.map((e, i) => (
        <span
          key={`${e.pipelineId}-${e.stageId}-${i}`}
          className={`chip ${e.isDeal ? "chip-stage deal-stage" : "chip-stage"}`}
          title={e.opportunityName}
        >
          {e.pipelineName} · {shortStageName(e.stageName)}
        </span>
      ))}
      {!showAll && hasDeal && <span className="chip chip-deal">DEAL</span>}
      {!showAll && entries.length > 1 && (
        <span className="chip chip-more">+{entries.length - 1}</span>
      )}
    </span>
  );
}

function Bubbles({
  messages,
  demo,
  wide,
}: {
  messages: ConversationMessage[];
  demo?: boolean;
  wide?: boolean;
}) {
  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className={`bubble-row ${m.direction}`}>
          <div className={`bubble ${m.direction}${wide ? " wide" : ""}`}>
            {m.body}
          </div>
          <div className="bubble-time">
            {fmtDate(m.dateAdded)}
            {demo ? " · DEMO" : ""}
          </div>
        </div>
      ))}
    </>
  );
}

interface InboxProps {
  pipelineMap: PipelineMapData | null;
  inboxFilter: InboxFilter | null;
  onClearFilter: () => void;
}

export default function Inbox({
  pipelineMap,
  inboxFilter,
  onClearFilter,
}: InboxProps) {
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
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const threadScrollState = useRef<{ id: string | null; count: number }>({
    id: null,
    count: 0,
  });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBody, setBulkBody] = useState("");
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // ----- Gmail state -----
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailConversations, setGmailConversations] = useState<Conversation[]>([]);
  const [gmailLoaded, setGmailLoaded] = useState(false);
  const [gmailSelected, setGmailSelected] = useState<Conversation | null>(null);
  const [gmailMessages, setGmailMessages] = useState<ConversationMessage[]>([]);
  const [gmailMessagesLoading, setGmailMessagesLoading] = useState(false);
  const [gmailSubject, setGmailSubject] = useState<string | undefined>(undefined);
  const [gmailReplyBody, setGmailReplyBody] = useState("");
  const [gmailNote, setGmailNote] = useState<string | null>(null);
  const [gmailReplyNote, setGmailReplyNote] = useState<string | null>(null);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [gmailReplyBusy, setGmailReplyBusy] = useState(false);
  const gmailReplyRef = useRef<HTMLTextAreaElement | null>(null);
  const focusGmailReplyOnSelect = useRef(false);
  const gmailThreadScrollRef = useRef<HTMLDivElement | null>(null);
  const gmailThreadScrollState = useRef<{ id: string | null; count: number }>({
    id: null,
    count: 0,
  });

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
          setGmailError(err instanceof Error ? err.message : "Gmail load failed.");
        }
      })
      .finally(() => {
        if (!cancelled) setGmailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, gmailStatus, gmailLoaded]);

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

  // Pin the newest message to the bottom of the GHL thread: jump
  // instantly ("auto") when a conversation opens or its first messages
  // land, smooth-scroll when a message is appended to the open thread.
  useEffect(() => {
    const el = threadScrollRef.current;
    if (!el || !selectedId) return;
    const prev = threadScrollState.current;
    const opening = prev.id !== selectedId || prev.count === 0;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: opening ? "auto" : "smooth",
    });
    threadScrollState.current = { id: selectedId, count: messages.length };
  }, [selectedId, messages]);

  // Same pinning for the Gmail thread pane.
  useEffect(() => {
    const el = gmailThreadScrollRef.current;
    const id = gmailSelected?.id ?? null;
    if (!el || !id) return;
    const prev = gmailThreadScrollState.current;
    const opening = prev.id !== id || prev.count === 0;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: opening ? "auto" : "smooth",
    });
    gmailThreadScrollState.current = { id, count: gmailMessages.length };
  }, [gmailSelected, gmailMessages]);

  const visibleConversations = inboxFilter
    ? conversations.filter((c) =>
        contactMatchesFilter(pipelineMap?.byContact[c.contactId], inboxFilter),
      )
    : conversations;

  const selected =
    conversations.find((c) => c.id === selectedId) ?? null;
  const selectedEntries = selected
    ? pipelineMap?.byContact[selected.contactId]
    : undefined;

  async function selectConversation(c: Conversation) {
    setSelectedId(c.id);
    setReplyNote(null);
    setReplyError(null);
    if (c.messages && c.messages.length > 0) {
      setMessages(sortMessagesAscending(c.messages));
      return;
    }
    if (demo) {
      setMessages([]);
      return;
    }
    setMessages([]);
    setMessagesLoading(true);
    try {
      setMessages(sortMessagesAscending(await fetchConversationMessages(c.id)));
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
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
      setGmailMessages(sortMessagesAscending(data.messages));
      if (data.conversation) setGmailSelected(data.conversation);
      setGmailSubject(data.subject ?? data.conversation?.subject);
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
      setGmailReplyNote("Draft saved — approve it in the drafts queue to send.");
      window.dispatchEvent(new Event("drafts:refresh"));
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setGmailReplyBusy(false);
    }
  }

  return (
    <section className="card inbox-card" aria-label="Unified inbox">
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
          {inboxFilter && (
            <div className="banner">
              Pipeline card filters apply to HighLevel texts — Gmail is not
              filtered.
            </div>
          )}
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
                <div className="inbox-panes">
                  <div className="pane-list" aria-label="Email threads">
                    {gmailConversations.map((c) => {
                      const unread =
                        typeof c.unreadCount === "number" && c.unreadCount > 0;
                      return (
                        <div
                          key={c.id}
                          className={`convo-item ${gmailSelected?.id === c.id ? "active" : ""}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => void selectGmailConversation(c)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void selectGmailConversation(c);
                            }
                          }}
                        >
                          <span className="avatar">
                            {initials(c.contactName)}
                          </span>
                          <span className="convo-main">
                            <span className="convo-top">
                              <span className="convo-name">
                                {c.contactName ?? "Unknown sender"}
                              </span>
                              <span className="convo-when">
                                {fmtDate(c.lastMessageDate)}
                              </span>
                            </span>
                            <span className="convo-preview-row">
                              <span className="convo-preview">
                                {c.subject
                                  ? `${c.subject} — ${c.lastMessageBody ?? ""}`
                                  : (c.lastMessageBody ?? "")}
                              </span>
                              {unread && <span className="unread-dot" />}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="pane-thread">
                    {!gmailSelected ? (
                      <p className="muted pane-pad">
                        Select a thread to read it and draft a reply.
                      </p>
                    ) : (
                      <>
                        <div className="thread-head">
                          <span className="thread-name">
                            {gmailSubject ??
                              gmailSelected.subject ??
                              "(no subject)"}
                          </span>
                          <span className="muted small">
                            {gmailSelected.contactName ?? "Unknown sender"}
                          </span>
                        </div>
                        <div
                          className="thread-scroll"
                          ref={gmailThreadScrollRef}
                        >
                          {gmailMessagesLoading && (
                            <p className="muted">Loading messages…</p>
                          )}
                          {!gmailMessagesLoading &&
                            gmailMessages.length === 0 && (
                              <p className="muted">
                                No messages loaded for this thread.
                              </p>
                            )}
                          <Bubbles messages={gmailMessages} wide />
                        </div>
                        <div className="composer">
                          <textarea
                            ref={gmailReplyRef}
                            className="composer-input"
                            rows={1}
                            value={gmailReplyBody}
                            onChange={(e) => setGmailReplyBody(e.target.value)}
                            placeholder={`Reply to ${gmailSelected.contactName ?? "this thread"}… (saved as a draft)`}
                          />
                          <button
                            className="btn composer-btn"
                            disabled={
                              gmailReplyBusy ||
                              gmailReplyBody.trim().length === 0
                            }
                            onClick={() => void saveGmailReplyDraft()}
                          >
                            Save draft
                          </button>
                          {gmailReplyNote && (
                            <p className="small composer-note">
                              {gmailReplyNote}
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
          {inboxFilter && !demo && (
            <div className="filter-banner">
              <span>
                Showing only: <strong>{inboxFilter.label}</strong> (
                {visibleConversations.length}{" "}
                {visibleConversations.length === 1 ? "person" : "people"})
              </span>
              <button className="btn ghost" onClick={onClearFilter}>
                Clear
              </button>
            </div>
          )}
          {loading ? (
            <p className="muted">Loading conversations…</p>
          ) : conversations.length === 0 ? (
            <p className="muted">No conversations found.</p>
          ) : (
            <div className="inbox-panes">
              <div className="pane-list" aria-label="Contacts">
                {visibleConversations.length === 0 && inboxFilter ? (
                  <p className="muted pane-pad">
                    No conversations with people in {inboxFilter.label} yet.
                  </p>
                ) : (
                  visibleConversations.map((c) => {
                    const entries = pipelineMap?.byContact[c.contactId];
                    const unread =
                      typeof c.unreadCount === "number" && c.unreadCount > 0;
                    return (
                      <div
                        key={c.id}
                        className={`convo-item ${selected?.id === c.id ? "active" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => void selectConversation(c)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void selectConversation(c);
                        }}
                      >
                        <span className="avatar">{initials(c.contactName)}</span>
                        <span className="convo-main">
                          <span className="convo-top">
                            <span className="convo-name">
                              {c.contactName ?? "Unknown contact"}
                              {demo && (
                                <>
                                  {" "}
                                  <span className="badge demo">DEMO</span>
                                </>
                              )}
                            </span>
                            <span className="convo-when">
                              {fmtDate(c.lastMessageDate)}
                            </span>
                          </span>
                          <span className="convo-preview-row">
                            <span className="convo-preview">
                              {c.lastMessageBody ?? ""}
                            </span>
                            {unread && <span className="unread-dot" />}
                          </span>
                          <PipelineBadges entries={entries} />
                          {!demo && (
                            <span className="convo-actions">
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
                                  focusReplyOnSelect.current = true;
                                  void selectConversation(c);
                                }}
                              >
                                Draft reply
                              </button>
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="pane-thread">
                {!selected ? (
                  <p className="muted pane-pad">
                    Select a conversation to read the thread and draft a
                    reply.
                  </p>
                ) : (
                  <>
                    <div className="thread-head">
                      <span className="thread-name">
                        {selected.contactName ?? "Unknown contact"}
                      </span>
                      <PipelineBadges entries={selectedEntries} showAll />
                    </div>
                    <div className="thread-scroll" ref={threadScrollRef}>
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
                      <Bubbles messages={messages} demo={demo} />
                    </div>
                    {!demo && (
                      <div className="composer">
                        <textarea
                          ref={replyRef}
                          className="composer-input"
                          rows={1}
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          placeholder={`Message ${selected.contactName ?? "this contact"}… (saved as a draft)`}
                        />
                        <button
                          className="btn composer-btn"
                          disabled={replyBusy || replyBody.trim().length === 0}
                          onClick={() => void saveReplyDraft()}
                        >
                          Save draft
                        </button>
                        {replyNote && <p className="small composer-note">{replyNote}</p>}
                        {replyError && (
                          <div className="error composer-note">{replyError}</div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
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
        </div>
      )}
    </section>
  );
}

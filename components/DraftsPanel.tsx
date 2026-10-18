"use client";

import { useCallback, useEffect, useState } from "react";
import type { Draft } from "@/lib/types";
import { fetchDrafts, fmtDate } from "@/components/api";

/**
 * Saved message drafts from /api/ghl/drafts.
 * Approve / Reject write back via PATCH /api/ghl/drafts. Only APPROVED
 * drafts can be sent, and only via the "Send" button here, which calls
 * POST /api/ghl/send — the single gated send path (approval, suppression,
 * and live DND checks all re-run server-side at send time).
 */
export default function DraftsPanel() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setDrafts(await fetchDrafts());
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Drafts service unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onRefresh = () => void load();
    window.addEventListener("drafts:refresh", onRefresh);
    return () => window.removeEventListener("drafts:refresh", onRefresh);
  }, [load]);

  async function act(id: string, status: "approved" | "rejected") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch("/api/ghl/drafts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const msg =
          (data as { error?: string } | null)?.error ??
          `Update failed (${res.status})`;
        throw new Error(msg);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function send(id: string) {
    setBusyId(id);
    setError(null);
    setSendNote((prev) => ({ ...prev, [id]: "" }));
    try {
      const res = await fetch("/api/ghl/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: id }),
      });
      const data: unknown = await res.json().catch(() => null);
      const rec = data as { ok?: boolean; error?: string } | null;
      if (!res.ok || !rec?.ok) {
        throw new Error(rec?.error ?? `Send failed (${res.status})`);
      }
      setSendNote((prev) => ({ ...prev, [id]: "Sent." }));
      await load();
    } catch (err) {
      setSendNote((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card" aria-label="Drafts">
      <h2>Drafts — approval queue</h2>
      {loading && <p className="muted">Loading drafts…</p>}
      {error && <div className="error">{error}</div>}
      {!loading && !error && drafts.length === 0 && (
        <p className="muted">
          No drafts yet. Generate an opener in the Deal panel and choose
          &ldquo;Save draft&rdquo;.
        </p>
      )}
      {drafts.map((d) => (
        <div className="draft-item" key={d.id}>
          <div className="meta">
            <span className="badge status">{d.status}</span>
            <span>
              To: {d.to || "—"} · {d.feed.toUpperCase()} ·{" "}
              {fmtDate(d.createdAt)}
            </span>
          </div>
          {d.subject && (
            <div className="meta" style={{ marginTop: 4 }}>
              Subject: {d.subject}
            </div>
          )}
          <div className="body">{d.body}</div>
          {d.status === "draft" && (
            <div className="btn-row">
              <button
                className="btn"
                disabled={busyId === d.id}
                onClick={() => void act(d.id, "approved")}
              >
                Approve
              </button>
              <button
                className="btn danger"
                disabled={busyId === d.id}
                onClick={() => void act(d.id, "rejected")}
              >
                Reject
              </button>
            </div>
          )}
          {d.status === "approved" && (
            <div>
              <div className="btn-row">
                <button
                  className="btn"
                  disabled={busyId === d.id}
                  onClick={() => void send(d.id)}
                >
                  Send now
                </button>
              </div>
              <p className="muted">
                Approved — not sent yet. Sending re-runs the suppression and
                DND checks before anything goes out.
              </p>
            </div>
          )}
          {d.status === "sent" && (
            <p className="muted">
              Sent {fmtDate(d.sentAt)}
              {d.externalId ? ` · provider id ${d.externalId}` : ""}.
            </p>
          )}
          {sendNote[d.id] &&
            (sendNote[d.id] === "Sent." ? (
              <p className="small">Sent.</p>
            ) : (
              <div className="error">{sendNote[d.id]}</div>
            ))}
        </div>
      ))}
      <p className="muted">
        Only approved drafts can be sent, and only through the audited,
        gated send path.
      </p>
    </section>
  );
}

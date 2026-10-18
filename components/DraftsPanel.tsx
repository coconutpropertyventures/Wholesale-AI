"use client";

import { useCallback, useEffect, useState } from "react";
import type { Draft } from "@/lib/types";
import { fetchDrafts, fmtDate } from "@/components/api";

/**
 * Saved message drafts from /api/ghl/drafts.
 * Approve / Reject write back via PATCH /api/ghl/drafts. Approving queues a
 * draft for the gated sending flow (suppression + DND checks) — this panel
 * never sends anything itself.
 */
export default function DraftsPanel() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
            <p className="muted">
              Approved — queued for the gated sending flow (suppression and
              DND checks run before any send). Not sent yet.
            </p>
          )}
        </div>
      ))}
      <p className="muted">
        Nothing sends from this screen. Only approved drafts can be sent,
        and only through the audited send path.
      </p>
    </section>
  );
}

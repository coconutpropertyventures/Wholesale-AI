"use client";

// Blast panel: build a queue of listing agents (workbench selection by
// default, pipeline stage as the secondary source), preview it, and
// approve it. Sending runs SERVER-SIDE in the background via
// POST /api/blast/tick — this panel only polls progress every ~15s.
// Closing the tab does not affect an approved run.
import { useCallback, useEffect, useRef, useState } from "react";
import { DISTRESSED_OPENER, TURNKEY_OPENER } from "@/lib/comms/scripts";
import { PIPELINE_DEFS } from "@/lib/ghl/pipelineMap";
import type { DealPrefill } from "@/lib/deals/prefill";
import {
  blastRunAction,
  createBlastRun,
  enrichBlastRun,
  fetchBlastRun,
  fetchBlastRuns,
  fmtDate,
  type BlastItemData,
  type BlastRunData,
  type BlastRunDetailData,
  type PipelineMapData,
} from "@/components/api";

const SCRIPTS = [
  { key: "turnkey_opener", label: "Turnkey opener (approved script)", text: TURNKEY_OPENER },
  { key: "distressed_opener", label: "Distressed opener (approved script)", text: DISTRESSED_OPENER },
] as const;

const ITEM_LABELS: Record<string, string> = {
  enriching: "Looking up agent…",
  queued: "Ready",
  sending: "Sending…",
  sent: "Sent",
  skipped_dnd: "Skipped — DND",
  missing_phone: "No phone",
  skipped_suppressed: "Suppressed",
  skipped_recent: "Contacted <30d",
  skipped_active: "In active run",
  failed: "Failed",
};

function defaultStageValue(): string {
  const pre = PIPELINE_DEFS[0];
  const stage = pre?.stages[0];
  return pre && stage ? `${pre.id}|${stage.id}` : "";
}

export default function BlastPanel({
  pipelineMap,
  selectedListings,
  onClearSelection,
  focusRun,
}: {
  pipelineMap: PipelineMapData | null;
  selectedListings: DealPrefill[];
  onClearSelection: () => void;
  /** A run just built from the workbench toolbar ("Send to all" /
   *  "Create blast from selected") — open it here and scroll the
   *  panel into view so Bradley lands on its preview + counts. */
  focusRun?: { id: string; nonce: number } | null;
}) {
  const [source, setSource] = useState<"search" | "stage">("search");
  const [stageValue, setStageValue] = useState<string>(defaultStageValue);
  const [scriptKey, setScriptKey] = useState<string>("turnkey_opener");
  const [dailyCap, setDailyCap] = useState("250");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<
    { run: BlastRunData; counts: BlastRunDetailData["counts"]; sentToday: number }[]
  >([]);
  const [detail, setDetail] = useState<BlastRunDetailData | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [enrichPhase, setEnrichPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailIdRef = useRef<string | null>(null);
  useEffect(() => {
    detailIdRef.current = detail?.run.id ?? null;
  }, [detail]);
  const sectionRef = useRef<HTMLElement | null>(null);
  const lastFocusNonce = useRef(0);

  const refreshRuns = useCallback(async () => {
    try {
      const data = await fetchBlastRuns();
      setConfigured(data.configured);
      setRuns(data.runs);
      return data.runs;
    } catch {
      return [];
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await fetchBlastRun(id);
      if (d && detailIdRef.current === id) setDetail(d);
    } catch {
      // polling is best-effort; the next tick retries
    }
  }, []);

  // Initial load: run list + open the most relevant run (a live one if
  // any, else the newest) so progress resumes exactly where it was.
  useEffect(() => {
    void (async () => {
      const list = await refreshRuns();
      const live = list.find(
        (r) => r.run.status === "approved" || r.run.status === "sending",
      );
      const target = live ?? list[0];
      if (target) {
        const d = await fetchBlastRun(target.run.id).catch(() => null);
        if (d) setDetail(d);
      }
    })();
  }, [refreshRuns]);

  // Workbench toolbar focus: a run was just created up in the
  // DealPanel ("Send to all" / "Create blast from selected"). Reload
  // the run list, open that run's preview, and scroll here.
  useEffect(() => {
    if (!focusRun || focusRun.nonce === lastFocusNonce.current) return;
    lastFocusNonce.current = focusRun.nonce;
    void (async () => {
      await refreshRuns();
      await openRun(focusRun.id);
      sectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    })();
    // openRun is a stable component-local function; nonce gates re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRun, refreshRuns]);

  // Poll progress while the open run is live. Display only — the run
  // itself executes server-side and does not depend on this tab.
  const detailStatus = detail?.run.status;
  useEffect(() => {
    if (detailStatus !== "approved" && detailStatus !== "sending") return;
    const t = setInterval(() => {
      const id = detailIdRef.current;
      if (id) {
        void refreshDetail(id);
        void refreshRuns();
      }
    }, 15000);
    return () => clearInterval(t);
  }, [detailStatus, refreshDetail, refreshRuns]);

  // Agent lookup: while the open run has items still enriching, poll
  // the enrich step (~10s). Each call advances the server-side step
  // machine by one short step (start / poll / apply the detail pull) —
  // this is not a sending loop, and it stops the moment no items are
  // left enriching. When the last lookup lands, the run's counts
  // update in place and Approve unlocks.
  const enrichingCount = detail?.counts.enriching ?? 0;
  useEffect(() => {
    if (!detail || enrichingCount === 0) return;
    const id = detail.run.id;
    let cancelled = false;
    const step = async () => {
      try {
        const next = await enrichBlastRun(id);
        if (cancelled || detailIdRef.current !== id) return;
        setDetail(next);
        if (next.phase) setEnrichPhase(next.phase);
        void refreshRuns();
      } catch {
        // best-effort; the next poll retries
      }
    };
    void step();
    const t = setInterval(() => void step(), 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [detail?.run.id, enrichingCount, refreshRuns]);

  const stageOptions = PIPELINE_DEFS.map((p) => ({
    pipeline: p,
    stages: p.stages.map((s) => ({
      stage: s,
      count: pipelineMap?.stageCounts[`${p.id}:${s.id}`],
    })),
  }));

  async function buildQueue() {
    setBuilding(true);
    setError(null);
    setNotice(null);
    try {
      const cap = Number.parseInt(dailyCap, 10);
      const built = await createBlastRun({
        source,
        stageRef:
          source === "stage"
            ? (() => {
                const [pipelineId, stageId] = stageValue.split("|");
                return { pipelineId, stageId };
              })()
            : undefined,
        properties:
          source === "search"
            ? (selectedListings as unknown as Record<string, unknown>[])
            : undefined,
        scriptKey,
        dailyCap: Number.isFinite(cap) && cap > 0 ? cap : undefined,
      });
      setDetail(built);
      await refreshRuns();
      setNotice(
        `Draft run built: ${built.counts.queued} ready of ${built.counts.total} queued records. Nothing has been sent — review the queue, then Approve & start.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  async function act(action: "approve" | "step" | "pause" | "stop") {
    if (!detail) return;
    setBusy(action);
    setError(null);
    try {
      const next = await blastRunAction(detail.run.id, action);
      setDetail(next);
      await refreshRuns();
      if (action === "step") {
        const outcome = next.outcome as { kind?: string; waitSeconds?: number } | undefined;
        if (outcome?.kind === "sent") setNotice("Test step sent one text.");
        else if (outcome?.kind === "waiting")
          setNotice(`Too soon — server pacing says wait ${outcome.waitSeconds ?? "?"}s before the next send.`);
        else if (outcome?.kind === "skipped") setNotice("Test step skipped a DND/suppressed contact; the run continues.");
        else if (outcome?.kind === "cap") setNotice("Daily cap reached for this run.");
        else if (outcome?.kind === "complete") setNotice("Queue finished — run complete.");
        else setNotice(`Step result: ${outcome?.kind ?? "done"}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function openRun(id: string) {
    setError(null);
    try {
      const d = await fetchBlastRun(id);
      if (d) setDetail(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const script = SCRIPTS.find((s) => s.key === scriptKey) ?? SCRIPTS[0];
  const run = detail?.run;
  const counts = detail?.counts;

  return (
    <section className="panel blast-panel" ref={sectionRef}>
      <div className="panel-head">
        <h2>Blast — text listing agents</h2>
        {run && <span className={`badge blast-status-${run.status}`}>{run.status}</span>}
      </div>
      <p className="small">
        Approved runs execute <strong>server-side in the background</strong> —
        you can close this tab and the run keeps going; progress is saved and
        shown here when you return. Sends are paced 45–60s apart, in groups of
        10 with a 3-minute pause, up to the daily cap. DND/opt-outs are skipped
        and the run continues; any other failure pauses the run (fail-stop).
        Confirmed sends are logged as a note on the agent&apos;s contact and
        the property moves to Contacted.
      </p>
      {configured === false && (
        <div className="error">
          GoHighLevel is not configured on the server (GHL_PRIVATE_TOKEN), so
          queues cannot be built yet.
        </div>
      )}

      <div className="form-grid">
        <div className="field full">
          <label htmlFor="blast-source">Source</label>
          <select
            id="blast-source"
            value={source}
            onChange={(e) => setSource(e.target.value as "search" | "stage")}
          >
            <option value="search">
              Workbench selection — properties checked below ({selectedListings.length} selected)
            </option>
            <option value="stage">Pipeline stage (secondary)</option>
          </select>
        </div>
        {source === "search" ? (
          <div className="field full">
            <span className="small">
              {selectedListings.length === 0
                ? "No properties selected — check “Add to blast” on Zillow/Redfin result cards in the workbench above. The listing agent is resolved from the cached property detail; when only a listing link is known, an agent lookup pulls the detail page to find the agent's number before the property can be queued."
                : selectedListings
                    .map((p) => p.address ?? "Unknown address")
                    .join(" · ")}
            </span>
            {selectedListings.length > 0 && (
              <button type="button" className="btn" onClick={onClearSelection}>
                Clear selection
              </button>
            )}
          </div>
        ) : (
          <div className="field full">
            <label htmlFor="blast-stage">Pipeline stage</label>
            <select
              id="blast-stage"
              value={stageValue}
              onChange={(e) => setStageValue(e.target.value)}
            >
              {stageOptions.map(({ pipeline, stages }) => (
                <optgroup key={pipeline.id} label={pipeline.shortName}>
                  {stages.map(({ stage, count }) => (
                    <option
                      key={stage.id}
                      value={`${pipeline.id}|${stage.id}`}
                    >
                      {stage.name}
                      {count !== undefined ? ` (${count})` : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
        <div className="field full">
          <label htmlFor="blast-script">Script (approved, sent verbatim)</label>
          <select
            id="blast-script"
            value={scriptKey}
            onChange={(e) => setScriptKey(e.target.value)}
          >
            {SCRIPTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <pre className="script-preview">{script.text}</pre>
          <span className="small">
            {"{first}"} and {"{street}"} are filled in per agent at send time.
            These are your approved scripts exactly as written — the blast never
            rewrites them.
          </span>
        </div>
        <div className="field">
          <label htmlFor="blast-cap">Daily cap (sends per run per day)</label>
          <input
            id="blast-cap"
            inputMode="numeric"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
          />
        </div>
      </div>
      <div className="inline-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => void buildQueue()}
          disabled={
            building || (source === "search" && selectedListings.length === 0)
          }
        >
          {building ? "Building queue…" : "Build queue"}
        </button>
      </div>

      {runs.length > 0 && (
        <div className="blast-runs">
          <span className="small">Runs:</span>
          {runs.map(({ run: r, counts: c }) => (
            <button
              key={r.id}
              type="button"
              className={`btn${detail?.run.id === r.id ? " primary" : ""}`}
              onClick={() => void openRun(r.id)}
            >
              {r.source === "stage" ? "Stage" : "Workbench"} · {r.status} ·{" "}
              {c.sent}/{c.total} sent · {fmtDate(r.createdAt)}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {notice && <p className="small">{notice}</p>}

      {detail && run && counts && (
        <div className="blast-detail">
          <div className="counts-row">
            <span className="count-chip">Ready {counts.queued}</span>
            {counts.enriching > 0 && (
              <span className="count-chip">
                Looking up agents {counts.enriching}
              </span>
            )}
            <span className="count-chip">Sent {counts.sent}</span>
            <span className="count-chip">No phone {counts.noPhone}</span>
            <span className="count-chip">Suppressed {counts.suppressed}</span>
            <span className="count-chip">Already contacted {counts.recent}</span>
            <span className="count-chip">In active run {counts.active}</span>
            <span className="count-chip">Skipped (DND) {counts.skippedDnd}</span>
            <span className="count-chip">Failed {counts.failed}</span>
            <span className="count-chip">
              Today {detail.sentToday}/{run.dailyCap}
            </span>
          </div>
          {run.note && <p className="small blast-note">{run.note}</p>}
          {counts.enriching > 0 && (
            <p className="small">
              Looking up listing agents… ({counts.enriching} pending
              {enrichPhase ? ` — ${enrichPhase}` : ""}). Redfin search
              results carry no agent contacts, so each property&apos;s
              listing detail is being pulled to find the agent&apos;s
              direct number (~1¢ per property). This run can&apos;t be
              approved until every lookup resolves.
            </p>
          )}
          {run.lastSentAt && (
            <p className="small">Last sent: {fmtDate(run.lastSentAt)}</p>
          )}
          <div className="inline-actions">
            {(run.status === "draft" || run.status === "paused") && (
              <button
                type="button"
                className="btn primary"
                onClick={() => void act("approve")}
                disabled={busy !== null || counts.enriching > 0}
              >
                {counts.enriching > 0
                  ? "Waiting for agent lookup…"
                  : run.status === "paused"
                    ? "Approve & resume"
                    : "Approve & start"}
              </button>
            )}
            {(run.status === "approved" || run.status === "sending") && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void act("step")}
                  disabled={busy !== null}
                >
                  Send one now (test step)
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void act("pause")}
                  disabled={busy !== null}
                >
                  Pause
                </button>
              </>
            )}
            {run.status !== "stopped" && run.status !== "complete" && (
              <button
                type="button"
                className="btn danger"
                onClick={() => void act("stop")}
                disabled={busy !== null}
              >
                Stop run
              </button>
            )}
          </div>
          <div className="blast-table-wrap">
            <table className="blast-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Street</th>
                  <th>Phone</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((item: BlastItemData) => (
                  <tr key={item.id}>
                    <td>{item.contactName ?? item.firstName ?? "—"}</td>
                    <td>{item.street}</td>
                    <td>{item.phone ?? "—"}</td>
                    <td>
                      <span className={`badge item-${item.status}`}>
                        {ITEM_LABELS[item.status] ?? item.status}
                      </span>
                      {item.status === "sent" && item.sentAt && (
                        <span className="small"> {fmtDate(item.sentAt)}</span>
                      )}
                      {item.error && (
                        <span className="small blast-item-error">
                          {" "}
                          {item.error}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

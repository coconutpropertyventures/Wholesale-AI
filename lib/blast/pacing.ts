// Pure pacing rails for blast runs — Bradley's standing carrier-safety
// rules, enforced server-side no matter who drives the run (manual step
// or the background tick):
//   - at least 45s between sends (the engine aims for a 50s cadence)
//   - sends go in groups of 10, then a 180s pause before the next group
//   - a per-run daily cap; when reached, the run reports "cap"
//   - only approved/sending runs may send at all
import type { BlastRun } from "@/lib/types";

export const MIN_GAP_SECONDS = 45;
export const SEND_CADENCE_SECONDS = 50;
export const GROUP_SIZE = 10;
export const GROUP_PAUSE_SECONDS = 180;

type RunPacingState = Pick<
  BlastRun,
  "status" | "lastSentAt" | "groupSentCount" | "dailyCap"
>;

export type PacingDecision =
  | { kind: "ok" }
  | { kind: "wait"; waitSeconds: number; why: "gap" | "group_pause" }
  | { kind: "capped" }
  | { kind: "bad_status" };

export function decidePacing(
  run: RunPacingState,
  sentToday: number,
  nowMs: number,
): PacingDecision {
  if (run.status !== "approved" && run.status !== "sending") {
    return { kind: "bad_status" };
  }
  if (sentToday >= run.dailyCap) {
    return { kind: "capped" };
  }
  if (run.lastSentAt) {
    const elapsed = (nowMs - Date.parse(run.lastSentAt)) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      if (run.groupSentCount >= GROUP_SIZE) {
        // The group of 10 is complete; the 180s group pause runs from
        // the group's last send.
        if (elapsed < GROUP_PAUSE_SECONDS) {
          return {
            kind: "wait",
            waitSeconds: Math.ceil(GROUP_PAUSE_SECONDS - elapsed),
            why: "group_pause",
          };
        }
      } else if (elapsed < MIN_GAP_SECONDS) {
        return {
          kind: "wait",
          waitSeconds: Math.ceil(MIN_GAP_SECONDS - elapsed),
          why: "gap",
        };
      }
    }
  }
  return { kind: "ok" };
}

/** How long a driver should wait after a confirmed send before the
 *  next step: the group pause when the send completed a group of 10,
 *  otherwise the standard cadence. */
export function nextWaitAfterSend(groupSentCountAfter: number): number {
  return groupSentCountAfter >= GROUP_SIZE
    ? GROUP_PAUSE_SECONDS
    : SEND_CADENCE_SECONDS;
}

/** Run bookkeeping after one confirmed send at `nowIso`. A send that
 *  lands after a completed group's pause opens a fresh group. */
export function afterSend(
  run: Pick<BlastRun, "groupSentCount" | "currentGroupStartedAt">,
  nowIso: string,
): Pick<BlastRun, "lastSentAt" | "groupSentCount" | "currentGroupStartedAt"> {
  const opensGroup = run.groupSentCount >= GROUP_SIZE || run.groupSentCount === 0;
  return {
    lastSentAt: nowIso,
    groupSentCount: opensGroup ? 1 : run.groupSentCount + 1,
    currentGroupStartedAt: opensGroup ? nowIso : run.currentGroupStartedAt,
  };
}

// ---------- Background tick planning ----------

export interface TickRunInput {
  run: BlastRun;
  sentToday: number;
  hasQueued: boolean;
}

export type TickAction = "send" | "waiting" | "paused" | "cap" | "idle";

export interface TickPlanEntry {
  runId: string;
  action: TickAction;
  waitSeconds?: number;
}

/**
 * Decide, for every candidate run, what one tick should do. Pure: the
 * tick route loads runs + counters, plans here, then executes at most
 * one engine step per "send" entry. Paused/stopped/draft/complete runs
 * are not tick candidates (the route filters them out); any that slip
 * through plan as "paused" and are never stepped.
 */
export function planTick(inputs: TickRunInput[], nowMs: number): TickPlanEntry[] {
  return inputs.map(({ run, sentToday, hasQueued }) => {
    if (run.status !== "approved" && run.status !== "sending") {
      return { runId: run.id, action: "paused" as const };
    }
    if (!hasQueued) {
      return { runId: run.id, action: "idle" as const };
    }
    const decision = decidePacing(run, sentToday, nowMs);
    switch (decision.kind) {
      case "capped":
        return { runId: run.id, action: "cap" as const };
      case "wait":
        return {
          runId: run.id,
          action: "waiting" as const,
          waitSeconds: decision.waitSeconds,
        };
      case "bad_status":
        return { runId: run.id, action: "paused" as const };
      default:
        return { runId: run.id, action: "send" as const };
    }
  });
}

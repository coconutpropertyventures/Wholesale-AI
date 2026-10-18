// Pure queue-building logic for blast runs. The IO wrapper
// (lib/blast/service.ts) gathers candidates from HighLevel / the
// property cache and the exclusion context from the store; everything
// decided here is a pure function of those inputs so the rails are
// unit-testable without a CRM.
import {
  DISTRESSED_OPENER,
  TURNKEY_OPENER,
  personalize,
} from "@/lib/comms/scripts";
import { normalizePhoneDigits } from "@/lib/ghl/client";
import type { BlastItemStatus, BlastScriptKey } from "@/lib/types";

/** GHL contact custom field that drives SMS street personalization. */
export const LISTING_STREET_FIELD_ID = "4AfbGppoadNOicpZ7Ubm";

/** Wholesale pipeline "Contacted" stage — confirmed blast sends move
 *  the property's opportunity here (never before the send lands). */
export const CONTACTED_STAGE_ID = "6bdb617e-b58c-4a20-aaee-79edcc0a49ff";

/** The ONLY two scripts a blast can carry — Bradley's approved openers,
 *  used verbatim (personalization fills {first}/{street} only). */
export function scriptForKey(key: BlastScriptKey): string {
  return key === "distressed_opener" ? DISTRESSED_OPENER : TURNKEY_OPENER;
}

/** The exact text an item will send. */
export function personalizedBody(
  scriptKey: BlastScriptKey,
  first: string | undefined,
  street: string,
): string {
  return personalize(scriptForKey(scriptKey), { first, street });
}

/**
 * Street portion of a listing/opportunity name. Opportunity names are
 * the full property address ("2309 S Meridian St, Indianapolis, IN
 * 46225"), sometimes with a lane suffix ("... (distressed)").
 */
export function streetFromListingName(name: string): string {
  const cleaned = name.replace(/\s*\((distressed|turnkey)\)\s*$/i, "").trim();
  const street = cleaned.split(",")[0]?.trim();
  return street && street.length > 0 ? street : cleaned;
}

/** Normalized street for matching (case/space/punctuation-insensitive). */
export function streetKey(street: string): string {
  return street
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Identity of one contact+property pair across runs and history. */
export function contactStreetKey(contactId: string, street: string): string {
  return `${contactId}|${streetKey(street)}`;
}

export interface BlastCandidate {
  contactId?: string;
  contactName?: string;
  firstName?: string;
  opportunityId?: string;
  street: string;
  phone?: string;
}

export interface PlannedBlastItem extends BlastCandidate {
  status: BlastItemStatus;
  error?: string;
}

export interface BlastPlanCounts {
  total: number;
  ready: number;
  noPhone: number;
  suppressed: number;
  recent: number;
  active: number;
  duplicate: number;
}

export interface BlastPlanContext {
  /** normalizePhoneDigits() of every value on the app suppression list. */
  suppressedPhones: Set<string>;
  /** contactStreetKey() of pairs already queued/sent in a live run. */
  activeKeys: Set<string>;
  /** contactStreetKey() of pairs sent via this app within 30 days. */
  recentKeys: Set<string>;
}

/**
 * Apply the build-time rails to a candidate list:
 *   duplicate pair in the same build -> dropped (counted)
 *   no phone                          -> missing_phone
 *   phone on the suppression list     -> skipped_suppressed
 *   pair already in a live run        -> skipped_active
 *   pair sent within the last 30 days -> skipped_recent
 *   otherwise                         -> queued (the only sendable state)
 * A phone number is never invented: unresolved stays missing_phone.
 */
export function planBlastItems(
  candidates: BlastCandidate[],
  ctx: BlastPlanContext,
): { items: PlannedBlastItem[]; counts: BlastPlanCounts } {
  const counts: BlastPlanCounts = {
    total: candidates.length,
    ready: 0,
    noPhone: 0,
    suppressed: 0,
    recent: 0,
    active: 0,
    duplicate: 0,
  };
  const seen = new Set<string>();
  const items: PlannedBlastItem[] = [];
  for (const c of candidates) {
    const pairKey = c.contactId
      ? contactStreetKey(c.contactId, c.street)
      : `unresolved|${streetKey(c.street)}`;
    if (seen.has(pairKey)) {
      counts.duplicate += 1;
      continue;
    }
    seen.add(pairKey);
    if (!c.phone || normalizePhoneDigits(c.phone).length < 7) {
      counts.noPhone += 1;
      items.push({ ...c, status: "missing_phone", error: "No phone on file." });
      continue;
    }
    if (ctx.suppressedPhones.has(normalizePhoneDigits(c.phone))) {
      counts.suppressed += 1;
      items.push({
        ...c,
        status: "skipped_suppressed",
        error: "On the suppression list.",
      });
      continue;
    }
    if (c.contactId && ctx.activeKeys.has(pairKey)) {
      counts.active += 1;
      items.push({
        ...c,
        status: "skipped_active",
        error: "Already in an active blast run.",
      });
      continue;
    }
    if (c.contactId && ctx.recentKeys.has(pairKey)) {
      counts.recent += 1;
      items.push({
        ...c,
        status: "skipped_recent",
        error: "Contacted via this app within the last 30 days.",
      });
      continue;
    }
    counts.ready += 1;
    items.push({ ...c, status: "queued" });
  }
  return { items, counts };
}

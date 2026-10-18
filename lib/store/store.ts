// JSON-file-backed repository for Wholesale AI (milestone 1).
// Persists organizations, drafts, audit entries, and suppressions to
// data/store.json. Deliberately simple: synchronous read/write of the whole
// file on each mutation. Every record is stamped with an organizationId so
// the same store can serve multiple tenants later; milestone 1 runs the
// single default org (DEFAULT_ORG_ID).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_ORG_ID,
  type AuditEntry,
  type Draft,
  type Feed,
  type Suppression,
} from "@/lib/types";

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

interface StoreData {
  organizations: Organization[];
  drafts: Draft[];
  audit: AuditEntry[];
  suppressions: Suppression[];
}

const STORE_PATH = join(process.cwd(), "data", "store.json");

function seed(): StoreData {
  return {
    organizations: [
      {
        id: DEFAULT_ORG_ID,
        name: "Coconut Property Ventures LLC",
        createdAt: new Date().toISOString(),
      },
    ],
    drafts: [],
    audit: [],
    suppressions: [],
  };
}

function load(): StoreData {
  if (!existsSync(STORE_PATH)) {
    const data = seed();
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
    return data;
  }
  const raw = readFileSync(STORE_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<StoreData>;
  // Defensive: tolerate a partially-formed file from an earlier run.
  return {
    organizations: parsed.organizations ?? seed().organizations,
    drafts: parsed.drafts ?? [],
    audit: parsed.audit ?? [],
    suppressions: parsed.suppressions ?? [],
  };
}

function save(data: StoreData): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ---------- Organizations ----------

export function getOrganizations(): Organization[] {
  return load().organizations;
}

// ---------- Drafts ----------

export function getDrafts(organizationId: string = DEFAULT_ORG_ID): Draft[] {
  return load().drafts.filter((d) => d.organizationId === organizationId);
}

export function getDraft(id: string): Draft | undefined {
  return load().drafts.find((d) => d.id === id);
}

export interface CreateDraftInput {
  feed: Feed;
  contactId?: string;
  to: string;
  body: string;
  organizationId?: string;
}

export function createDraft(input: CreateDraftInput): Draft {
  const data = load();
  const draft: Draft = {
    id: randomUUID(),
    organizationId: input.organizationId ?? DEFAULT_ORG_ID,
    feed: input.feed,
    contactId: input.contactId,
    to: input.to,
    body: input.body,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  data.drafts.push(draft);
  save(data);
  return draft;
}

export function updateDraft(
  id: string,
  patch: Partial<Omit<Draft, "id" | "organizationId">>,
): Draft | undefined {
  const data = load();
  const idx = data.drafts.findIndex((d) => d.id === id);
  if (idx === -1) return undefined;
  data.drafts[idx] = { ...data.drafts[idx], ...patch };
  save(data);
  return data.drafts[idx];
}

// ---------- Audit ----------

export function addAudit(
  actor: string,
  action: string,
  detail: Record<string, unknown> = {},
  organizationId: string = DEFAULT_ORG_ID,
): AuditEntry {
  const data = load();
  const entry: AuditEntry = {
    id: randomUUID(),
    organizationId,
    at: new Date().toISOString(),
    actor,
    action,
    detail,
  };
  data.audit.push(entry);
  save(data);
  return entry;
}

export function listAudit(
  organizationId: string = DEFAULT_ORG_ID,
  limit = 200,
): AuditEntry[] {
  const entries = load().audit.filter(
    (e) => e.organizationId === organizationId,
  );
  return entries.slice(-limit);
}

// ---------- Suppressions ----------

function normalizeValue(value: string): string {
  const trimmed = value.trim().toLowerCase();
  let digits = trimmed.replace(/\D/g, "");
  // US numbers: drop a leading country-code 1 so +1 317 555 0100,
  // (317) 555-0100, and 3175550100 all compare equal.
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  // Phone-like values compare on digits so formatting never hides a match.
  return digits.length >= 7 ? digits : trimmed;
}

export function isSuppressed(value: string): boolean {
  const target = normalizeValue(value);
  return load().suppressions.some(
    (s) => normalizeValue(s.value) === target,
  );
}

export function addSuppression(
  value: string,
  reason: string,
  organizationId: string = DEFAULT_ORG_ID,
): Suppression {
  const data = load();
  const existing = data.suppressions.find(
    (s) =>
      s.organizationId === organizationId &&
      normalizeValue(s.value) === normalizeValue(value),
  );
  if (existing) return existing;
  const suppression: Suppression = {
    organizationId,
    value,
    reason,
    at: new Date().toISOString(),
  };
  data.suppressions.push(suppression);
  save(data);
  return suppression;
}

export function listSuppressions(
  organizationId: string = DEFAULT_ORG_ID,
): Suppression[] {
  return load().suppressions.filter(
    (s) => s.organizationId === organizationId,
  );
}

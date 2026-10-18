// Repository for Wholesale AI.
// Two backends behind one async API (same exported names, same record
// shapes):
//   - Postgres, when DATABASE_URL is set (production: Supabase's
//     transaction pooler). Tables bootstrap automatically on first use and
//     records are stored whole as JSONB.
//   - JSON file at data/store.json (milestone 1), when DATABASE_URL is
//     unset — local dev and tests behave exactly as before, including the
//     in-memory cache with best-effort file writes on read-only
//     filesystems (serverless).
// Every record is stamped with an organizationId so the same store can
// serve multiple tenants later; for now it runs the single default org
// (DEFAULT_ORG_ID).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import {
  DEFAULT_ORG_ID,
  type AiUsageEntry,
  type AuditEntry,
  type BlastItem,
  type BlastRun,
  type Draft,
  type Feed,
  type MessageOutcome,
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
  messageOutcomes: MessageOutcome[];
  aiUsage: AiUsageEntry[];
  blastRuns: BlastRun[];
  blastItems: BlastItem[];
}

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
    messageOutcomes: [],
    aiUsage: [],
    blastRuns: [],
    blastItems: [],
  };
}

// ---------- Backend selection ----------

function usePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

// ---------- Shared helpers ----------

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

// =====================================================================
// File backend (DATABASE_URL unset) — unchanged milestone-1 behavior.
// =====================================================================

const STORE_PATH = join(process.cwd(), "data", "store.json");

// In-memory cache over the JSON file. load() reads the file once (seeding on
// first use) and serves the cache after that; save() updates the cache and
// then tries to persist. The file write is best-effort: on a read-only
// filesystem (e.g. serverless deploys like Vercel) the write fails and the
// store keeps running on memory only — on serverless, in-memory data lasts
// only for the instance lifetime, so drafts created there can vanish on a
// cold start. Production sets DATABASE_URL and never takes this path.
let cache: StoreData | null = null;

function load(): StoreData {
  if (cache) return cache;
  let data: StoreData;
  if (!existsSync(STORE_PATH)) {
    data = seed();
  } else {
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    // Defensive: tolerate a partially-formed file from an earlier run.
    data = {
      organizations: parsed.organizations ?? seed().organizations,
      drafts: parsed.drafts ?? [],
      audit: parsed.audit ?? [],
      suppressions: parsed.suppressions ?? [],
      messageOutcomes: parsed.messageOutcomes ?? [],
      aiUsage: parsed.aiUsage ?? [],
      blastRuns: parsed.blastRuns ?? [],
      blastItems: parsed.blastItems ?? [],
    };
  }
  cache = data;
  persist(data);
  return cache;
}

function persist(data: StoreData): void {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Read-only filesystem (serverless): keep running on the in-memory
    // cache only. See the note at the top of this file.
  }
}

function save(data: StoreData): void {
  cache = data;
  persist(data);
}

// =====================================================================
// Postgres backend (DATABASE_URL set).
// Whole records live in a `data` JSONB column; key columns exist only for
// lookup. Schema bootstrap is memoized per process.
// =====================================================================

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Supabase (and most hosted Postgres) require TLS; the pooler
      // presents a chain node-postgres cannot verify against public CAs.
      ssl: { rejectUnauthorized: false },
      // Serverless: many short-lived processes, each with its own pool —
      // keep it small so the pooler is not exhausted.
      max: 3,
    });
    pool.on("error", (err) => {
      // An idle client error must not take the process down.
      console.error("Postgres pool error:", err);
    });
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = bootstrapSchema().catch((err) => {
      // Do not cache a failed bootstrap — the next call retries.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function bootstrapSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_organizations (
      id text PRIMARY KEY,
      data jsonb NOT NULL
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_drafts (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      data jsonb NOT NULL
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_audit (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      data jsonb NOT NULL
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_suppressions (
      organization_id text NOT NULL,
      value_normalized text NOT NULL,
      data jsonb NOT NULL,
      PRIMARY KEY (organization_id, value_normalized)
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_message_outcomes (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      data jsonb NOT NULL
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_ai_usage (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      data jsonb NOT NULL
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_blast_runs (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      data jsonb NOT NULL
    )`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS wai_blast_items (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      organization_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      data jsonb NOT NULL
    )`);
  // Seed the default organization if absent (same seed as the file store).
  const org = seed().organizations[0];
  await p.query(
    `INSERT INTO wai_organizations (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [org.id, JSON.stringify(org)],
  );
}

// ---------- Organizations ----------

export async function getOrganizations(): Promise<Organization[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: Organization }>(
      `SELECT data FROM wai_organizations ORDER BY id`,
    );
    return rows.map((r) => r.data);
  }
  return load().organizations;
}

// ---------- Drafts ----------

export async function getDrafts(
  organizationId: string = DEFAULT_ORG_ID,
): Promise<Draft[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: Draft }>(
      `SELECT data FROM wai_drafts WHERE organization_id = $1`,
      [organizationId],
    );
    // The file backend returns insertion order; Postgres has no inherent
    // row order, so reproduce it from the record timestamps.
    return rows
      .map((r) => r.data)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }
  return load().drafts.filter((d) => d.organizationId === organizationId);
}

export async function getDraft(id: string): Promise<Draft | undefined> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: Draft }>(
      `SELECT data FROM wai_drafts WHERE id = $1`,
      [id],
    );
    return rows[0]?.data;
  }
  return load().drafts.find((d) => d.id === id);
}

export interface CreateDraftInput {
  feed: Feed;
  contactId?: string;
  to: string;
  subject?: string;
  threadRef?: string;
  body: string;
  organizationId?: string;
}

export async function createDraft(input: CreateDraftInput): Promise<Draft> {
  const draft: Draft = {
    id: randomUUID(),
    organizationId: input.organizationId ?? DEFAULT_ORG_ID,
    feed: input.feed,
    contactId: input.contactId,
    to: input.to,
    subject: input.subject,
    threadRef: input.threadRef,
    body: input.body,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  if (usePostgres()) {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO wai_drafts (id, organization_id, data) VALUES ($1, $2, $3)`,
      [draft.id, draft.organizationId, JSON.stringify(draft)],
    );
    return draft;
  }
  const data = load();
  data.drafts.push(draft);
  save(data);
  return draft;
}

export async function updateDraft(
  id: string,
  patch: Partial<Omit<Draft, "id" | "organizationId">>,
): Promise<Draft | undefined> {
  if (usePostgres()) {
    await ensureSchema();
    const existing = await getDraft(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    await getPool().query(`UPDATE wai_drafts SET data = $2 WHERE id = $1`, [
      id,
      JSON.stringify(updated),
    ]);
    return updated;
  }
  const data = load();
  const idx = data.drafts.findIndex((d) => d.id === id);
  if (idx === -1) return undefined;
  data.drafts[idx] = { ...data.drafts[idx], ...patch };
  save(data);
  return data.drafts[idx];
}

// ---------- Audit ----------

export async function addAudit(
  actor: string,
  action: string,
  detail: Record<string, unknown> = {},
  organizationId: string = DEFAULT_ORG_ID,
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: randomUUID(),
    organizationId,
    at: new Date().toISOString(),
    actor,
    action,
    detail,
  };
  if (usePostgres()) {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO wai_audit (id, organization_id, at, data)
       VALUES ($1, $2, $3, $4)`,
      [entry.id, entry.organizationId, entry.at, JSON.stringify(entry)],
    );
    return entry;
  }
  const data = load();
  data.audit.push(entry);
  save(data);
  return entry;
}

export async function listAudit(
  organizationId: string = DEFAULT_ORG_ID,
  limit = 200,
): Promise<AuditEntry[]> {
  if (usePostgres()) {
    await ensureSchema();
    // Newest `limit` entries, returned oldest-first like the file backend.
    const { rows } = await getPool().query<{ data: AuditEntry }>(
      `SELECT data FROM wai_audit
       WHERE organization_id = $1
       ORDER BY at DESC
       LIMIT $2`,
      [organizationId, limit],
    );
    return rows.map((r) => r.data).reverse();
  }
  const entries = load().audit.filter(
    (e) => e.organizationId === organizationId,
  );
  return entries.slice(-limit);
}

// ---------- Suppressions ----------

export async function isSuppressed(value: string): Promise<boolean> {
  const target = normalizeValue(value);
  if (usePostgres()) {
    await ensureSchema();
    // Matches the file backend: suppression checks are not scoped to one
    // organization — a suppressed value is suppressed, period.
    const { rows } = await getPool().query(
      `SELECT 1 FROM wai_suppressions WHERE value_normalized = $1 LIMIT 1`,
      [target],
    );
    return rows.length > 0;
  }
  return load().suppressions.some(
    (s) => normalizeValue(s.value) === target,
  );
}

export async function addSuppression(
  value: string,
  reason: string,
  organizationId: string = DEFAULT_ORG_ID,
): Promise<Suppression> {
  if (usePostgres()) {
    await ensureSchema();
    const normalized = normalizeValue(value);
    const { rows } = await getPool().query<{ data: Suppression }>(
      `SELECT data FROM wai_suppressions
       WHERE organization_id = $1 AND value_normalized = $2`,
      [organizationId, normalized],
    );
    if (rows[0]) return rows[0].data;
    const suppression: Suppression = {
      organizationId,
      value,
      reason,
      at: new Date().toISOString(),
    };
    await getPool().query(
      `INSERT INTO wai_suppressions (organization_id, value_normalized, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, value_normalized) DO NOTHING`,
      [organizationId, normalized, JSON.stringify(suppression)],
    );
    return suppression;
  }
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

export async function listSuppressions(
  organizationId: string = DEFAULT_ORG_ID,
): Promise<Suppression[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: Suppression }>(
      `SELECT data FROM wai_suppressions WHERE organization_id = $1`,
      [organizationId],
    );
    return rows.map((r) => r.data);
  }
  return load().suppressions.filter(
    (s) => s.organizationId === organizationId,
  );
}

// ---------- Message outcomes (learning-loop seed data) ----------

export interface CreateMessageOutcomeInput {
  draftId: string;
  address: string;
  mode: string;
  variant: "first" | "offer";
  body: string;
  offerAmount?: number;
  contactId?: string;
  organizationId?: string;
}

export async function createMessageOutcome(
  input: CreateMessageOutcomeInput,
): Promise<MessageOutcome> {
  const outcome: MessageOutcome = {
    id: randomUUID(),
    organizationId: input.organizationId ?? DEFAULT_ORG_ID,
    draftId: input.draftId,
    address: input.address,
    mode: input.mode,
    variant: input.variant,
    body: input.body,
    offerAmount: input.offerAmount,
    contactId: input.contactId,
    createdAt: new Date().toISOString(),
  };
  if (usePostgres()) {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO wai_message_outcomes (id, organization_id, created_at, data)
       VALUES ($1, $2, $3, $4)`,
      [outcome.id, outcome.organizationId, outcome.createdAt, JSON.stringify(outcome)],
    );
    return outcome;
  }
  const data = load();
  data.messageOutcomes.push(outcome);
  save(data);
  return outcome;
}

export async function listMessageOutcomes(
  organizationId: string = DEFAULT_ORG_ID,
): Promise<MessageOutcome[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: MessageOutcome }>(
      `SELECT data FROM wai_message_outcomes WHERE organization_id = $1`,
      [organizationId],
    );
    return rows
      .map((r) => r.data)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }
  return load().messageOutcomes.filter(
    (o) => o.organizationId === organizationId,
  );
}

// ---------- AI usage (cost control) ----------

export interface AddAiUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  purpose: string;
  /** Model-selection reason (lib/ai/modelSelect), when applicable. */
  reason?: string;
  organizationId?: string;
}

export async function addAiUsage(
  input: AddAiUsageInput,
): Promise<AiUsageEntry> {
  const entry: AiUsageEntry = {
    id: randomUUID(),
    organizationId: input.organizationId ?? DEFAULT_ORG_ID,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedTokens: input.cachedTokens,
    purpose: input.purpose,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
  if (usePostgres()) {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO wai_ai_usage (id, organization_id, created_at, data)
       VALUES ($1, $2, $3, $4)`,
      [entry.id, entry.organizationId, entry.createdAt, JSON.stringify(entry)],
    );
    return entry;
  }
  const data = load();
  data.aiUsage.push(entry);
  save(data);
  return entry;
}

export async function listAiUsage(
  organizationId: string = DEFAULT_ORG_ID,
): Promise<AiUsageEntry[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: AiUsageEntry }>(
      `SELECT data FROM wai_ai_usage WHERE organization_id = $1`,
      [organizationId],
    );
    return rows
      .map((r) => r.data)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }
  return load().aiUsage.filter((e) => e.organizationId === organizationId);
}

// ---------- Blast runs + items ----------

function byCreated<T extends { createdAt: string; id: string }>(
  rows: T[],
): T[] {
  return rows.sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  );
}

export interface CreateBlastRunInput {
  source: BlastRun["source"];
  stageRef?: { pipelineId: string; stageId: string };
  scriptKey: BlastRun["scriptKey"];
  dailyCap?: number;
  organizationId?: string;
}

export async function createBlastRun(
  input: CreateBlastRunInput,
): Promise<BlastRun> {
  const run: BlastRun = {
    id: randomUUID(),
    organizationId: input.organizationId ?? DEFAULT_ORG_ID,
    source: input.source,
    stageRef: input.stageRef,
    scriptKey: input.scriptKey,
    status: "draft",
    dailyCap: input.dailyCap ?? 250,
    groupSentCount: 0,
    createdAt: new Date().toISOString(),
  };
  if (usePostgres()) {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO wai_blast_runs (id, organization_id, created_at, data)
       VALUES ($1, $2, $3, $4)`,
      [run.id, run.organizationId, run.createdAt, JSON.stringify(run)],
    );
    return run;
  }
  const data = load();
  data.blastRuns.push(run);
  save(data);
  return run;
}

export async function getBlastRun(id: string): Promise<BlastRun | undefined> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: BlastRun }>(
      `SELECT data FROM wai_blast_runs WHERE id = $1`,
      [id],
    );
    return rows[0]?.data;
  }
  return load().blastRuns.find((r) => r.id === id);
}

export async function listBlastRuns(
  organizationId: string = DEFAULT_ORG_ID,
): Promise<BlastRun[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: BlastRun }>(
      `SELECT data FROM wai_blast_runs WHERE organization_id = $1`,
      [organizationId],
    );
    return byCreated(rows.map((r) => r.data));
  }
  return load().blastRuns.filter((r) => r.organizationId === organizationId);
}

export async function updateBlastRun(
  id: string,
  patch: Partial<Omit<BlastRun, "id" | "organizationId">>,
): Promise<BlastRun | undefined> {
  if (usePostgres()) {
    await ensureSchema();
    const existing = await getBlastRun(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    await getPool().query(`UPDATE wai_blast_runs SET data = $2 WHERE id = $1`, [
      id,
      JSON.stringify(updated),
    ]);
    return updated;
  }
  const data = load();
  const idx = data.blastRuns.findIndex((r) => r.id === id);
  if (idx === -1) return undefined;
  data.blastRuns[idx] = { ...data.blastRuns[idx], ...patch };
  save(data);
  return data.blastRuns[idx];
}

export interface CreateBlastItemInput {
  runId: string;
  contactId?: string;
  contactName?: string;
  firstName?: string;
  opportunityId?: string;
  street: string;
  phone?: string;
  status: BlastItem["status"];
  error?: string;
  organizationId?: string;
}

export async function createBlastItems(
  inputs: CreateBlastItemInput[],
): Promise<BlastItem[]> {
  const now = new Date().toISOString();
  const items: BlastItem[] = inputs.map((input) => ({
    id: randomUUID(),
    organizationId: input.organizationId ?? DEFAULT_ORG_ID,
    runId: input.runId,
    contactId: input.contactId,
    contactName: input.contactName,
    firstName: input.firstName,
    opportunityId: input.opportunityId,
    street: input.street,
    phone: input.phone,
    status: input.status,
    error: input.error,
    createdAt: now,
  }));
  if (usePostgres()) {
    await ensureSchema();
    for (const item of items) {
      await getPool().query(
        `INSERT INTO wai_blast_items (id, run_id, organization_id, created_at, data)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          item.id,
          item.runId,
          item.organizationId,
          item.createdAt,
          JSON.stringify(item),
        ],
      );
    }
    return items;
  }
  const data = load();
  data.blastItems.push(...items);
  save(data);
  return items;
}

export async function listBlastItems(runId: string): Promise<BlastItem[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: BlastItem }>(
      `SELECT data FROM wai_blast_items WHERE run_id = $1`,
      [runId],
    );
    return byCreated(rows.map((r) => r.data));
  }
  return load().blastItems.filter((i) => i.runId === runId);
}

export async function listAllBlastItems(
  organizationId: string = DEFAULT_ORG_ID,
): Promise<BlastItem[]> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: BlastItem }>(
      `SELECT data FROM wai_blast_items WHERE organization_id = $1`,
      [organizationId],
    );
    return byCreated(rows.map((r) => r.data));
  }
  return load().blastItems.filter((i) => i.organizationId === organizationId);
}

export async function updateBlastItem(
  id: string,
  patch: Partial<Omit<BlastItem, "id" | "organizationId" | "runId">>,
): Promise<BlastItem | undefined> {
  if (usePostgres()) {
    await ensureSchema();
    const { rows } = await getPool().query<{ data: BlastItem }>(
      `SELECT data FROM wai_blast_items WHERE id = $1`,
      [id],
    );
    const existing = rows[0]?.data;
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    await getPool().query(`UPDATE wai_blast_items SET data = $2 WHERE id = $1`, [
      id,
      JSON.stringify(updated),
    ]);
    return updated;
  }
  const data = load();
  const idx = data.blastItems.findIndex((i) => i.id === id);
  if (idx === -1) return undefined;
  data.blastItems[idx] = { ...data.blastItems[idx], ...patch };
  save(data);
  return data.blastItems[idx];
}

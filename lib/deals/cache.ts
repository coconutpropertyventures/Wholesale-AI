// Property-data cache: one row per normalized address/URL key, so a
// listing pulled once (Apify) or verified once (RentCast) is not paid for
// twice. Postgres table wai_property_cache when DATABASE_URL is set
// (same pool pattern as lib/store/store.ts); an in-memory Map otherwise.
// Cache failures never break a lookup — callers fall through to the API.
import { Pool } from "pg";
import type { DealPrefill } from "@/lib/deals/prefill";

export interface CachedPrefill {
  prefill: DealPrefill;
  source: string; // "apify" | "rentcast" | ...
  fetchedAt: string; // ISO
}

export function cacheKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isFresh(fetchedAt: string, maxAgeDays: number): boolean {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < maxAgeDays * 24 * 60 * 60 * 1000;
}

// ---------- In-memory fallback ----------

const memory = new Map<string, CachedPrefill>();

// ---------- Postgres backend ----------

let pool: Pool | null = null;
let tableReady: Promise<void> | null = null;

function usePostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    pool.on("error", (err) => {
      console.error("Property cache pool error:", err);
    });
  }
  return pool;
}

function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS wai_property_cache (
          key text PRIMARY KEY,
          data jsonb NOT NULL,
          fetched_at timestamptz NOT NULL DEFAULT now()
        )`);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// ---------- API ----------

export async function getCachedPrefill(
  key: string,
  maxAgeDays: number,
): Promise<CachedPrefill | null> {
  const k = cacheKey(key);
  try {
    if (usePostgres()) {
      await ensureTable();
      const { rows } = await getPool().query<{ data: CachedPrefill }>(
        `SELECT data FROM wai_property_cache WHERE key = $1`,
        [k],
      );
      const hit = rows[0]?.data;
      if (hit && isFresh(hit.fetchedAt, maxAgeDays)) return hit;
      return null;
    }
    const hit = memory.get(k);
    if (hit && isFresh(hit.fetchedAt, maxAgeDays)) return hit;
    return null;
  } catch {
    return null; // a broken cache must never break the lookup
  }
}

export async function putCachedPrefill(
  key: string,
  prefill: DealPrefill,
  source: string,
): Promise<void> {
  const k = cacheKey(key);
  const entry: CachedPrefill = {
    prefill,
    source,
    fetchedAt: new Date().toISOString(),
  };
  try {
    if (usePostgres()) {
      await ensureTable();
      await getPool().query(
        `INSERT INTO wai_property_cache (key, data, fetched_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET data = $2, fetched_at = $3`,
        [k, JSON.stringify(entry), entry.fetchedAt],
      );
      return;
    }
    memory.set(k, entry);
  } catch {
    // best-effort: losing a cache write only costs a future re-pull
  }
}

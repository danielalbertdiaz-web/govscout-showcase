// R3 — RFP persistence (impure shell). One current RFP per pool; regenerating
// replaces it (the markdown is the artifact — version history lives in git
// for code, and in the agency's hands for documents).

import { getDb } from "./db";

export type PoolRfp = {
  id: string;
  poolId: string;
  userEmail: string;
  markdown: string;
  generator: "cli" | "skeleton";
  model: string | null;
  createdAt: number;
};

function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pool_rfps (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      markdown TEXT NOT NULL,
      generator TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(pool_id, user_email)
    )
  `);
}

type Row = {
  id: string;
  pool_id: string;
  user_email: string;
  markdown: string;
  generator: string;
  model: string | null;
  created_at: number;
};

export function getPoolRfp(poolId: string, userEmail: string): PoolRfp | null {
  ensureTable();
  const r = getDb()
    .prepare("SELECT * FROM pool_rfps WHERE pool_id = ? AND user_email = ?")
    .get(poolId, userEmail) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id,
    poolId: r.pool_id,
    userEmail: r.user_email,
    markdown: r.markdown,
    generator: r.generator === "cli" ? "cli" : "skeleton",
    model: r.model,
    createdAt: r.created_at,
  };
}

export function savePoolRfp(input: {
  poolId: string;
  userEmail: string;
  markdown: string;
  generator: "cli" | "skeleton";
  model?: string | null;
}): PoolRfp {
  ensureTable();
  const rfp: PoolRfp = {
    id: crypto.randomUUID(),
    poolId: input.poolId,
    userEmail: input.userEmail,
    markdown: input.markdown,
    generator: input.generator,
    model: input.model ?? null,
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO pool_rfps (id, pool_id, user_email, markdown, generator, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pool_id, user_email) DO UPDATE SET
         markdown = excluded.markdown,
         generator = excluded.generator,
         model = excluded.model,
         created_at = excluded.created_at`,
    )
    .run(rfp.id, rfp.poolId, rfp.userEmail, rfp.markdown, rfp.generator, rfp.model, rfp.createdAt);
  return getPoolRfp(input.poolId, input.userEmail)!;
}

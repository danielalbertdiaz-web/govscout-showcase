// Apply pending migrations deterministically, at a moment we choose.
//
// lib/db.ts runs migrations lazily, inside the first getDb() call. That means a
// deploy can finish, report success, and leave the schema on the old version —
// the migration then fires whenever something first touches the database,
// which might be a cron at 03:00 or a user mid-action. The 2026-07-31 deploy of
// migration 032 did exactly this: it reported "Deploy complete" at
// user_version 31 and only migrated when an authenticated request arrived.
//
// scripts/deploy.sh runs this before restarting the service, then asserts the
// version, so schema drift fails the deploy instead of happening later by
// accident.
//
// Usage:
//   node --import tsx scripts/migrate.mts          # apply, print version
//   node --import tsx scripts/migrate.mts --check  # report only, non-zero if pending

import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "migrations");

/** Highest numeric prefix in lib/migrations — the version a full run reaches. */
export function expectedVersion(dir: string = MIGRATIONS_DIR): number {
  const nums = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => Number.parseInt(f.slice(0, 3), 10))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) throw new Error(`no migrations found in ${dir}`);
  const max = Math.max(...nums);
  // A gap means a clean checkout would not reproduce the live schema — the
  // exact failure the untracked 018/019/020/028 files caused.
  const missing: number[] = [];
  for (let i = 1; i <= max; i++) if (!nums.includes(i)) missing.push(i);
  if (missing.length) {
    throw new Error(`migration sequence has gaps: ${missing.join(", ")} — a clean checkout would not reproduce the live schema`);
  }
  return max;
}

const checkOnly = process.argv.includes("--check");
const want = expectedVersion();

const { getDb } = await import("../lib/db");

if (checkOnly) {
  // Read the version without letting the lazy runner apply anything.
  const dbPath = path.join(process.cwd(), "data", "govscout.db");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const have = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  db.close();
  console.log(`user_version=${have} expected=${want}`);
  if (have !== want) {
    console.error(`PENDING: ${want - have} migration(s) not applied`);
    process.exit(1);
  }
  console.log("schema up to date");
  process.exit(0);
}

// Opening the database runs the migration runner.
const db = getDb();
const have = (db.pragma("user_version") as Array<{ user_version: number }>)[0]?.user_version ?? 0;
console.log(`user_version=${have} expected=${want}`);
if (have !== want) {
  console.error(`FAILED: schema is at ${have}, expected ${want} after applying migrations`);
  process.exit(1);
}
console.log("migrations applied");

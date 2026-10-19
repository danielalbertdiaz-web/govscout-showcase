// Import the OpenClaw micro-sweep's CSV output into GovScout (V4.1 §14.6).
//
// The sweep cron triages SAM micro-purchase notices into
// ~/.openclaw/workspace/sam-micro-daily/SWEEP_*/PROCESSED.csv and never told
// GovScout anything: micro_contracts held 0 rows against 295 triaged notices.
//
// Idempotent: upsert is keyed on (user_email, notice_id), and a disposition is
// only written when the row is created — a human's later triage is never
// overwritten by a re-import, the same preserve-on-upsert discipline as the
// federal-pipeline reopen guard.
//
// Usage:
//   node --import tsx scripts/micro-sweep-import.mts --dry-run
//   node --import tsx scripts/micro-sweep-import.mts
//   node --import tsx scripts/micro-sweep-import.mts --sweep <dir>

import fs from "fs";
import os from "os";
import path from "path";
import { parseSweepCsv, mapRows, dedupeByNotice } from "../lib/micro-sweep-import";
import { upsertMicroContract, setMicroContractDisposition } from "../lib/db";

const SWEEP_ROOT = path.join(os.homedir(), ".openclaw", "workspace", "sam-micro-daily");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sweepArgIdx = args.indexOf("--sweep");
const explicitSweep = sweepArgIdx >= 0 ? args[sweepArgIdx + 1] : null;

function newestSweepDir(): string | null {
  if (explicitSweep) return explicitSweep;
  if (!fs.existsSync(SWEEP_ROOT)) return null;
  const candidates = fs
    .readdirSync(SWEEP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("SWEEP_"))
    .map((e) => path.join(SWEEP_ROOT, e.name))
    .filter((d) => fs.existsSync(path.join(d, "PROCESSED.csv")))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

/** The owner rows are filed under. Single-tenant, so the one AUTH_USERS identity. */
function ownerEmail(): string {
  const explicit = process.env.GOVSCOUT_OWNER_EMAIL?.trim();
  if (explicit) return explicit;
  const raw = process.env.AUTH_USERS ?? "";
  const first = raw.split("|")[0]?.split(":")[0]?.trim().toLowerCase();
  if (first) return first;
  throw new Error("cannot determine owner: set GOVSCOUT_OWNER_EMAIL or AUTH_USERS");
}

const sweep = newestSweepDir();
if (!sweep) {
  console.error(`no sweep directory with a PROCESSED.csv under ${SWEEP_ROOT}`);
  process.exit(1);
}

const csvPath = path.join(sweep, "PROCESSED.csv");
const parsed = parseSweepCsv(fs.readFileSync(csvPath, "utf8"));
const rows = dedupeByNotice(mapRows(parsed));

const owner = ownerEmail();
console.log(`sweep:  ${sweep}`);
console.log(`owner:  ${owner}`);
console.log(`parsed: ${parsed.length} rows -> ${rows.length} unique notices`);

const byDisposition = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.disposition] = (acc[r.disposition] ?? 0) + 1;
  return acc;
}, {});
console.log(`mapped: ${Object.entries(byDisposition).map(([k, v]) => `${k}=${v}`).join(" ")}`);

if (dryRun) {
  console.log("\n--dry-run: nothing written. Sample:");
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${r.noticeId.slice(0, 10)}  ${r.disposition.padEnd(8)} ${r.killReason ?? ""}  ${r.title.slice(0, 52)}`);
  }
  process.exit(0);
}

let created = 0;
let updated = 0;
let skippedDeleted = 0;
for (const r of rows) {
  const { record, created: isNew, skippedDeleted: isDeleted } = upsertMicroContract({
    userEmail: owner,
    noticeId: r.noticeId,
    solNumber: r.solicitationNumber,
    title: r.title,
    agency: r.agency,
    noticeType: "micro-purchase",
    naics: r.naics,
    description: r.killReason ? `Sweep verdict: ${r.killReason}` : null,
    postedDate: null,
    responseDeadline: r.responseDeadline,
    setAside: null,
    url: `https://sam.gov/opp/${r.noticeId}/view`,
  });
  if (isDeleted) {
    // Permanently deleted (migration 036): tombstoned notices are never
    // recreated — surfaced here so the skip is visible, not silent.
    skippedDeleted++;
  } else if (isNew) {
    created++;
    // Only on create. A re-import must never overwrite a human's triage.
    if (r.disposition !== "new") {
      setMicroContractDisposition(record.id, owner, r.disposition);
    }
  } else {
    updated++;
  }
}

console.log(
  `\nwrote: ${created} created, ${updated} updated, ${skippedDeleted} skipped (deleted — tombstoned, never re-imported) (dispositions set on create only)`,
);

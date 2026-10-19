/**
 * Pricing-integrity watcher (thin runner; sibling of scripts/health-alert.mts).
 *
 * Run: node --import tsx scripts/pricing-alert.mts
 * Env: GOVSCOUT_PRICING_STATE — reported-rows state JSON path
 *                               (default ~/.openclaw/state/govscout-pricing-watch.json)
 *      GOVSCOUT_ALERT_DRY_RUN — "1" prints alerts instead of sending Telegram
 *      GOVSCOUT_DB            — database path override (default ./data/govscout.db)
 *
 * All decision logic lives in lib/pricing-alert.ts (pure, tested). This file
 * only: reads the production database READ-ONLY (deliberately NOT lib/db.ts's
 * getDb(), which lazily applies pending migrations — a watcher must never
 * mutate what it watches), reads draft files, loads/stores state, and sends
 * the Telegram message.
 *
 * This is a SEPARATE alert from /api/health on purpose: a submitted quote
 * with no price is a data problem, not an outage, and must not turn the
 * liveness roll-up "degraded".
 *
 * Exit code is 0 always — detecting a data problem is SUCCESS for this
 * script, and a nonzero exit under launchd would be confusing.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import {
  decidePricingAlert,
  type PricingRowInput,
  type PricingWatchState,
  type RowText,
} from "../lib/pricing-alert";

const DB_PATH = process.env.GOVSCOUT_DB ?? path.join(process.cwd(), "data", "govscout.db");
const STATE_PATH =
  process.env.GOVSCOUT_PRICING_STATE ??
  path.join(os.homedir(), ".openclaw", "state", "govscout-pricing-watch.json");
const OPENCLAW_BIN = "/opt/homebrew/bin/openclaw";
const TELEGRAM_TARGET = "0000000000";
const MAX_DRAFT_BYTES = 512 * 1024;

type OppRow = {
  id: string;
  sol_number: string | null;
  agency: string | null;
  notice_type: string | null;
  price_quoted: number | null;
  price_basis: string | null;
  result_notes: string | null;
  draft_paths: string | null;
};

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

function readRows(): PricingRowInput[] {
  // readonly + fileMustExist: this connection can never create, migrate, or
  // write the database — safe alongside a concurrent writer (WAL).
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const opps = db
      .prepare(
        `SELECT id, sol_number, agency, notice_type, price_quoted, price_basis,
                result_notes, draft_paths
           FROM fp_opportunities
          WHERE status = 'submitted' AND archived_at IS NULL`,
      )
      .all() as OppRow[];
    const eventsStmt = db.prepare(
      `SELECT detail FROM fp_events WHERE opp_id = ? AND detail IS NOT NULL ORDER BY ts`,
    );
    return opps.map((o) => {
      const texts: RowText[] = [];
      for (const e of eventsStmt.all(o.id) as { detail: string }[]) {
        texts.push({ kind: "event", source: "fp_events", text: e.detail });
      }
      if (o.result_notes) texts.push({ kind: "event", source: "result_notes", text: o.result_notes });
      let draftPaths: string[] = [];
      try {
        draftPaths = o.draft_paths ? (JSON.parse(o.draft_paths) as string[]) : [];
      } catch {
        // Unparseable draft_paths: nothing to scan, the row still classifies.
      }
      for (const raw of draftPaths) {
        const p = expandHome(raw);
        try {
          if (fs.statSync(p).size > MAX_DRAFT_BYTES) continue;
          texts.push({ kind: "draft", source: `draft:${path.basename(p)}`, text: fs.readFileSync(p, "utf8") });
        } catch {
          // Draft file missing/unreadable — scan what we have.
        }
      }
      return {
        id: o.id,
        solNumber: o.sol_number,
        agency: o.agency,
        noticeType: o.notice_type,
        priceQuoted: o.price_quoted == null ? null : Number(o.price_quoted),
        priceBasis: o.price_basis,
        texts,
      };
    });
  } finally {
    db.close();
  }
}

// Missing or corrupt state must never wedge the watcher — but "starting
// fresh" here means a silent re-baseline, so say so loudly.
function loadState(): PricingWatchState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_PATH, "utf8");
  } catch {
    console.error(`pricing-alert: no state file at ${STATE_PATH} — first run, baselining`);
    return null;
  }
  try {
    const s = JSON.parse(raw) as PricingWatchState;
    if (s != null && typeof s === "object" && s.reported != null && typeof s.reported === "object") {
      return s;
    }
    console.error(`pricing-alert: state file ${STATE_PATH} has unexpected shape — re-baselining`);
    return null;
  } catch (err) {
    console.error(
      `pricing-alert: state file ${STATE_PATH} is corrupt (${err instanceof Error ? err.message : String(err)}) — re-baselining`,
    );
    return null;
  }
}

// Atomic write (temp file + rename), same discipline as scripts/health-alert.mts.
function saveState(state: PricingWatchState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_PATH);
}

// Telegram path — same shape as scripts/health-alert.mts sendAlert (kept as a
// per-runner copy, like the state I/O, so the deployed health watcher stays
// untouched).
function sendAlert(text: string): boolean {
  if (process.env.GOVSCOUT_ALERT_DRY_RUN === "1") {
    console.log(`pricing-alert: DRY RUN — would send:\n${text}`);
    return true;
  }
  try {
    execFileSync(
      OPENCLAW_BIN,
      ["message", "send", "--channel", "telegram", "--target", TELEGRAM_TARGET, "-m", text],
      { stdio: ["ignore", "inherit", "inherit"], timeout: 30_000 },
    );
    return true;
  } catch (err) {
    console.error(
      `pricing-alert: telegram send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

try {
  const prev = loadState();
  const rows = readRows();
  const { next, newFindings, baselined, suppressed, alertText } = decidePricingAlert(
    rows,
    prev,
    new Date().toISOString(),
  );

  for (const s of suppressed) {
    console.log(`pricing-alert: suppressed ${s.solNumber ?? s.id} — legitimately unpriced (${s.reason})`);
  }
  for (const b of baselined) {
    console.log(`pricing-alert: baselined (no alert) ${b.condition}: ${b.solNumber ?? "?"} — ${b.detail}`);
  }

  let toPersist = next;
  if (alertText != null) {
    const sent = sendAlert(alertText);
    if (!sent) {
      // Do NOT record undelivered findings as reported — the next run must
      // retry them.
      toPersist = prev ?? { reported: {} };
    }
    console.log(
      `pricing-alert: ${newFindings.length} new finding(s)${sent ? "" : " (send failed — will retry)"}`,
    );
  } else {
    console.log(
      `pricing-alert: ${rows.length} submitted row(s) checked, ` +
        (prev == null ? `baselined ${baselined.length}` : "no new findings"),
    );
  }
  saveState(toPersist);
} catch (err) {
  // A broken watcher run must not look like an outage to launchd.
  console.error(`pricing-alert: run failed: ${err instanceof Error ? err.message : String(err)}`);
}

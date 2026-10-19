// Micro-sweep -> GovScout canonical routing (V4.1 §14.6).
//
// The OpenClaw "Micro-sweep processor" cron writes to
// ~/.openclaw/workspace/sam-micro-daily/SWEEP_*/ as CSV and status files, and
// nothing ever reached GovScout: micro_contracts held 0 rows while the sweep
// had triaged 295 notices. §14.6 forbids exactly this shape — "a high-stakes
// automation appearing integrated while writing to untracked CSV/status files
// only."
//
// Decision (§14.6 asks for one of two designs): micro_contracts becomes the
// canonical staging table for SAM micro-purchase notices. It already has a
// migration, API routes and UI; fp_opportunities stays the Bid Board's
// pursuit-tracking table. Staging holds everything the sweep saw, including
// what it killed and why — the kill reasons are the audit trail for coverage
// claims, so discarding them would make the sweep unverifiable.
//
// Pure parsing/mapping lives here so it is testable without a database.

import { isMicroContractDisposition, type MicroContractDisposition } from "./micro-contracts-types";

export type SweepRow = {
  noticeId: string;
  solicitationNumber: string | null;
  title: string;
  agency: string | null;
  naics: string | null;
  responseDeadline: string | null;
  /** Raw sweep verdict — free text like "killed-naics:561621". Preserved verbatim. */
  rawDisposition: string;
};

export type MappedRow = SweepRow & {
  disposition: MicroContractDisposition;
  /** Why the sweep killed it, when it did. Null for live notices. */
  killReason: string | null;
};

/**
 * Minimal RFC4180-ish CSV line splitter: handles quoted fields containing
 * commas. Titles in the sweep output routinely contain commas.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseSweepCsv(text: string): SweepRow[] {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iNotice = idx("noticeId");
  const iSol = idx("solicitationNumber");
  const iTitle = idx("title");
  const iAgency = idx("agency");
  const iNaics = idx("naics");
  const iDue = idx("responseDeadline");
  const iDisp = idx("disposition");
  if (iNotice < 0 || iTitle < 0) return [];

  const rows: SweepRow[] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const noticeId = (f[iNotice] ?? "").trim();
    if (!noticeId) continue;
    const blank = (v: string | undefined) => {
      const s = (v ?? "").trim();
      return s ? s : null;
    };
    rows.push({
      noticeId,
      solicitationNumber: blank(f[iSol]),
      title: (f[iTitle] ?? "").trim() || "(untitled)",
      agency: blank(f[iAgency]),
      naics: blank(f[iNaics]),
      responseDeadline: blank(f[iDue]),
      rawDisposition: (f[iDisp] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * Map a sweep verdict onto the GovScout disposition vocabulary.
 *
 * The sweep emits free text: "killed-naics:561621", "killed-title-keyword",
 * "foreign-pop-nepal-kathmandu". Anything beginning "killed-" or naming a
 * disqualifier is a pass, with the raw string kept as the reason. A verdict
 * that already matches the vocabulary is honoured. Everything else is "new" —
 * unrecognised must mean "a human should look", never a silent pass.
 */
export function mapDisposition(raw: string): { disposition: MicroContractDisposition; killReason: string | null } {
  const s = raw.trim();
  if (!s) return { disposition: "new", killReason: null };
  if (isMicroContractDisposition(s)) return { disposition: s, killReason: null };
  if (/^killed[-:]/i.test(s) || /^(foreign-pop|out-of-scope|ineligible)/i.test(s)) {
    return { disposition: "passed", killReason: s };
  }
  return { disposition: "new", killReason: null };
}

export function mapRows(rows: SweepRow[]): MappedRow[] {
  return rows.map((r) => ({ ...r, ...mapDisposition(r.rawDisposition) }));
}

/** Last-write-wins dedupe by noticeId, preserving input order. */
export function dedupeByNotice(rows: MappedRow[]): MappedRow[] {
  const byId = new Map<string, MappedRow>();
  for (const r of rows) byId.set(r.noticeId, r);
  return [...byId.values()];
}

/**
 * Track L §2/§4 — State CLPPP (childhood lead poisoning prevention program)
 * ingest, 50-state config-driven.
 * Run: node --import tsx scripts/track-l/ingest-clppp.mts [--phase=seed|verify|all] [--states=OH,VT]
 *
 * seed: builds data/track-l/clppp-config.json from CDC's state-programs index.
 * The live cdc.gov index was reorganized away (verified 2026-07-22, returns
 * 404/no external links), so per spec-§4 intent the seed comes from the
 * archived index at web.archive.org (snapshot 2022-12-05 of
 * cdc.gov/nceh/lead/programs/{st}.htm) — each page carries the state program
 * name, phone, and the outbound link to the live state CLPPP site.
 * verify: hits each configured live state URL (robots-gated), marks
 * working/broken/todo, upserts the state agency + scraped CLPPP contacts, and
 * archives both the CDC snapshot and the live page.
 */
import fs from "fs";
import path from "path";
import { upsertAgency, upsertContact, upsertFundingEvent } from "../../lib/track-l";
import {
  apiFetch,
  fetchPage,
  archiveRaw,
  extractEmails,
  contactPriority,
} from "../../lib/track-l-ingest";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const WAYBACK_TS = "20221205025139";
const cdcArchiveUrl = (st: string) =>
  `http://web.archive.org/web/${WAYBACK_TS}/https://www.cdc.gov/nceh/lead/programs/${st.toLowerCase()}.htm`;

const CONFIG_PATH = path.join(process.cwd(), "data", "track-l", "clppp-config.json");

type ClpppEntry = {
  state: string;
  stateName: string;
  programName: string | null;
  /** live state CLPPP url (from CDC's outbound link, wayback prefix stripped) */
  url: string | null;
  phone: string | null;
  cdcSnapshotUrl: string;
  cdcFunding: { amount: number; from: string | null; to: string | null } | null;
  status: "working" | "broken" | "todo";
  verifiedAt: string | null;
  note: string | null;
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const phase = args.get("phase") ?? "all";
const onlyStates = args.get("states")?.split(",").map((s) => s.trim().toUpperCase()) ?? null;

function loadConfig(): ClpppEntry[] {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as ClpppEntry[];
}

function saveConfig(entries: ClpppEntry[]): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(entries, null, 2));
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#8217;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function seedFromCdcArchive(): Promise<void> {
  const existing = new Map(loadConfig().map((e) => [e.state, e]));
  const states = onlyStates ?? Object.keys(STATE_NAMES);
  for (const st of states) {
    if (existing.get(st)?.url) continue; // already seeded — idempotent
    const entry: ClpppEntry = {
      state: st,
      stateName: STATE_NAMES[st],
      programName: null,
      url: null,
      phone: null,
      cdcSnapshotUrl: cdcArchiveUrl(st),
      cdcFunding: null,
      status: "todo",
      verifiedAt: null,
      note: null,
    };
    try {
      const res = await apiFetch(entry.cdcSnapshotUrl, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? html;
      archiveRaw("clppp-cdc-archive", `${st}.html`, main);
      const text = stripTags(main);

      // Program/parent name: "X Department of (Public )Health ..." near the top.
      const nameM = text.match(
        /((?:[A-Z][A-Za-z']+ ){0,4}(?:Department|Dept\.?) of (?:Public )?Health(?: (?:and|&) [A-Z][A-Za-z ]{2,30})?)/,
      );
      entry.programName = nameM ? nameM[1].trim() : null;
      entry.phone = text.match(/Phone:\s*([0-9()\- .]{7,20})/)?.[1]?.trim() ?? null;

      // CDC cooperative-agreement funding line.
      const fundM = text.match(/received \$([\d,]+)[\s\S]{0,400}?from ([A-Z][a-z]+ \d{1,2}, \d{4}) to ([A-Z][a-z]+ \d{1,2}, \d{4})/);
      if (fundM) {
        const toIso = (s: string) => {
          const t = Date.parse(s);
          return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
        };
        entry.cdcFunding = { amount: Number(fundM[1].replace(/,/g, "")), from: toIso(fundM[2]), to: toIso(fundM[3]) };
      }

      // First outbound (non-CDC) link inside the wayback page = the live state
      // program URL. Strip the wayback prefix.
      const links = [...main.matchAll(/href="(?:https?:\/\/web\.archive\.org)?\/web\/\d+\/(https?:\/\/[^"]+)"/g)]
        .map((m) => m[1])
        .filter((u) => !/cdc\.gov|archive\.org|hhs\.gov|usa\.gov|facebook|twitter/.test(u));
      entry.url = links[0]?.replace(/\/$/, "") ?? null;
      if (!entry.url) entry.note = "no outbound state link on CDC snapshot";
      console.log(`${st}: ${entry.programName ?? "?"} → ${entry.url ?? "NO URL"}`);
    } catch (err) {
      entry.note = `seed failed: ${(err as Error).message}`;
      console.error(`${st}: seed failed — ${(err as Error).message}`);
    }
    existing.set(st, entry);
    saveConfig([...existing.values()].sort((a, b) => a.state.localeCompare(b.state)));
  }
}

async function verifyAndIngest(): Promise<void> {
  const entries = loadConfig();
  const states = onlyStates ?? entries.map((e) => e.state);
  let working = 0;
  for (const entry of entries) {
    if (!states.includes(entry.state)) continue;

    // Every state gets its health-department agency row; the CDC-archived
    // program name is the best available canonical name.
    const agencyName =
      entry.programName ?? `${entry.stateName} Department of Health`;
    const { agency } = upsertAgency({
      name: agencyName,
      state: entry.state,
      type: "STATE_HEALTH",
      website: entry.url,
    });

    // CDC cooperative-agreement funding from the archived page (program OTHER —
    // real, sourced, mostly historical so it won't inflate recency scoring).
    if (entry.cdcFunding?.amount) {
      upsertFundingEvent({
        agencyId: agency.id,
        program: "OTHER",
        amount: entry.cdcFunding.amount,
        awardDate: entry.cdcFunding.from,
        spendDeadline: entry.cdcFunding.to,
        sourceUrl: entry.cdcSnapshotUrl,
      });
    }

    if (!entry.url) {
      entry.status = "todo";
      continue;
    }
    try {
      const page = await fetchPage(entry.url, { waitFor: 2000 });
      if ("blocked" in page) {
        entry.status = "todo";
        entry.note = "robots.txt disallows";
      } else if (page.status >= 200 && page.status < 400 && /lead/i.test(page.content)) {
        entry.status = "working";
        entry.verifiedAt = new Date().toISOString();
        working++;
        archiveRaw("clppp-state", `${entry.state}.md`, page.content);
        for (const e of extractEmails(page.content)) {
          try {
            upsertContact({
              agencyId: agency.id,
              email: e.email,
              name: e.name,
              title: e.title ?? "CLPPP program contact",
              isGeneric: e.isGeneric,
              priority: e.isGeneric ? "P4_GENERIC" : "P1_CLPPP",
              source: "CLPPP",
              sourceUrl: entry.url,
            });
          } catch {
            /* bad email */
          }
        }
      } else {
        entry.status = "broken";
        entry.note = `HTTP ${page.status}${/lead/i.test(page.content) ? "" : " (no lead content)"}`;
      }
    } catch (err) {
      entry.status = "broken";
      entry.note = (err as Error).message;
    }
    console.log(`${entry.state}: ${entry.status}${entry.note ? ` (${entry.note})` : ""}`);
    saveConfig(entries); // partial results commit
  }
  const counts = entries.reduce(
    (acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  console.log(`clppp verify done: ${JSON.stringify(counts)} (${working} verified working this run)`);
}

if (phase === "seed" || phase === "all") await seedFromCdcArchive();
if (phase === "verify" || phase === "all") await verifyAndIngest();

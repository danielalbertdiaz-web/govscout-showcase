/**
 * Track L §2/§4 — NACCHO local-health-department directory ingest.
 * Run: node --import tsx scripts/track-l/ingest-naccho.mts [--mode=directory|contacts|all] [--states=VT,OH] [--max-sites=N]
 *
 * directory: per-state GET on the public LHD directory (Cloudflare-fronted →
 * self-hosted Firecrawl), parse dept cards → upsertAgency (LOCAL_HEALTH),
 * raw page archived per state.
 * contacts: the §4 two-hop — for each agency with a website and no contacts,
 * fetch the site (robots-gated) + up to 2 contact-ish subpages, extract
 * emails, upsertContact. Partial results commit as we go; safe to kill and
 * re-run (skips agencies that already have contacts).
 */
import { getDb } from "../../lib/db";
import { upsertAgency, upsertContact } from "../../lib/track-l";
import { TRACK_L_TENANT } from "../../lib/track-l-types";
import {
  fetchPage,
  firecrawlScrape,
  archiveRaw,
  extractEmails,
  contactPriority,
  sleep,
} from "../../lib/track-l-ingest";

const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
];

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const mode = args.get("mode") ?? "all";
const states = args.get("states")?.split(",").map((s) => s.trim().toUpperCase()) ?? ALL_STATES;
const maxSites = Number(args.get("max-sites") ?? Infinity);

const DIR_URL = (st: string) =>
  `https://www.naccho.org/membership/lhd-directory?searchType=standard&lhd-search=&lhd-state=${st}`;

type DirEntry = { name: string; city: string | null; state: string; website: string | null };

/** Parse the directory result markdown: cards are `#### <State>` then
 * `### <Dept name>` then address lines, phone, and a Visit Website link. */
function parseDirectoryMarkdown(md: string, expectState: string): DirEntry[] {
  const out: DirEntry[] = [];
  const blocks = md.split(/^### (?!#)/m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const name = lines[0]?.trim();
    if (!name || name.length < 3 || /^(Search|Grid|List)/.test(name)) continue;
    const cityMatch = block.match(/^([A-Za-z .'-]+),\s*([A-Z]{2})\s+\d{5}/m);
    const web = block.match(/\[Visit Website\]\((https?:\/\/[^)\s]+)\)/);
    const state = cityMatch?.[2] ?? expectState;
    if (state !== expectState) continue; // stray card from another state block
    out.push({
      name: name.replace(/\s+/g, " "),
      city: cityMatch?.[1]?.trim() ?? null,
      state,
      website: web?.[1]?.replace(/\/$/, "") ?? null,
    });
  }
  return out;
}

/** County inference: "Madison County Health Department" → "Madison". Only from
 * the agency's own name — never guessed from geography. */
function countyFromName(name: string): string | null {
  const m = name.match(/^(.*?)\s+(?:County|Parish|Borough)\b/i);
  if (!m) return null;
  const county = m[1].replace(/^(the|and)\s+/i, "").trim();
  return county.length >= 3 && county.length <= 40 ? county : null;
}

async function runDirectory(): Promise<void> {
  let total = 0;
  let created = 0;
  for (const st of states) {
    try {
      const page = await firecrawlScrape(DIR_URL(st), { waitFor: 2500 });
      if (!page.content.includes("Visit Website") && !/#### /.test(page.content)) {
        console.log(`${st}: no cards rendered (len ${page.content.length}) — skipping`);
        continue;
      }
      archiveRaw("naccho", `directory-${st}.md`, page.content);
      const entries = parseDirectoryMarkdown(page.content, st);
      for (const e of entries) {
        const res = upsertAgency({
          name: e.name,
          state: e.state,
          type: "LOCAL_HEALTH",
          county: countyFromName(e.name),
          website: e.website,
        });
        total++;
        if (res.created) created++;
      }
      console.log(`${st}: ${entries.length} departments (${created} new so far)`);
    } catch (err) {
      console.error(`${st}: FAILED — ${(err as Error).message}`);
    }
  }
  console.log(`directory done: ${total} cards processed, ${created} agencies created`);
}

// --- two-hop contacts --------------------------------------------------------

const CONTACT_LINK_RE =
  /href="((?:https?:\/\/|\/)[^"]*(?:contact|staff|directory|about|leadership|administration)[^"]*)"/gi;

function pickContactLinks(html: string, base: string): string[] {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(CONTACT_LINK_RE.source, "gi");
  while ((m = re.exec(html)) !== null && seen.size < 6) {
    try {
      const u = new URL(m[1], base);
      if (u.hostname !== new URL(base).hostname) continue;
      if (/\.(pdf|jpg|png|docx?)$/i.test(u.pathname)) continue;
      u.hash = "";
      seen.add(u.toString());
    } catch {
      /* bad href */
    }
  }
  // Prefer explicit contact pages, then staff/directory.
  return [...seen]
    .sort((a, b) => {
      const rank = (s: string) => (/contact/i.test(s) ? 0 : /staff|directory/i.test(s) ? 1 : 2);
      return rank(a) - rank(b);
    })
    .slice(0, 2);
}

async function harvestContactsForAgency(agency: {
  id: string;
  website: string;
}): Promise<number> {
  const pages: string[] = [];
  const first = await fetchPage(agency.website, { waitFor: 1500 });
  if ("blocked" in first) return 0;
  pages.push(first.content);
  if (first.html) {
    for (const link of pickContactLinks(first.html, agency.website)) {
      const sub = await fetchPage(link, { waitFor: 1200 });
      if (!("blocked" in sub)) pages.push(sub.content);
    }
  }
  let added = 0;
  for (const text of pages) {
    for (const e of extractEmails(text)) {
      try {
        const res = upsertContact({
          agencyId: agency.id,
          email: e.email,
          name: e.name,
          title: e.title,
          isGeneric: e.isGeneric,
          priority: contactPriority(e),
          source: "DEPT_SITE",
          sourceUrl: agency.website,
        });
        if (res.created) added++;
      } catch {
        /* invalid email string — skip */
      }
    }
  }
  return added;
}

async function runContacts(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.state, a.website
         FROM trackl_agencies a
        WHERE a.tenant_id = ? AND a.website IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM trackl_contacts c WHERE c.agency_id = a.id)
        ORDER BY a.state, a.name`,
    )
    .all(TRACK_L_TENANT) as Array<{ id: string; name: string; state: string; website: string }>;
  const capped = rows.filter((r) => states.includes(r.state)).slice(0, maxSites);
  console.log(`two-hop contacts: ${capped.length} agencies to visit (of ${rows.length} without contacts)`);
  let visited = 0;
  let totalAdded = 0;
  for (const r of capped) {
    try {
      const added = await harvestContactsForAgency(r);
      totalAdded += added;
      if (added > 0) console.log(`  ${r.state} ${r.name}: +${added} contacts`);
    } catch (err) {
      console.error(`  ${r.state} ${r.name}: ${(err as Error).message}`);
    }
    visited++;
    if (visited % 50 === 0) console.log(`  … ${visited}/${capped.length} sites, ${totalAdded} contacts so far`);
    await sleep(150);
  }
  console.log(`contacts done: ${visited} sites visited, ${totalAdded} contacts added`);
}

if (mode === "directory" || mode === "all") await runDirectory();
if (mode === "contacts" || mode === "all") await runContacts();

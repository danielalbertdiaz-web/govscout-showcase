// Track L ingestion shared layer (spec §2): robots.txt gate, per-host rate
// limiting, fetch with Firecrawl fallback for bot-protected hosts, raw-page
// archiving. Every job file under scripts/track-l/ goes through these helpers
// so the politeness rules live in exactly one place.

import { getArchiveStore } from "./track-l-storage";

export const FIRECRAWL_URL = process.env.FIRECRAWL_URL ?? "http://localhost:3002";
const USER_AGENT =
  "GovScoutTrackL/1.0 (public-data research; contact: owner@example.org)";

// Per-host minimum spacing between requests. Public APIs tolerate more; HTML
// hosts get the polite default.
const DEFAULT_HOST_INTERVAL_MS = 1500;
const HOST_INTERVALS: Record<string, number> = {
  "api.usaspending.gov": 350,
  "api.census.gov": 350,
  "web.archive.org": 1200,
  localhost: 0,
};

const lastRequestAt = new Map<string, number>();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeWait(url: string): Promise<void> {
  const host = new URL(url).hostname;
  const interval = HOST_INTERVALS[host] ?? DEFAULT_HOST_INTERVAL_MS;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + interval - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

// --- robots.txt (spec: robots.txt is law) -----------------------------------

type RobotsRules = { disallow: string[] };
const robotsCache = new Map<string, RobotsRules | null>(); // null = no robots

function parseRobots(text: string): RobotsRules {
  // Minimal parser: collect Disallow lines for User-agent: * blocks.
  const disallow: string[] = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") applies = val === "*";
    else if (key === "disallow" && applies && val) disallow.push(val);
  }
  return { disallow };
}

export async function robotsAllowed(url: string): Promise<boolean> {
  const u = new URL(url);
  const origin = u.origin;
  if (!robotsCache.has(origin)) {
    try {
      await politeWait(`${origin}/robots.txt`);
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok && (res.headers.get("content-type") ?? "").includes("text")) {
        robotsCache.set(origin, parseRobots(await res.text()));
      } else {
        robotsCache.set(origin, null); // 404 / HTML error page → no rules
      }
    } catch {
      robotsCache.set(origin, null);
    }
  }
  const rules = robotsCache.get(origin);
  if (!rules) return true;
  const path = u.pathname;
  return !rules.disallow.some((d) => path.startsWith(d.replace(/\*$/, "")));
}

// --- fetch + Firecrawl fallback ---------------------------------------------

export type FetchedPage = {
  url: string;
  status: number;
  /** markdown when via firecrawl, raw body otherwise */
  content: string;
  html: string | null;
  via: "fetch" | "firecrawl";
};

/** Plain fetch (APIs, friendly hosts). Rate-limited; NOT robots-gated — use
 * fetchPage for scraping HTML. */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  await politeWait(url);
  return fetch(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
}

export async function firecrawlScrape(
  url: string,
  opts: { waitFor?: number; timeoutMs?: number } = {},
): Promise<FetchedPage> {
  await politeWait(url); // spacing applies to the target host, not localhost
  const res = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["markdown", "html"],
      waitFor: opts.waitFor ?? 2000,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!res.ok) throw new Error(`firecrawl HTTP ${res.status} for ${url}`);
  const body = (await res.json()) as {
    success: boolean;
    data?: { markdown?: string; html?: string; metadata?: { statusCode?: number } };
    error?: string;
  };
  if (!body.success || !body.data) throw new Error(`firecrawl failed for ${url}: ${body.error ?? "?"}`);
  return {
    url,
    status: body.data.metadata?.statusCode ?? 200,
    content: body.data.markdown ?? "",
    html: body.data.html ?? null,
    via: "firecrawl",
  };
}

/**
 * Scrape an HTML page politely: robots gate → plain fetch → Firecrawl fallback
 * when blocked (403/503/challenge) or when forceBrowser is set.
 */
export async function fetchPage(
  url: string,
  opts: { forceBrowser?: boolean; waitFor?: number } = {},
): Promise<FetchedPage | { blocked: "robots" }> {
  if (!(await robotsAllowed(url))) return { blocked: "robots" };
  if (!opts.forceBrowser) {
    try {
      const res = await apiFetch(url, { redirect: "follow" });
      const text = await res.text();
      if (res.ok && text.length > 500) {
        return { url, status: res.status, content: text, html: text, via: "fetch" };
      }
      if (res.ok) return { url, status: res.status, content: text, html: text, via: "fetch" };
      if (![403, 429, 503].includes(res.status)) {
        return { url, status: res.status, content: text, html: text, via: "fetch" };
      }
      // fall through to firecrawl on bot-blocked statuses
    } catch {
      // network error → try firecrawl
    }
  }
  return firecrawlScrape(url, { waitFor: opts.waitFor });
}

// --- raw archiving (spec §2: every ingested page archived w/ timestamp) -----

export function archiveRaw(source: string, name: string, content: string): string {
  return getArchiveStore().put(source, name, content);
}

// --- email extraction (two-hop contact scraping) ----------------------------

const GENERIC_LOCALPARTS = new Set([
  "info", "contact", "contactus", "health", "admin", "administrator", "office",
  "webmaster", "publichealth", "general", "questions", "frontdesk", "reception",
  "clerk", "mail", "email", "support", "hello", "communications", "media",
  "press", "pio", "outreach", "wellness", "environmental", "eh", "records",
  "vitalrecords", "hr", "jobs", "careers", "privacy", "foia", "helpdesk",
]);

const EMAIL_RE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/g;

const JUNK_EMAIL_RE =
  /\.(png|jpe?g|gif|svg|webp|css|js)$|example\.com|sentry|wixpress|@(2x|3x)\./i;

export type ExtractedEmail = {
  email: string;
  /** Person name when one could be attributed from surrounding text or a
   * first.last local part; null → generic/unattributed. */
  name: string | null;
  title: string | null;
  isGeneric: boolean;
};

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const TITLE_KEYWORDS: Array<[RegExp, string]> = [
  [/lead\s+(program|poisoning|prevention)|clppp/i, "CLPPP / lead program"],
  [/health\s+officer|health\s+commissioner|health\s+director|medical\s+director/i, "Health officer"],
  [/public\s+information|communications?\s+(officer|director)|press/i, "PIO"],
  [/director|administrator|manager|coordinator|supervisor/i, "Director/Coordinator"],
  [/epidemiolog/i, "Epidemiologist"],
  [/nurse|nursing/i, "Nursing"],
];

/** Pull emails from page text; attribute a person name when the surrounding
 * text (±160 chars) contains a clean Name pattern, or the local part is a
 * first.last token pair. Conservative: no name found → name stays null. */
export function extractEmails(text: string): ExtractedEmail[] {
  const seen = new Map<string, ExtractedEmail>();
  let m: RegExpExecArray | null;
  const re = new RegExp(EMAIL_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    const email = m[0].toLowerCase().replace(/\.+$/, "");
    if (JUNK_EMAIL_RE.test(email)) continue;
    if (seen.has(email)) continue;
    const local = email.split("@")[0];
    const localClean = local.replace(/[^a-z]/g, "");
    const isGeneric = GENERIC_LOCALPARTS.has(localClean) || GENERIC_LOCALPARTS.has(local);

    // name from context: "Jane Q. Smith ... jane.smith@..."
    const ctx = text.slice(Math.max(0, m.index - 160), m.index + email.length + 160);
    let name: string | null = null;
    const nameMatch = ctx.match(
      /\b([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s*(?:,|\n|·|\||–|-|\()/,
    );
    if (nameMatch && !/^(Contact|Email|Phone|Public|Health|County|City|State|About|Visit|Department)\b/.test(nameMatch[1])) {
      name = nameMatch[1].replace(/\s+/g, " ").trim();
    }
    if (!name && !isGeneric) {
      const parts = local.split(/[._]/).filter((p) => /^[a-z]{2,}$/.test(p));
      if (parts.length === 2) name = titleCase(`${parts[0]} ${parts[1]}`);
    }
    let title: string | null = null;
    for (const [kw, label] of TITLE_KEYWORDS) {
      if (kw.test(ctx)) {
        title = label;
        break;
      }
    }
    seen.set(email, { email, name, title, isGeneric });
  }
  return [...seen.values()];
}

/** Map an extracted email to the §1 contact priority. */
export function contactPriority(e: ExtractedEmail): "P1_CLPPP" | "P2_HEALTH_OFFICER" | "P3_PIO" | "P4_GENERIC" {
  if (e.title === "CLPPP / lead program") return "P1_CLPPP";
  if (e.title === "Health officer" || e.title === "Director/Coordinator") return "P2_HEALTH_OFFICER";
  if (e.title === "PIO") return "P3_PIO";
  if (e.name && !e.isGeneric) return "P3_PIO";
  return "P4_GENERIC";
}

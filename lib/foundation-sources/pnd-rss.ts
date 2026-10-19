// Item 5.1 — Philanthropy News Digest (PND) RFP feed adapter (free).
//
// PND publishes an RSS feed of open Requests for Proposals from US foundations.
// The XML parser is PURE and unit-tested; the live `fetch` is a thin shell so
// tests never hit the network. We respect PND's feed by reading the published
// RSS only (no scraping) and filtering to Acme's focus keywords on the way in.
//
// Feed: https://philanthropynewsdigest.org/rfps/feed

import type { FoundationGrant, FoundationQuery, FoundationSource } from "./types";
import { FOUNDATION_FOCUS_KEYWORDS, grantMatchesKeywords } from "./types";

export const PND_RFP_FEED = "https://philanthropynewsdigest.org/rfps/feed";

// Minimal RSS field extractor — pulls the first <tag>…</tag> (CDATA-tolerant).
function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  let v = m[1].trim();
  // strip a CDATA wrapper if present
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1].trim();
  return v || null;
}

// Strip HTML tags + collapse whitespace + decode the few entities PND emits.
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// PND item titles look like "Foundation Name Invites Applications for <Program>".
// Pull the funder out as everything before the first " Invites"/" Seeks"/" Accepts".
export function splitFunderFromTitle(title: string): { funder: string | null; title: string } {
  const m = title.match(/^(.*?)\s+(?:invites?|seeks?|accepts?|announces?|offers?|requests?)\b/i);
  if (m && m[1].trim().length > 0) {
    return { funder: m[1].trim(), title: title.trim() };
  }
  return { funder: null, title: title.trim() };
}

// Pure: parse a PND RSS document into normalized foundation grants.
export function parsePndRss(xml: unknown): FoundationGrant[] {
  if (typeof xml !== "string" || xml.length === 0) return [];
  const out: FoundationGrant[] = [];
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const block of items) {
    const rawTitle = tag(block, "title");
    if (!rawTitle) continue;
    const title = stripHtml(rawTitle);
    if (!title) continue;
    const link = tag(block, "link");
    const descRaw = tag(block, "description");
    const summary = descRaw ? stripHtml(descRaw) : null;
    // PND tags items with <category> entries (focus areas / subjects).
    const categories = (block.match(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi) ?? [])
      .map((c) => stripHtml(c.replace(/<\/?category(?:\s[^>]*)?>/gi, "")))
      .filter(Boolean);
    const { funder } = splitFunderFromTitle(title);

    out.push({
      funder: funder ?? "Unknown foundation",
      title,
      url: link ? link.trim() : null,
      summary,
      // PND surfaces the deadline inside the description, not a dedicated field.
      deadlineText: extractDeadline(summary),
      focusAreas: categories,
      geography: null,
      fundingMin: null,
      fundingMax: null,
      applicationCycle: null,
      decisionTimeline: null,
      source: "pnd_rss",
    });
  }
  return out;
}

// Pure: best-effort deadline phrase out of a description ("...deadline is June 30, 2026...").
export function extractDeadline(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(
    /\b(?:deadline|due|applications?\s+(?:are\s+)?due|closes?)\b[^.]*?(\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b)/i,
  );
  return m ? m[1].trim() : null;
}

// --- live adapter (thin fetch shell) ---------------------------------------

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "GovScout/5.1 (research)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const pndRssSource: FoundationSource = {
  id: "pnd_rss",
  available: true, // free, no key required
  async fetch(query: FoundationQuery): Promise<FoundationGrant[]> {
    const xml = await fetchText(PND_RFP_FEED);
    const all = parsePndRss(xml);
    const keywords = query.keywords ?? [...FOUNDATION_FOCUS_KEYWORDS];
    const filtered = all.filter((g) => grantMatchesKeywords(g, keywords));
    return typeof query.limit === "number" ? filtered.slice(0, query.limit) : filtered;
  },
};

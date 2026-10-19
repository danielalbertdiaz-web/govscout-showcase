// Item 5.2 — teaming-source registry. Fans a TeamingQuery across every available
// source, merges + de-dupes the results. Mirrors the foundation/nonprofit source
// registries. Today there is one source (SAM.gov, a dark seam); the registry
// shape means a second feed (e.g. a state subaward board) drops in cleanly.

import { samGovSource } from "./sam-gov";
import {
  type TeamingNotice,
  type TeamingQuery,
  type TeamingSource,
  naicsMatches,
  DEFAULT_TARGET_NAICS,
} from "./types";

export * from "./types";
export { samGovSource } from "./sam-gov";

const ALL_SOURCES: TeamingSource[] = [samGovSource];

export function allTeamingSources(): TeamingSource[] {
  return ALL_SOURCES;
}

export function availableTeamingSources(): TeamingSource[] {
  return ALL_SOURCES.filter((s) => s.available);
}

// Stable identity for de-dupe: provider noticeId, else url, else title+agency.
export function teamingNoticeKey(n: {
  noticeId?: string | null;
  url?: string | null;
  title?: string | null;
  agency?: string | null;
}): string {
  const id = n.noticeId?.trim().toLowerCase();
  if (id) return `id:${id}`;
  const url = n.url?.trim().toLowerCase();
  if (url) return `url:${url}`;
  const title = (n.title ?? "").trim().toLowerCase();
  const agency = (n.agency ?? "").trim().toLowerCase();
  return `ta:${title}|${agency}`;
}

export type TeamingSearchResult = {
  notices: TeamingNotice[];
  sourcesUsed: string[];
};

// Run every available source, merge, de-dupe, and post-filter by NAICS (a source
// may over-return). Uses allSettled so one slow/failing feed never sinks the run.
export async function searchTeamingSources(query: TeamingQuery): Promise<TeamingSearchResult> {
  const sources = availableTeamingSources();
  const settled = await Promise.allSettled(sources.map((s) => s.fetch(query)));

  const target = query.naics?.length ? query.naics : DEFAULT_TARGET_NAICS;
  const seen = new Set<string>();
  const notices: TeamingNotice[] = [];
  const sourcesUsed: string[] = [];

  settled.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    let used = false;
    for (const n of res.value) {
      if (!naicsMatches(n.naics, target)) continue;
      const key = teamingNoticeKey(n);
      if (seen.has(key)) continue;
      seen.add(key);
      notices.push(n);
      used = true;
    }
    if (used) sourcesUsed.push(sources[i].id);
  });

  return { notices, sourcesUsed };
}

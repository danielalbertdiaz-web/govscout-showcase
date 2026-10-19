import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listSavedSourceIds } from "@/lib/db";
import {
  readLatestGovScoutDigests,
  searchGrantsGov,
  searchSamGov,
  type SearchFilters,
  type SearchResult,
  type SearchSource,
} from "@/lib/search";
import { suggestCorrection } from "@/lib/search-spelling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SourceError = { source: SearchSource; message: string };

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const filters: SearchFilters = {
    q: sp.get("q") ?? "",
    agency: sp.get("agency") ?? "",
    naics: sp.get("naics") ?? "",
    deadlineFrom: sp.get("deadlineFrom") ?? "",
    deadlineTo: sp.get("deadlineTo") ?? "",
    status: (sp.get("status") as SearchFilters["status"]) ?? "open",
    source: (sp.get("source") as SearchFilters["source"]) ?? "all",
    rows: clampInt(sp.get("rows"), 25, 1, 100),
  };
  const fundingFloorMinRaw = sp.get("fundingFloorMin");
  const fundingCeilingMaxRaw = sp.get("fundingCeilingMax");
  if (fundingFloorMinRaw) filters.fundingFloorMin = Number(fundingFloorMinRaw) || undefined;
  if (fundingCeilingMaxRaw) filters.fundingCeilingMax = Number(fundingCeilingMaxRaw) || undefined;

  const wantSource = filters.source ?? "all";
  const errors: SourceError[] = [];
  let results = await runSourceSearches(filters, wantSource, errors);

  // Typo tolerance (P14): the upstream APIs match keywords exactly, so a
  // misspelled query ("opiod") silently returns nothing. On a whiff, retry
  // once with the nearest domain-vocabulary spelling and tell the UI.
  let correctedQuery: string | null = null;
  const rawQ = filters.q ?? "";
  if (results.length === 0 && rawQ.trim()) {
    const suggestion = suggestCorrection(rawQ);
    if (suggestion) {
      const retried = await runSourceSearches({ ...filters, q: suggestion }, wantSource, errors);
      if (retried.length > 0) {
        results = retried;
        correctedQuery = suggestion;
      }
    }
  }

  let digests: ReturnType<typeof readLatestGovScoutDigests> = [];
  if (wantSource === "all" || wantSource === "govscout") {
    try {
      digests = readLatestGovScoutDigests(3);
    } catch {
      /* digests are best-effort */
    }
  }

  const savedSet = listSavedSourceIds(session.email);
  const decorated = results.map((r) => ({
    ...r,
    saved: savedSet.has(`${r.source}:${r.sourceId}`),
  }));

  return Response.json({
    results: decorated,
    digests,
    errors,
    filters,
    correctedQuery,
    counts: {
      total: decorated.length,
      bySource: countBy(decorated.map((r) => r.source)),
    },
  });
}

async function runSourceSearches(
  filters: SearchFilters,
  wantSource: SearchFilters["source"],
  errors: SourceError[],
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const tasks: Promise<void>[] = [];

  if (wantSource === "all" || wantSource === "grants_gov") {
    tasks.push(
      searchGrantsGov(filters)
        .then((r) => {
          results.push(...r);
        })
        .catch((err: unknown) => {
          errors.push({ source: "grants_gov", message: err instanceof Error ? err.message : String(err) });
        }),
    );
  }

  if (wantSource === "all" || wantSource === "sam_gov") {
    const samKey = process.env.SAM_GOV_API_KEY;
    if (samKey) {
      tasks.push(
        searchSamGov(filters, samKey)
          .then((r) => {
            results.push(...r);
          })
          .catch((err: unknown) => {
            errors.push({ source: "sam_gov", message: err instanceof Error ? err.message : String(err) });
          }),
      );
    } else if (wantSource === "sam_gov") {
      errors.push({
        source: "sam_gov",
        message: "SAM_GOV_API_KEY not configured. Register at https://open.gsa.gov/api/get-opportunities-public-api/ and add to env.",
      });
    }
  }

  await Promise.all(tasks);
  return results;
}

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  if (!raw) return dflt;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function countBy<T extends string>(arr: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}

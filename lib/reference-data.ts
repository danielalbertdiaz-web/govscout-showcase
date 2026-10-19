// Item 4.4 — thin fs shell over the reference dataset pure core.
// Reads the version-controlled seed at data/reference/index.json (override with
// REFERENCE_DATA_DIR). Cached briefly like the partner index. NEVER throws on a
// missing/corrupt file — returns an empty dataset so callers degrade gracefully.

import { promises as fs } from "fs";
import path from "path";
import {
  normalizeReferenceDataset,
  type ReferenceDataset,
} from "./reference-orgs";

function referenceDir(): string {
  const override = process.env.REFERENCE_DATA_DIR?.trim();
  if (override) return override;
  return path.join(process.cwd(), "data", "reference");
}

const CACHE_TTL_MS = 5_000;
let cache: { at: number; data: ReferenceDataset } | null = null;

const EMPTY: ReferenceDataset = { orgs: [], metadata: {} };

export async function loadReferenceData(): Promise<ReferenceDataset> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  const indexPath = path.join(referenceDir(), "index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const data = normalizeReferenceDataset(JSON.parse(raw));
    cache = { at: now, data };
    return data;
  } catch {
    return EMPTY;
  }
}

// Track L raw-source archive store (spec §2: every ingested page/JSON is
// archived with a timestamp). Local-disk implementation for the v5 fallback
// build; the R2 adapter is a stub so the SaaS migration is a config swap,
// not a refactor. Keys returned here land in trackl_funding_events
// .raw_archive_key and in per-job manifests.

import fs from "fs";
import path from "path";

export interface RawArchiveStore {
  /** Persist raw content; returns the storage key. */
  put(source: string, name: string, content: string | Buffer): string;
  /** Read back a previously archived blob (null if missing). */
  get(key: string): Buffer | null;
}

const ARCHIVE_DIR = path.join(process.cwd(), "data", "track-l-archives");

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

class LocalDiskStore implements RawArchiveStore {
  put(source: string, name: string, content: string | Buffer): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const key = path.join(safeName(source), `${ts}__${safeName(name)}`);
    const full = path.join(ARCHIVE_DIR, key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return key;
  }

  get(key: string): Buffer | null {
    const full = path.join(ARCHIVE_DIR, key);
    // Refuse traversal outside the archive root.
    if (!path.resolve(full).startsWith(path.resolve(ARCHIVE_DIR))) return null;
    return fs.existsSync(full) ? fs.readFileSync(full) : null;
  }
}

// Stub for the SaaS repo's Cloudflare R2 bucket. Wire with @aws-sdk/client-s3
// (R2 is S3-compatible) + R2_BUCKET/R2_ACCOUNT_ID/R2_ACCESS_KEY envs when the
// module migrates. Keeping the class here documents the seam.
class R2Store implements RawArchiveStore {
  put(): string {
    throw new Error("R2 archive store not configured in the local v5 build (set TRACK_L_STORAGE=local)");
  }
  get(): Buffer | null {
    throw new Error("R2 archive store not configured in the local v5 build (set TRACK_L_STORAGE=local)");
  }
}

let store: RawArchiveStore | null = null;

export function getArchiveStore(): RawArchiveStore {
  if (store) return store;
  store = process.env.TRACK_L_STORAGE === "r2" ? new R2Store() : new LocalDiskStore();
  return store;
}

export function archiveDir(): string {
  return ARCHIVE_DIR;
}

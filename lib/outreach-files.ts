// Item 4.2 — outreach draft persistence (thin fs shell).
//
// Pre-drafted intros are written to outreach/{rfp_id}/{partner}-intro.md so the
// operator can review/edit them in-repo. The directory is gitignored (these are
// working drafts, not source). NOTHING here sends anything — it only writes a
// file to disk. The path builder is pure so tests can assert it without fs.

import { promises as fs } from "fs";
import path from "path";

const DEFAULT_OUTREACH_DIR = path.join(process.cwd(), "outreach");

export function outreachDir(): string {
  return process.env.OUTREACH_DIR?.trim() || DEFAULT_OUTREACH_DIR;
}

// Defensive slug so an id with slashes/spaces can't escape the outreach root.
function safeSegment(s: string): string {
  return (
    s
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, "-") // collapse ".." so an id can't traverse upward
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "unknown"
  );
}

// Pure: where an intro draft for (rfpId, partnerId) lives, relative to the
// outreach root. Exposed for tests + UI labels.
export function introDraftRelPath(rfpId: string, partnerId: string): string {
  return path.join(safeSegment(rfpId), `${safeSegment(partnerId)}-intro.md`);
}

export function introDraftPath(rfpId: string, partnerId: string): string {
  return path.join(outreachDir(), introDraftRelPath(rfpId, partnerId));
}

// Write (or overwrite) an intro draft. Returns the absolute path written.
export async function writeIntroDraft(
  rfpId: string,
  partnerId: string,
  markdown: string,
): Promise<string> {
  const file = introDraftPath(rfpId, partnerId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, markdown, "utf8");
  return file;
}

// Read back an existing draft, or null if none has been generated yet.
export async function readIntroDraft(
  rfpId: string,
  partnerId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(introDraftPath(rfpId, partnerId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

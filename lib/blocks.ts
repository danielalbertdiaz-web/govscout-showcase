import { promises as fs } from "fs";
import path from "path";

export type CapabilityBlock = {
  id: string;
  filename: string;
  title: string;
  summary: string;
};

const BLOCKS_DIR = path.join(process.cwd(), "data", "blocks");

const META: Record<string, { title: string; summary: string }> = {
  "01-org-overview.md": {
    title: "Acme Consulting — Organizational Overview",
    summary: "Drop-in agency background paragraphs (short / medium).",
  },
};

export async function listBlocks(): Promise<CapabilityBlock[]> {
  const entries = await fs.readdir(BLOCKS_DIR);
  return entries
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((filename) => ({
      id: filename.replace(/\.md$/, ""),
      filename,
      title: META[filename]?.title ?? filename,
      summary: META[filename]?.summary ?? "",
    }));
}

export async function loadBlocks(ids: string[]): Promise<{ id: string; title: string; body: string }[]> {
  const all = await listBlocks();
  const byId = new Map(all.map((b) => [b.id, b]));
  const out: { id: string; title: string; body: string }[] = [];
  for (const id of ids) {
    const meta = byId.get(id);
    if (!meta) continue;
    const body = await fs.readFile(path.join(BLOCKS_DIR, meta.filename), "utf8");
    out.push({ id, title: meta.title, body });
  }
  return out;
}

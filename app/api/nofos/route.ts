import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listNofos, saveNofo, type ListNofosFilters } from "@/lib/db";
import type { ExtractedNofo } from "@/lib/extract";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const filters: ListNofosFilters = {
    q: sp.get("q") ?? undefined,
    agency: sp.get("agency") ?? undefined,
    program: sp.get("program") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    limit: sp.get("limit") ? Math.max(1, Math.min(500, Number(sp.get("limit")))) : undefined,
  };

  const nofos = listNofos(session.email, filters);
  return Response.json({
    nofos: nofos.map((n) => ({
      id: n.id,
      agency: n.agency,
      program: n.program,
      fundingFloor: n.fundingFloor,
      fundingCeiling: n.fundingCeiling,
      periodOfPerformance: n.periodOfPerformance,
      summary: n.summary,
      originalFilename: n.originalFilename,
      extractedAt: n.extractedAt,
      tags: n.tags,
    })),
  });
}

type CreateBody = {
  structured?: ExtractedNofo;
  rawText?: string;
  originalFilename?: string | null;
  tags?: string[];
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: CreateBody = await req.json().catch(() => ({}));
  if (!body.structured || typeof body.structured !== "object") {
    return Response.json({ error: "missing_structured" }, { status: 400 });
  }
  const rawText = typeof body.rawText === "string" ? body.rawText : "";
  if (!rawText.trim()) {
    return Response.json({ error: "missing_raw_text" }, { status: 400 });
  }

  const nofo = saveNofo({
    userEmail: session.email,
    structured: body.structured,
    rawText,
    originalFilename: body.originalFilename ?? null,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
  });

  return Response.json({ nofo });
}

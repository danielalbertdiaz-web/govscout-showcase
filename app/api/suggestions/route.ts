import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createSuggestion,
  isSuggestionStatus,
  listSuggestions,
  type SuggestionStatus,
} from "@/lib/suggestions";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const paneContextType = url.searchParams.get("contextType");
  const paneContextId = url.searchParams.get("contextId");
  const items = listSuggestions({
    userEmail: session.email,
    status: status && isSuggestionStatus(status) ? (status as SuggestionStatus) : undefined,
    paneContextType: paneContextType ?? undefined,
    paneContextId: paneContextId ?? undefined,
  });
  return Response.json({ suggestions: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    body?: string;
    paneContextType?: string | null;
    paneContextId?: string | null;
  };
  if (!body.body || !body.body.trim()) {
    return Response.json({ error: "body required" }, { status: 400 });
  }
  const created = createSuggestion({
    userEmail: session.email,
    body: body.body,
    paneContextType: body.paneContextType ?? null,
    paneContextId: body.paneContextId ?? null,
  });
  return Response.json({ suggestion: created });
}

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { ALFRED_TOOLS, executeTool } from "@/lib/alfred-tools";
import { emitMutation } from "@/lib/events";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({
    tools: ALFRED_TOOLS.map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description,
      signature: t.signature,
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    args?: Record<string, unknown>;
  };
  if (!body.name || typeof body.name !== "string") {
    return Response.json({ error: "tool name required" }, { status: 400 });
  }
  const result = await executeTool(body.name, body.args ?? {}, { userEmail: session.email });
  emitMutation({
    type: "tool_call",
    toolName: body.name,
    args: body.args ?? {},
    result: result.result,
    error: result.error,
    userEmail: session.email,
    at: Date.now(),
  });
  return Response.json(result);
}

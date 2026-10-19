import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listBoilerplate,
  seedAllBoilerplate,
  upsertBoilerplate,
} from "@/lib/boilerplate";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ blocks: listBoilerplate() });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === "seed") {
    return Response.json(seedAllBoilerplate(session.email));
  }
  if (!body.key || !body.title || typeof body.bodyMarkdown !== "string") {
    return Response.json(
      { error: "key, title, bodyMarkdown required" },
      { status: 400 },
    );
  }
  // Hard rule per [[banned-names-policy]]: refuse blocks containing "Jane Barred"
  if (/jane\s*barred/i.test(String(body.bodyMarkdown))) {
    return Response.json(
      { error: 'Block content includes "Jane Barred" — refused per standing rule.' },
      { status: 400 },
    );
  }
  const block = upsertBoilerplate({
    key: String(body.key),
    title: String(body.title),
    bodyMarkdown: String(body.bodyMarkdown),
    notes: body.notes ? String(body.notes) : null,
    actor: session.email,
    bumpVersion: body.bumpVersion === true,
  });
  return Response.json({ block });
}

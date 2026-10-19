import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteCopilotChat,
  getCopilotChat,
  listCopilotMessages,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const chat = getCopilotChat(id, session.email);
  if (!chat) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const messages = listCopilotMessages(id, session.email);
  return NextResponse.json({ chat, messages });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = deleteCopilotChat(id, session.email);
  return NextResponse.json({ ok });
}

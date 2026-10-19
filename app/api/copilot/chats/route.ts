import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listCopilotChats } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const chats = listCopilotChats(session.email);
  return NextResponse.json({ chats });
}

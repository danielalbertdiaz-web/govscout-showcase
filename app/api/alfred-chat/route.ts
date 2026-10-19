// Alfred chat bridge API (cron-chat integration).
//
// POST sends a message into Alfred's main OpenClaw session and returns
// immediately with the log row id; the reply lands on that row when the turn
// completes. GET returns recent rows for the panel. Designed for latency,
// not a fast round trip — turns regularly run 30–240s, so the browser polls
// GET instead of holding a fetch open.
//
// The Gateway token stays server-side (lib/alfred-chat.ts reads it from
// env); nothing in this route ever forwards it to the browser.

import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { alfredBridgeConfigured, sendToAlfred } from "@/lib/alfred-chat";

export const runtime = "nodejs";

type LogRow = {
  id: string;
  job_id: string | null;
  user_email: string;
  message: string;
  reply: string | null;
  status: string;
  error: string | null;
  created_at: number;
  completed_at: number | null;
};

function toWire(row: LogRow) {
  return {
    id: row.id,
    jobId: row.job_id,
    message: row.message,
    reply: row.reply,
    status: row.status,
    error: row.error,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50), 1), 200);
  const rows = getDb()
    .prepare("SELECT * FROM alfred_chat_log ORDER BY created_at DESC LIMIT ?")
    .all(limit) as LogRow[];
  return Response.json({
    configured: alfredBridgeConfigured(),
    messages: rows.reverse().map(toWire),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (!alfredBridgeConfigured()) {
    return Response.json(
      {
        error:
          "bridge_not_configured — set OPENCLAW_GATEWAY_TOKEN in .env.local (server-side only) and restart",
      },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => null)) as { message?: unknown; jobId?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "message_required" }, { status: 400 });
  if (message.length > 8000) {
    return Response.json({ error: "message_too_long" }, { status: 400 });
  }
  const jobId = typeof body?.jobId === "string" && body.jobId.trim() ? body.jobId.trim() : null;

  const id = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO alfred_chat_log (id, job_id, user_email, message, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, jobId, session.email, message, Date.now());

  // Fire-and-forget: the turn completes (or fails) on its own schedule and
  // the panel finds out by polling GET. The row id is also the chat.send
  // idempotencyKey, so this block re-running for the same row cannot start
  // a second turn.
  void sendToAlfred(message, { idempotencyKey: id })
    .then((reply) => {
      getDb()
        .prepare("UPDATE alfred_chat_log SET reply = ?, status = 'done', completed_at = ? WHERE id = ?")
        .run(reply, Date.now(), id);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      getDb()
        .prepare("UPDATE alfred_chat_log SET error = ?, status = 'error', completed_at = ? WHERE id = ?")
        .run(detail, Date.now(), id);
    });

  return Response.json({ id, status: "pending" }, { status: 202 });
}

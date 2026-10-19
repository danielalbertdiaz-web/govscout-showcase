import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { subscribeMutations, type MutationEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      send("hello", { ok: true, at: Date.now() });

      const unsubscribe = subscribeMutations((ev: MutationEvent) => {
        // Filter: only emit events for the connected user.
        if (ev.userEmail && ev.userEmail !== session.email) return;
        send(ev.type, ev);
      });

      // Heartbeat every 25s so proxies don't drop the connection.
      const ping = setInterval(() => {
        try { send("ping", { at: Date.now() }); } catch { /* closed */ }
      }, 25_000);

      req.signal.addEventListener(
        "abort",
        () => {
          clearInterval(ping);
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

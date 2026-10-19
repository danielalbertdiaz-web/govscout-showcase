/**
 * Alfred chat bridge — server-side OpenClaw Gateway RPC client.
 *
 * Connects GovScout's server to a configured OpenClaw session, so a message
 * sent from the GovScout UI is a turn in that conversation — same memory,
 * same tools, same assistant. See the cron-chat integration spec.
 *
 * NOT a ChannelPlugin: GovScout's own server talks to the Gateway directly
 * over WebSocket RPC, the way the native WebChat clients do. Frame shapes
 * follow packages/gateway-protocol/src/schema/frames.ts in the OpenClaw
 * source (verified against the installed 2026.7.1 build):
 *
 *   req:   {type:"req", id, method, params}
 *   res:   {type:"res", id, ok, payload|error}
 *   event: {type:"event", event, payload, seq?}
 *
 * Handshake: gateway emits `connect.challenge`, client sends a `connect` req
 * with role/scopes/auth token, gateway answers hello-ok. `chat.send` adopts
 * the caller's idempotencyKey as the runId, so replies are correlated by the
 * id we minted — and a retried/duplicate POST cannot create a second turn.
 *
 * Auth: OPENCLAW_GATEWAY_TOKEN, server-side env only — the browser never
 * sees it (same discipline as every other provider key in .env.local). Note
 * the documented tradeoff: chat.send requires operator.write, which is
 * broader than "chat only"; accepted by the operator 2026-08-25.
 *
 * Node 24's global WebSocket (undici) — no ws dependency.
 */

import { randomUUID } from "crypto";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const SESSION_KEY = process.env.ALFRED_SESSION_KEY ?? "agent:main:default";
// Turns on this agent regularly run 30–240s (Riverside cron run log, 2026-08-25);
// the ceiling leaves headroom past the observed worst case.
const TURN_TIMEOUT_MS = Number(process.env.ALFRED_CHAT_TIMEOUT_MS ?? 300_000);
const CONNECT_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 30_000;

type Pending = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RunWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deltas: string[];
};

type Bridge = {
  ws: WebSocket;
  pending: Map<string, Pending>;
  runs: Map<string, RunWaiter>;
};

// Module-level singleton: the app runs as one long-lived node process
// (npm run start under launchd), so one authenticated Gateway connection is
// shared across route invocations and survives between requests.
let bridgePromise: Promise<Bridge> | null = null;

export function alfredBridgeConfigured(): boolean {
  return Boolean(process.env.OPENCLAW_GATEWAY_TOKEN);
}

/** Best-effort text extraction from the gateway's message payload (shape is
 * provider-dependent: plain string, {text}, or {content:[{type:"text",...}]}). */
function extractText(message: unknown): string | null {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return null;
  const m = message as { text?: unknown; content?: unknown };
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : null))
      .filter((s): s is string => s != null);
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof m.content === "string") return m.content;
  return null;
}

function failAll(bridge: Bridge, err: Error): void {
  for (const p of bridge.pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  bridge.pending.clear();
  for (const r of bridge.runs.values()) {
    clearTimeout(r.timer);
    r.reject(err);
  }
  bridge.runs.clear();
}

function connect(): Promise<Bridge> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return Promise.reject(
      new Error("alfred bridge not configured: OPENCLAW_GATEWAY_TOKEN is unset"),
    );
  }

  return new Promise<Bridge>((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(GATEWAY_URL);
    const bridge: Bridge = { ws, pending: new Map(), runs: new Map() };
    let settled = false;

    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectConnect(new Error(`gateway handshake timed out after ${CONNECT_TIMEOUT_MS}ms`));
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        rejectConnect(new Error(`gateway connection failed (${GATEWAY_URL})`));
      }
    });

    ws.addEventListener("close", () => {
      // Whatever was in flight is now unanswerable; next call redials.
      failAll(bridge, new Error("gateway connection closed"));
      if (bridgePromise) bridgePromise = null;
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        rejectConnect(new Error("gateway closed during handshake"));
      }
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      let frame: {
        type?: string;
        id?: string;
        ok?: boolean;
        payload?: unknown;
        error?: { message?: string } | null;
        event?: string;
      };
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (frame.type === "event" && frame.event === "connect.challenge") {
        // Handshake step 2: identify as a backend operator client. Device
        // identity is optional under shared-token auth (ConnectParamsSchema)
        // — token-auth clients like the Control UI omit it too.
        const connectId = randomUUID();
        bridge.pending.set(connectId, {
          resolve: () => {
            settled = true;
            clearTimeout(connectTimer);
            resolveConnect(bridge);
          },
          reject: (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              rejectConnect(err);
            }
          },
          timer: setTimeout(() => {
            bridge.pending.delete(connectId);
            if (!settled) {
              settled = true;
              clearTimeout(connectTimer);
              rejectConnect(new Error("gateway connect RPC timed out"));
            }
          }, CONNECT_TIMEOUT_MS),
        });
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: 1,
              maxProtocol: 3,
              client: {
                id: "gateway-client",
                displayName: "GovScout Alfred bridge",
                version: "1.0.0",
                platform: "govscout",
                mode: "backend",
              },
              role: "operator",
              scopes: ["operator.read", "operator.write"],
              auth: { token },
              userAgent: "govscout-alfred-bridge/1.0",
            },
          }),
        );
        return;
      }

      if (frame.type === "res" && typeof frame.id === "string") {
        const p = bridge.pending.get(frame.id);
        if (!p) return;
        bridge.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.payload);
        else p.reject(new Error(frame.error?.message ?? "gateway RPC error"));
        return;
      }

      if (frame.type === "event" && frame.event === "chat") {
        const payload = frame.payload as {
          runId?: string;
          sessionKey?: string;
          state?: string;
          deltaText?: string;
          message?: unknown;
          errorMessage?: string;
        } | null;
        if (!payload?.runId) return;
        const waiter = bridge.runs.get(payload.runId);
        if (!waiter) return;
        if (payload.state === "delta") {
          if (typeof payload.deltaText === "string") waiter.deltas.push(payload.deltaText);
          return;
        }
        if (payload.state === "final") {
          bridge.runs.delete(payload.runId);
          clearTimeout(waiter.timer);
          const text = extractText(payload.message) ?? waiter.deltas.join("");
          waiter.resolve(text || "(Alfred replied with no visible text)");
          return;
        }
        if (payload.state === "error" || payload.state === "aborted") {
          bridge.runs.delete(payload.runId);
          clearTimeout(waiter.timer);
          waiter.reject(
            new Error(payload.errorMessage ?? `chat run ${payload.state}`),
          );
        }
      }
    });
  });
}

async function getBridge(): Promise<Bridge> {
  if (!bridgePromise) bridgePromise = connect();
  try {
    return await bridgePromise;
  } catch (err) {
    // A failed dial must not poison every later request.
    bridgePromise = null;
    throw err;
  }
}

function rpc(bridge: Bridge, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    bridge.pending.set(id, {
      resolve,
      reject,
      timer: setTimeout(() => {
        bridge.pending.delete(id);
        reject(new Error(`${method} RPC timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS),
    });
    bridge.ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

/**
 * Send one message into Alfred's main session and resolve with the reply
 * text when the turn completes. `idempotencyKey` doubles as the Gateway
 * runId — pass the alfred_chat_log row id so a duplicate POST is deduped
 * server-side instead of starting a second turn.
 */
export async function sendToAlfred(
  text: string,
  opts: { idempotencyKey: string },
): Promise<string> {
  const bridge = await getBridge();

  const replyPromise = new Promise<string>((resolve, reject) => {
    bridge.runs.set(opts.idempotencyKey, {
      resolve,
      reject,
      deltas: [],
      timer: setTimeout(() => {
        bridge.runs.delete(opts.idempotencyKey);
        reject(new Error(`Alfred turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
      }, TURN_TIMEOUT_MS),
    });
  });

  try {
    await rpc(bridge, "chat.send", {
      sessionKey: SESSION_KEY,
      message: text,
      idempotencyKey: opts.idempotencyKey,
      // The reply belongs to the GovScout panel that asked; deliver:false
      // keeps the gateway from also pushing it out to Telegram.
      deliver: false,
    });
  } catch (err) {
    const waiter = bridge.runs.get(opts.idempotencyKey);
    if (waiter) {
      bridge.runs.delete(opts.idempotencyKey);
      clearTimeout(waiter.timer);
    }
    throw err;
  }

  return replyPromise;
}

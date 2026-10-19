import { spawn } from "node:child_process";
import { getClient } from "./anthropic";
import { recordUsageEvent, type UsageAttribution } from "./usage";

export type ClaudeCliEvent =
  | { type: "delta"; text: string }
  | { type: "done"; stop_reason?: string | null; usage?: ClaudeCliUsage; result?: string }
  | { type: "error"; message: string };

export type ClaudeCliUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type ClaudeCliOptions = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  // Item 3.2: optional usage-attribution context. When present, the invocation
  // is logged to usage_events (opportunity/draft/stage/model + token cost) for
  // visibility. Recording is best-effort and never affects the result.
  attribution?: UsageAttribution;
};

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || "claude";

export async function* streamClaudeCli(opts: ClaudeCliOptions): AsyncGenerator<ClaudeCliEvent> {
  const args = [
    "-p",
    "--model",
    opts.model,
    "--system-prompt",
    opts.systemPrompt,
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];

  // Strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_SIMPLE from
  // the env so the CLI uses its keychain-stored Max plan OAuth credential.
  //   - ANTHROPIC_API_KEY: if present (even an OAuth token), the CLI tries
  //     to use it as an API key → "Invalid API key · Fix external API key".
  //   - CLAUDE_CODE_SIMPLE=1: equivalent to --bare; it explicitly disables
  //     OAuth + keychain reads and demands an API key → "Not logged in".
  const cliEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cliEnv.ANTHROPIC_API_KEY;
  delete cliEnv.ANTHROPIC_AUTH_TOKEN;
  delete cliEnv.CLAUDE_API_KEY;
  delete cliEnv.CLAUDE_CODE_SIMPLE;

  const child = spawn(CLAUDE_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: cliEnv,
  });

  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    }, { once: true });
  }

  const queue: ClaudeCliEvent[] = [];
  let done = false;
  let stderrBuf = "";
  let resolveNext: (() => void) | null = null;

  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  let stdoutBuf = "";
  let stdoutTail = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutTail = (stdoutTail + chunk).slice(-2000);
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        handleObj(obj, queue);
      } catch {
        // ignore malformed line
      }
    }
    wake();
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
  });

  child.on("error", (err) => {
    queue.push({ type: "error", message: `claude CLI spawn failed: ${err.message}` });
    done = true;
    wake();
  });

  child.on("close", (code) => {
    if (stdoutBuf.trim()) {
      try {
        handleObj(JSON.parse(stdoutBuf.trim()), queue);
      } catch { /* noop */ }
      stdoutBuf = "";
    }
    if (code !== 0) {
      const detail = stderrBuf.slice(0, 1000) || stdoutTail || "(no output)";
      queue.push({ type: "error", message: `claude CLI exited ${code}: ${detail}` });
    }
    done = true;
    wake();
  });

  child.stdin.write(opts.userPrompt);
  child.stdin.end();

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => { resolveNext = r; });
      continue;
    }
    const ev = queue.shift()!;
    yield ev;
    if (ev.type === "done") {
      // Item 3.2: log token cost once per invocation (best-effort).
      if (opts.attribution) recordUsageEvent(opts.model, ev.usage, opts.attribution);
    }
    if (ev.type === "done" || ev.type === "error") {
      // Allow trailing events but break early if process is done.
      if (done && queue.length === 0) break;
    }
  }
}

function handleObj(obj: unknown, queue: ClaudeCliEvent[]): void {
  if (!obj || typeof obj !== "object") return;
  const o = obj as Record<string, unknown>;
  if (o.type === "stream_event") {
    const ev = o.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      queue.push({ type: "delta", text: ev.delta.text });
    }
    return;
  }
  if (o.type === "result") {
    const isError = Boolean(o.is_error);
    const apiErr = typeof o.api_error_status === "string" ? (o.api_error_status as string) : null;
    if (isError) {
      const result = typeof o.result === "string" ? (o.result as string) : "";
      const reason = (typeof o.subtype === "string" ? (o.subtype as string) : "") || apiErr || "unknown_error";
      queue.push({ type: "error", message: `claude CLI error (${reason}): ${result}` });
      return;
    }
    const usage = (o.usage as Record<string, unknown> | undefined) ?? undefined;
    queue.push({
      type: "done",
      stop_reason: typeof o.stop_reason === "string" ? (o.stop_reason as string) : null,
      usage: usage
        ? {
            input_tokens: numOrUndef(usage.input_tokens),
            output_tokens: numOrUndef(usage.output_tokens),
            cache_read_input_tokens: numOrUndef(usage.cache_read_input_tokens),
            cache_creation_input_tokens: numOrUndef(usage.cache_creation_input_tokens),
          }
        : undefined,
      result: typeof o.result === "string" ? (o.result as string) : undefined,
    });
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export async function runClaudeCli(opts: ClaudeCliOptions): Promise<{ text: string; usage?: ClaudeCliUsage; stop_reason?: string | null }> {
  let text = "";
  let usage: ClaudeCliUsage | undefined;
  let stopReason: string | null | undefined;
  for await (const ev of streamClaudeCli(opts)) {
    if (ev.type === "delta") text += ev.text;
    else if (ev.type === "done") {
      usage = ev.usage;
      stopReason = ev.stop_reason ?? null;
      if (!text && ev.result) text = ev.result;
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  return { text, usage, stop_reason: stopReason };
}

// On Vercel (or anywhere `USE_DIRECT_SDK=1`), the local `claude` binary is
// unavailable — route DRAFT/SECTION through the Anthropic SDK with the
// configured Haiku model + OAuth token.
export const USE_DIRECT_SDK =
  process.env.USE_DIRECT_SDK === "1" || process.env.VERCEL === "1";

const HAIKU_FALLBACK = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

export const CLI_MODEL_DRAFT = USE_DIRECT_SDK
  ? HAIKU_FALLBACK
  : process.env.ANTHROPIC_MODEL_DRAFT || "claude-opus-4-7";
export const CLI_MODEL_SECTION = USE_DIRECT_SDK
  ? HAIKU_FALLBACK
  : process.env.ANTHROPIC_MODEL_SECTION || "claude-sonnet-4-6";
export const CLI_MODEL_EXTRACT = process.env.ANTHROPIC_MODEL_EXTRACT || HAIKU_FALLBACK;

export async function* streamClaudeSdk(opts: ClaudeCliOptions): AsyncGenerator<ClaudeCliEvent> {
  const client = getClient();
  const stream = client.messages.stream(
    {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8192,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userPrompt }],
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "delta", text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const text = final.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    const usage = {
      input_tokens: final.usage?.input_tokens,
      output_tokens: final.usage?.output_tokens,
      cache_read_input_tokens: final.usage?.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: final.usage?.cache_creation_input_tokens ?? undefined,
    };
    // Item 3.2: log token cost once per invocation (best-effort).
    if (opts.attribution) recordUsageEvent(opts.model, usage, opts.attribution);
    yield {
      type: "done",
      stop_reason: final.stop_reason ?? null,
      usage,
      result: text,
    };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function streamClaude(opts: ClaudeCliOptions): AsyncGenerator<ClaudeCliEvent> {
  return USE_DIRECT_SDK ? streamClaudeSdk(opts) : streamClaudeCli(opts);
}

// Collect a full (non-streamed) completion through whichever transport is
// active (local CLI or Vercel SDK). Used by server-side batch generators like
// the RFP synthesizer that store output rather than stream it to the client.
export async function runClaude(
  opts: ClaudeCliOptions,
): Promise<{ text: string; usage?: ClaudeCliUsage; stop_reason?: string | null }> {
  let text = "";
  let usage: ClaudeCliUsage | undefined;
  let stopReason: string | null | undefined;
  for await (const ev of streamClaude(opts)) {
    if (ev.type === "delta") text += ev.text;
    else if (ev.type === "done") {
      usage = ev.usage;
      stopReason = ev.stop_reason ?? null;
      if (!text && ev.result) text = ev.result;
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  return { text, usage, stop_reason: stopReason };
}

export const CLI_ALLOWED_MODELS = new Set([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
]);

export function resolveCliModel(input: string | undefined, fallback: string): string {
  // On Vercel/SDK paths, OAuth tokens are scoped to Haiku — never honor an
  // Opus/Sonnet override from the client.
  if (USE_DIRECT_SDK) return fallback;
  if (!input) return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (CLI_ALLOWED_MODELS.has(trimmed)) return trimmed;
  // Allow short aliases.
  if (trimmed === "opus") return "claude-opus-4-7";
  if (trimmed === "sonnet") return "claude-sonnet-4-6";
  if (trimmed === "haiku") return "claude-haiku-4-5-20251001";
  return fallback;
}

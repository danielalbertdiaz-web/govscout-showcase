import Anthropic from "@anthropic-ai/sdk";

export type ClaudeMode = "api_key" | "oauth";

export function detectMode(): ClaudeMode {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  return key.startsWith("sk-ant-oat") ? "oauth" : "api_key";
}

export function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  if (detectMode() === "oauth") {
    return new Anthropic({ authToken: key, apiKey: null as unknown as string });
  }
  return new Anthropic({ apiKey: key });
}

// EXTRACT path stays on direct SDK + Haiku — works fine with the OAuth token,
// no rate-limit issues. DRAFT and SECTION paths use the Claude Code CLI
// subprocess (see lib/claude-cli.ts) so Sonnet/Opus go through the proper Max
// plan OAuth flow.
//
// Model defaults are mode-aware:
//   - api_key (sk-ant-api... — billable Anthropic API key): default to
//     claude-sonnet-4-5 for DRAFT (better grant prose; api-key billing has no
//     OAuth rate-limit reality), Haiku 4.5 for EXTRACT.
//   - oauth (sk-ant-oat... — Max plan): default to Haiku 4.5 for EXTRACT and
//     route DRAFT/SECTION through the Claude Code CLI subprocess (see
//     lib/claude-cli.ts).
// Explicit `ANTHROPIC_MODEL_*` env vars always win.
export function defaultModelFor(role: "extract" | "draft" | "section"): string {
  const mode = detectMode();
  const explicit =
    role === "extract"
      ? process.env.ANTHROPIC_MODEL_EXTRACT
      : role === "draft"
        ? process.env.ANTHROPIC_MODEL_DRAFT
        : process.env.ANTHROPIC_MODEL_SECTION;
  if (explicit) return explicit;
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (role === "extract") return "claude-haiku-4-5-20251001";
  if (mode === "api_key") return "claude-sonnet-4-5";
  return role === "draft" ? "claude-opus-4-7" : "claude-sonnet-4-6";
}

export const DEFAULT_MODEL = defaultModelFor("extract");

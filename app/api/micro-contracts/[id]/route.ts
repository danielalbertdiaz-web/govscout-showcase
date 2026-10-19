// PUT  /api/micro-contracts/:id — update disposition
// POST /api/micro-contracts/:id — draft a response using Claude

import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getMicroContract,
  setMicroContractDisposition,
  setMicroContractResponseDraft,
  isMicroContractDisposition,
} from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Params) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const contract = getMicroContract(id, session.email);
  if (!contract) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ contract });
}

export async function PUT(req: NextRequest, ctx: Params) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { disposition?: string };

  if (!body.disposition || !isMicroContractDisposition(body.disposition)) {
    return Response.json({ error: "invalid_disposition" }, { status: 400 });
  }

  const contract = setMicroContractDisposition(id, session.email, body.disposition);
  if (!contract) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ contract });
}

const execFileAsync = promisify(execFile);

/**
 * Strip API-key env vars so the CLI uses its keychain-stored OAuth
 * credential rather than leaking ANTHROPIC_API_KEY into a subprocess.
 * Mirrors lib/claude-cli.ts.
 */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_API_KEY;
  delete env.CLAUDE_CODE_SIMPLE;
  return env;
}

export async function POST(req: NextRequest, ctx: Params) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const contract = getMicroContract(id, session.email);
  if (!contract) return Response.json({ error: "not_found" }, { status: 404 });

  const cliPath = process.env.CLAUDE_CLI_PATH ?? "claude";
  const model = process.env.ANTHROPIC_MODEL_DRAFT ?? "claude-sonnet-4-6";

  const prompt = `You are a federal contracting specialist helping a small business (Acme Consulting Group LLC, NAICS codes: 541611, 541512, 541519, 541715) draft a response to a federal contract solicitation.

Solicitation: ${contract.title}
Agency: ${contract.agency ?? "Unknown"}
NAICS: ${contract.naics ?? "Not specified"}
Set-Aside: ${contract.setAside ?? "Unrestricted"}
Deadline: ${contract.responseDeadline ?? "Not specified"}

Description:
${contract.description ?? "(No description available)"}

Draft a professional, concise capability statement / response outline that:
1. Demonstrates relevant qualifications for this NAICS code
2. Highlights small business status and any applicable set-aside eligibility
3. Provides a clear statement of understanding of the requirements
4. Outlines a preliminary approach
5. Notes any questions or clarifications needed

Keep it under 800 words. This is a DRAFT for human review — nothing will be sent automatically.`;

  try {
    // Same lockdown as lib/claude-cli.ts: this endpoint is reachable by any
    // logged-in user, and the prompt below interpolates scan-sourced text
    // (title/agency/description). Without --tools "" the CLI would run with
    // its default tool set — including filesystem write — turning a drafting
    // endpoint into arbitrary local code execution. Drafting needs no tools.
    const { stdout } = await execFileAsync(
      cliPath,
      [
        "--model",
        model,
        "-p",
        prompt,
        "--no-input",
        "--tools",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
      ],
      { timeout: 55_000, env: cliEnv() },
    );

    const draft = stdout.trim();
    const updated = setMicroContractResponseDraft(id, session.email, draft);
    return Response.json({ draft, contract: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "draft_failed", message }, { status: 500 });
  }
}

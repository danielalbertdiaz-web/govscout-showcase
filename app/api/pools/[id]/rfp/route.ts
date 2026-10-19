import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { buildRfpPrompt, buildRfpSkeleton, cleanRfpOutput } from "@/lib/rfp-builder";
import { getPoolRfp, savePoolRfp } from "@/lib/pool-rfps";
import { runClaudeCli, CLI_MODEL_DRAFT } from "@/lib/claude-cli";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  return Response.json({ rfp: getPoolRfp(id, session.email) });
}

// R3: generate (or regenerate) the draft RFP for this pool. Full document via
// the local Claude CLI when available; instant template skeleton otherwise.
export async function POST(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const pool = getPool(id, session.email);
  if (!pool) return Response.json({ error: "not_found" }, { status: 404 });

  let markdown: string;
  let generator: "cli" | "skeleton" = "skeleton";
  let model: string | null = null;
  try {
    const { systemPrompt, userPrompt } = buildRfpPrompt(pool);
    const out = await runClaudeCli({
      model: CLI_MODEL_DRAFT,
      systemPrompt,
      userPrompt,
      maxTokens: 4000,
    });
    const cleaned = cleanRfpOutput(out.text);
    if (cleaned.length > 400) {
      markdown = cleaned;
      generator = "cli";
      model = CLI_MODEL_DRAFT;
    } else {
      markdown = buildRfpSkeleton(pool);
    }
  } catch {
    markdown = buildRfpSkeleton(pool);
  }

  const rfp = savePoolRfp({ poolId: pool.id, userEmail: session.email, markdown, generator, model });
  logActivity({
    actor: session.email,
    actionType: "pool_rfp_generated",
    targetType: "pool",
    targetId: pool.id,
    summary: `Generated draft RFP for "${pool.name.slice(0, 80)}" (${generator}). Draft for agency review — OCI disclosure required before bidding.`,
  });
  return Response.json({ rfp });
}

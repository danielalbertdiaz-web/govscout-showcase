import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { runPreflightById, type PreflightProfile } from "@/lib/preflight";
import { setDraftPreflightResult } from "@/lib/db";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function envProfile(): PreflightProfile {
  return {
    samGovLastRenewed: process.env.EL_SAM_GOV_LAST_RENEWED?.trim() || undefined,
    ueiOnFile: process.env.EL_UEI?.trim() || undefined,
    partnerLettersDates: process.env.EL_PARTNER_LETTER_DATES
      ? process.env.EL_PARTNER_LETTER_DATES.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const result = runPreflightById(id, session.email, envProfile());
  if (!result) return Response.json({ error: "not_found" }, { status: 404 });
  setDraftPreflightResult({
    draftId: id,
    userEmail: session.email,
    result: result as unknown as Record<string, unknown>,
  });
  tryLogActivity({
    actor: session.email,
    actionType: "preflight_run",
    targetType: "draft",
    targetId: id,
    summary: `Pre-flight: ${result.greenCount} green / ${result.yellowCount} yellow / ${result.redCount} red`,
  });
  return Response.json(result);
}

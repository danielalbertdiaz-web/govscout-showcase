import { getSession } from "@/lib/auth";
import { ingestDigestsForUser } from "@/lib/scouts";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = ingestDigestsForUser(session.email);
  if (result.newDigests > 0 || result.newItems > 0) {
    tryLogActivity({
      actor: session.email,
      actionType: "scout_ingested",
      targetType: "scout",
      targetId: null,
      summary: `Ingested ${result.newDigests} digest${result.newDigests === 1 ? "" : "s"} (${result.newItems} item${result.newItems === 1 ? "" : "s"})`,
      detail: result as unknown as Record<string, unknown>,
    });
  }
  return Response.json(result);
}

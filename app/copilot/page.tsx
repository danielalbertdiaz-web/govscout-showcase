import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { parseContextRef, resolveContext } from "@/lib/copilot-context";
import { getCopilotChat, listCopilotChats, listCopilotMessages } from "@/lib/db";
import CopilotView from "./view";

export const dynamic = "force-dynamic";

export default async function CopilotPage({
  searchParams,
}: {
  searchParams: Promise<{ context?: string; chat?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { context, chat: chatParam } = await searchParams;
  const ref = parseContextRef(context);
  const resolved = ref ? resolveContext(ref, session.email) : null;

  const recent = listCopilotChats(session.email, 20).map((c) => ({
    id: c.id,
    title: c.title ?? "(untitled)",
    contextKind: c.contextKind,
    contextId: c.contextId,
    updatedAtMs: c.updatedAtMs,
  }));

  let initialChatId: string | null = null;
  let initialMessages: { role: "user" | "assistant"; content: string }[] = [];
  if (chatParam) {
    const chat = getCopilotChat(chatParam, session.email);
    if (chat) {
      initialChatId = chat.id;
      initialMessages = listCopilotMessages(chat.id, session.email)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    }
  }

  return (
    <CopilotView
      user={{ email: session.email, name: session.name ?? session.email }}
      contextRaw={context ?? null}
      contextSummary={
        resolved
          ? { kind: resolved.kind, id: resolved.id, title: resolved.title }
          : null
      }
      initialChatId={initialChatId}
      initialMessages={initialMessages}
      recentChats={recent}
    />
  );
}

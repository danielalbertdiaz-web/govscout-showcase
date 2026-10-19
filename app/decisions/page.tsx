import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { countOpenDecisions, listDecisions } from "@/lib/decisions";
import { AppHeader } from "@/app/_components/AppHeader";
import DecisionsView from "./view";

export const dynamic = "force-dynamic";

export default async function DecisionsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const items = listDecisions({ userEmail: session.email });
  const open = countOpenDecisions(session.email);
  return (
    <div className="mx-auto max-w-5xl px-6 pt-3">
      <AppHeader
        tagline="Decisions"
        title={`${open} decision${open === 1 ? "" : "s"} waiting`}
        subtitle="Batched judgement calls Alfred wants you to make."
        userLabel={session.name ?? session.email}
        activeNav="decisions"
        openDecisions={open}
      />
      <div className="mt-4">
        <DecisionsView initial={items} />
      </div>
    </div>
  );
}

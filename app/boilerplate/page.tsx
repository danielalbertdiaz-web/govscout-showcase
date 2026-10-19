import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listBoilerplate } from "@/lib/boilerplate";
import { AppHeader } from "@/app/_components/AppHeader";
import BoilerplateView from "./view";

export const dynamic = "force-dynamic";

export default async function BoilerplatePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const blocks = listBoilerplate();
  return (
    <div className="mx-auto max-w-5xl px-6 pt-3">
      <AppHeader
        tagline="Boilerplate"
        title={`${blocks.length} reusable block${blocks.length === 1 ? "" : "s"}`}
        subtitle="Capability statement, NAICS, MBE cert, 8(a) status, partner letter templates."
        userLabel={session.name ?? session.email}
        activeNav="boilerplate"
      />
      <div className="mt-4">
        <BoilerplateView initial={blocks} />
      </div>
    </div>
  );
}

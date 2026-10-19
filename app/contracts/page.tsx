import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listMicroContracts } from "@/lib/db";
import ContractsView from "./view";

export const dynamic = "force-dynamic";

export default async function ContractsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const contracts = listMicroContracts(session.email);
  const samConfigured = Boolean(process.env.SAM_GOV_API_KEY?.trim());

  return (
    <ContractsView
      user={{ email: session.email, name: session.name ?? session.email }}
      initialContracts={contracts}
      samConfigured={samConfigured}
    />
  );
}

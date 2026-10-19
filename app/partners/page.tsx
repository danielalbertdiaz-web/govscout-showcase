import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loadPartners } from "@/lib/partners";
import PartnersView, { type PartnerListItem } from "./view";

export const dynamic = "force-dynamic";

export default async function PartnersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const partners = await loadPartners();
  const items: PartnerListItem[] = partners.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    description: p.description,
    capabilities: p.capabilities,
    contact: p.contact,
    status: p.status,
    hasBody: Boolean(p.body),
  }));

  return (
    <PartnersView
      user={{ email: session.email, name: session.name ?? session.email }}
      initial={items}
    />
  );
}

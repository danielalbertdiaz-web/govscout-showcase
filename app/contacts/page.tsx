import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listContacts } from "@/lib/db";
import { readConnectionsMetadata } from "@/lib/connections";
import ContactsView, { type ContactListItem } from "./view";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const contacts = listContacts(session.email, { limit: 500 });
  const items: ContactListItem[] = contacts.map((c) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    agency: c.agency,
    email: c.email,
    linkedinUrl: c.linkedinUrl,
    tags: c.tags,
    source: c.source,
    outreachStatus: c.outreachStatus,
    introDraft: c.introDraft,
    introDraftAt: c.introDraftAt,
  }));

  // Surface the LinkedIn data gap explicitly (claimed vs importable) so the
  // single user knows the enrichment shortfall before relying on the lead set.
  const meta = await readConnectionsMetadata();
  const asCount = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const linkedin = {
    totalClaimed: asCount(meta.total_connections),
    available: asCount(meta.extracted_count),
  };

  return (
    <ContactsView
      user={{ email: session.email, name: session.name ?? session.email }}
      initial={items}
      linkedin={linkedin}
    />
  );
}

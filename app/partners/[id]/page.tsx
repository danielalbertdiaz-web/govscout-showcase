import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loadPartners } from "@/lib/partners";
import { listDraftsForPartner } from "@/lib/db";
import { AppHeader } from "@/app/_components/AppHeader";
import { sanitizePartnerCopy } from "@/lib/partner-copy";
import { PartnerProfileEditor } from "./partner-profile-editor";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function PartnerDetail({ params }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  const partners = await loadPartners([id]);
  const partner = partners[0];
  if (!partner) notFound();

  const linkedDrafts = listDraftsForPartner(partner.id, session.email);

  // Item 1.6: the reference profile is partner-facing. Sanitize before render;
  // if anything was scrubbed, flag it so the operator edits the on-disk source.
  const profile = sanitizePartnerCopy(partner.body);

  return (
    <div className="mx-auto max-w-5xl px-6 pt-3">
      <AppHeader
        tagline="Partner detail"
        title={partner.name}
        subtitle={partner.description || undefined}
        userLabel={session.name ?? session.email}
        activeNav="partners"
        trailingActions={
          <Link
            href="/partners"
            className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50"
          >
            ← All partners
          </Link>
        }
      />

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <section className="md:col-span-2 space-y-4">
          <PartnerProfileEditor
            partnerId={partner.id}
            partnerName={partner.name}
            initialBody={profile.clean}
            hadRedactions={!profile.safe}
          />

          <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
              Drafts tagged with this partner
            </h2>
            {linkedDrafts.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500 italic">
                No drafts auto-matched or explicitly tagged this partner yet.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-stone-100">
                {linkedDrafts.map((d) => (
                  <li key={d.id} className="flex items-center justify-between py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-stone-900">
                        {d.title}
                      </div>
                      <div className="text-[11px] text-stone-500">
                        Updated {new Date(d.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <Link
                      href={`/drafts/${d.id}`}
                      className="ml-3 text-xs font-semibold text-emerald-700 hover:text-emerald-900"
                    >
                      Open →
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
              Manifest
            </h2>
            <dl className="mt-3 space-y-3 text-xs text-stone-700">
              <div>
                <dt className="font-semibold text-stone-600">Type</dt>
                <dd className="mt-0.5">{partner.type.replace(/_/g, " ") || "—"}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-600">Status</dt>
                <dd className="mt-0.5">{partner.status}</dd>
              </div>
              <div>
                <dt className="font-semibold text-stone-600">Capabilities</dt>
                <dd className="mt-0.5 flex flex-wrap gap-1">
                  {partner.capabilities.length === 0 && <span>—</span>}
                  {partner.capabilities.map((c) => (
                    <span
                      key={c}
                      className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5"
                    >
                      {c.replace(/_/g, " ")}
                    </span>
                  ))}
                </dd>
              </div>
              {partner.contact && (
                <div>
                  <dt className="font-semibold text-stone-600">Contact</dt>
                  <dd className="mt-0.5">{partner.contact}</dd>
                </div>
              )}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

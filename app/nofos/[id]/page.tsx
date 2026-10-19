import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getNofo } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export default async function NofoDetailPage({ params }: Ctx) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const nofo = getNofo(id, session.email);
  if (!nofo) notFound();

  const title = [nofo.agency, nofo.program].filter(Boolean).join(" — ") || nofo.originalFilename || "Untitled NOFO";

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-5 px-6 py-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-emerald-700">
            NOFO Library · Detail
          </div>
          <h1 className="mt-0.5 text-xl font-semibold text-stone-900">{title}</h1>
          <p className="mt-0.5 text-xs text-stone-500">extracted {fmtDate(nofo.extractedAt)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/nofos"
            className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            ← Library
          </Link>
          <Link
            href={`/?nofo=${nofo.id}`}
            className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            Open in workbench
          </Link>
        </div>
      </header>

      {nofo.summary && (
        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">Summary</h2>
          <p className="mt-2 text-sm leading-6 text-stone-800">{nofo.summary}</p>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 text-sm">
        <Field label="Agency" value={nofo.agency} />
        <Field label="Program" value={nofo.program} />
        <Field label="Funding floor" value={nofo.fundingFloor} />
        <Field label="Funding ceiling" value={nofo.fundingCeiling} />
        <Field label="Period of performance" value={nofo.periodOfPerformance} />
        <Field label="Original filename" value={nofo.originalFilename} mono />
        <Field label="LOI" value={nofo.keyDates?.loi ?? null} />
        <Field label="Full proposal" value={nofo.keyDates?.full_proposal ?? null} />
        <Field label="Award" value={nofo.keyDates?.award ?? null} />
        <Field label="Other dates" value={nofo.keyDates?.other ?? null} />
      </section>

      {nofo.eligibility && (
        <Section title="Eligibility">
          <p className="text-sm leading-6 text-stone-800 whitespace-pre-wrap">{nofo.eligibility}</p>
        </Section>
      )}

      {nofo.evaluationCriteria && (
        <Section title="Evaluation criteria">
          <p className="text-sm leading-6 text-stone-800 whitespace-pre-wrap">{nofo.evaluationCriteria}</p>
        </Section>
      )}

      {nofo.requiredSections.length > 0 && (
        <Section title="Required sections">
          <ul className="list-disc pl-5 text-sm leading-6 text-stone-800">
            {nofo.requiredSections.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Section>
      )}

      {nofo.tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {nofo.tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800"
              >
                {t}
              </span>
            ))}
          </div>
        </Section>
      )}

      {nofo.rawText && (
        <Section title={`Raw text (${nofo.rawText.length.toLocaleString()} chars)`}>
          <details>
            <summary className="cursor-pointer text-xs text-emerald-700">Show raw extracted text</summary>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-3 text-[11px] leading-5 text-stone-700 ring-1 ring-stone-200">
              {nofo.rawText}
            </pre>
          </details>
        </Section>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <div className={`mt-0.5 text-sm text-stone-800 ${mono ? "font-mono text-xs" : ""}`}>{value ?? <span className="text-stone-400">—</span>}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

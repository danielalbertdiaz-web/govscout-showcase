import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loadReferenceData } from "@/lib/reference-data";
import { focusAreasOf } from "@/lib/reference-orgs";
import ReferenceView from "./view";

export const dynamic = "force-dynamic";

export default async function ReferencePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const dataset = await loadReferenceData();
  const note =
    typeof dataset.metadata.note === "string" ? dataset.metadata.note : null;

  return (
    <ReferenceView
      user={{ email: session.email, name: session.name ?? session.email }}
      orgs={dataset.orgs}
      focusAreas={focusAreasOf(dataset.orgs)}
      datasetNote={note}
    />
  );
}

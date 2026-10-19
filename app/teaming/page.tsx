import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listTeamingNotices } from "@/lib/db";
import { availableTeamingSources } from "@/lib/teaming-sources/index";
import TeamingView from "./view";

export const dynamic = "force-dynamic";

export default async function TeamingPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const notices = listTeamingNotices(session.email);
  const sourceConfigured = availableTeamingSources().length > 0;

  return (
    <TeamingView
      user={{ email: session.email, name: session.name ?? session.email }}
      initialNotices={notices}
      sourceConfigured={sourceConfigured}
    />
  );
}

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import SearchClient from "./search-client";

export const dynamic = "force-dynamic";

export default async function SearchPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const samConfigured = Boolean(process.env.SAM_GOV_API_KEY);
  return (
    <SearchClient
      user={{ email: session.email, name: session.name ?? session.email }}
      samConfigured={samConfigured}
    />
  );
}

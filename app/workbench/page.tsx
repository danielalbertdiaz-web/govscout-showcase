// The drafting workbench — moved from `/` (2026-06-10 UX pass) so the app can
// land on the command-center home instead of a blank form. Deep links that
// prefill an opportunity (`/workbench?title=…&source=…`) keep working; the
// component reads its query params itself.

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listBlocks } from "@/lib/blocks";
import Workbench from "./workbench-client";

export const dynamic = "force-dynamic";

export default async function WorkbenchPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const blocks = await listBlocks();
  return <Workbench user={{ email: session.email, name: session.name ?? session.email }} blocks={blocks} />;
}

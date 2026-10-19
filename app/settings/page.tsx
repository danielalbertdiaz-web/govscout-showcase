import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppHeader } from "@/app/_components/AppHeader";
import {
  getAutoDraftEnabled,
  getAutoDraftThreshold,
  listAutoDraftLog,
  listAutoDraftQueue,
  AUTO_DRAFT_THRESHOLD_DEFAULT,
  AUTO_DRAFT_RATE_LIMIT_24H,
} from "@/lib/auto-draft";
import { AutoDraftSettingsPanel } from "./AutoDraftSettingsPanel";
import { SignOutPanel } from "./SignOutPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const enabled = getAutoDraftEnabled();
  const envForcesDisabled = ["false", "0", "off"].includes(
    (process.env.AUTO_DRAFT_ENABLED ?? "").trim().toLowerCase(),
  );
  const threshold = getAutoDraftThreshold();
  const log = listAutoDraftLog({ userEmail: session.email, limit: 30 });
  const queue = listAutoDraftQueue({ userEmail: session.email, openOnly: true });

  return (
    <div className="mx-auto max-w-5xl px-6 pt-3">
      <AppHeader
        tagline="Settings"
        title="Settings"
        subtitle="Operator controls — auto-draft behavior, thresholds, and run history."
        userLabel={session.name ?? session.email}
        activeNav="settings"
      />
      <div className="mt-6 space-y-6">
        <AutoDraftSettingsPanel
          initial={{
            enabled,
            envForcesDisabled,
            threshold,
            thresholdDefault: AUTO_DRAFT_THRESHOLD_DEFAULT,
            rateLimit24h: AUTO_DRAFT_RATE_LIMIT_24H,
            log,
            queue,
          }}
        />
        <SignOutPanel email={session.email} />
      </div>
    </div>
  );
}

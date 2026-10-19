import Link from "next/link";
import type { ReactNode } from "react";
import { DecisionsBadge } from "./DecisionsBadge";

type AppHeaderProps = {
  tagline: string;
  title: ReactNode;
  subtitle?: ReactNode;
  userLabel?: string;
  /** Extra controls rendered before the nav (e.g. status pills). */
  leadingActions?: ReactNode;
  /** Extra controls rendered after the nav (e.g. sign-out button). */
  trailingActions?: ReactNode;
  /**
   * Active nav slug — styles that link as the current page.
   */
  activeNav?:
    | "search"
    | "opportunities"
    | "workbench"
    | "drafts"
    | "nofos"
    | "pools"
    | "scouts"
    | "teaming"
    | "contracts"
    | "partners"
    | "contacts"
    | "reference"
    | "copilot"
    | "calendar"
    | "activity"
    | "decisions"
    | "boilerplate"
    | "learning"
    | "usage"
    | "settings";
  /** Number of open decisions in the queue (Sprint 5). */
  openDecisions?: number;
};

const NAV_BASE = "rounded-md border px-2.5 py-1 text-xs font-medium transition";
const NAV_MUTED = "gs-chip gs-chip-muted";

export function AppHeader({
  tagline,
  title,
  subtitle,
  userLabel,
  leadingActions,
  trailingActions,
  openDecisions,
}: AppHeaderProps) {
  return (
    <header className="gs-chrome sticky top-0 z-20 -mx-6 px-6 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-widest gs-chrome-tagline">
            {tagline}
          </div>
          <h1 className="mt-0.5 truncate text-lg font-semibold text-white">{title}</h1>
          {subtitle ? (
            <p className="mt-0.5 truncate text-xs text-white/60">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {leadingActions}
          <DecisionsBadge />
          {typeof openDecisions === "number" && openDecisions > 0 && (
            // Server-rendered override badge (used on /decisions page itself).
            <Link
              href="/decisions"
              className="gs-chip gs-chip-cta rounded-md border px-2.5 py-1 text-xs font-semibold"
              title={`${openDecisions} decision${openDecisions === 1 ? "" : "s"} waiting`}
            >
              ● {openDecisions} decision{openDecisions === 1 ? "" : "s"} waiting
            </Link>
          )}
          {userLabel ? (
            <span className="hidden border-l border-white/10 pl-2 text-xs text-white/55 sm:inline">
              {userLabel}
            </span>
          ) : null}
          {trailingActions}
        </div>
      </div>
    </header>
  );
}

export const APP_HEADER_NAV_BASE = NAV_BASE;
export const APP_HEADER_NAV_MUTED = NAV_MUTED;

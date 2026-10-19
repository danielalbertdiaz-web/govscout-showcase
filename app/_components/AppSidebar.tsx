"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: ReactNode };
type NavGroup = { label: string; items: NavItem[] };

const ICON: Record<string, ReactNode> = {
  trackl: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12l6-6" />
      <circle cx="12" cy="12" r="0.5" />
    </>
  ),
  home: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  scouts: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  opportunities: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  pools: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  nofos: (
    <>
      <path d="M14 3v5h5" />
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" />
      <path d="M8 13h8M8 17h6" />
    </>
  ),
  partners: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a6 6 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5" />
      <path d="M20.5 20a6 6 0 0 0-3.2-5.3" />
    </>
  ),
  contacts: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8.5 17a3.5 3.5 0 0 1 7 0" />
      <path d="M2.5 8h2M2.5 12h2M2.5 16h2" />
    </>
  ),
  reference: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" />
      <path d="M4 19a2 2 0 0 0 2 2h13" />
      <path d="M9 7h6M9 10h6" />
    </>
  ),
  teaming: (
    <>
      <path d="M9 7a3 3 0 1 0 0-.01" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3.5 20a6 6 0 0 1 11 0" />
      <path d="M15 14.5a5 5 0 0 1 5.5 5.5" />
    </>
  ),
  contracts: (
    <>
      <path d="M14 3v5h5" />
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M9 17h6M9 13h6M9 9h1" />
    </>
  ),
  bidboard: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="5" height="13" rx="1" />
    </>
  ),
  workbench: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="5" rx="1" />
      <rect x="13" y="10" width="8" height="11" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
    </>
  ),
  drafts: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
    </>
  ),
  boilerplate: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2H9V4Z" />
      <path d="M9 11h6M9 15h6" />
    </>
  ),
  decisions: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  cron: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5" />
      <path d="M9 2h6" />
    </>
  ),
  learning: (
    <>
      <path d="M3 7l9-4 9 4-9 4-9-4Z" />
      <path d="M7 9v5c0 1 2 2 5 2s5-1 5-2V9" />
    </>
  ),
  usage: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 14l3-3 3 3 5-6" />
    </>
  ),
  alfred: (
    <>
      <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z" />
      <path d="M19 14.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9Z" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </>
  ),
  // Clients group: community/houses for Riverside (community action agency),
  // hard hat for Northstar Training Institute (construction-safety training nonprofit).
  riverside: (
    <>
      <path d="M2 20h20" />
      <path d="M4 20v-6l4-3 4 3v6" />
      <path d="M12 20v-9l4-3 4 3v9" />
      <path d="M7 20v-3h2v3M16 20v-3h2v3" />
    </>
  ),
  northstar: (
    <>
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M2 15h20v3H2z" />
      <path d="M10 7.5V4h4v3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </>
  ),
};

// Nav pruned 2026-08-26 (the operator's call, evidence-based): the goal is
// eligibility visibility + tracking; drafting happens outside the app.
// Removed as dead weight (tables frozen since the June 10-11 scan-rail stop,
// or empty): Search, Scouts, Teaming, NOFOs, Reference, Contacts, the old
// in-app /copilot Alfred (superseded by the cron-health bridge), Usage —
// plus Workbench/Track L/Partners earlier the same day. De-navigation only:
// every route stays live for direct URLs and the agents' APIs.
const GROUPS: NavGroup[] = [
  {
    label: "Pipeline",
    items: [
      { href: "/", label: "Home", icon: ICON.home },
      { href: "/bid-board", label: "Bid Board", icon: ICON.bidboard },
      { href: "/opportunities", label: "Opportunities", icon: ICON.opportunities },
      { href: "/contracts", label: "Contracts", icon: ICON.contracts },
      { href: "/pools", label: "Pools", icon: ICON.pools },
      { href: "/decisions", label: "Decisions", icon: ICON.decisions },
    ],
  },
  {
    // Client workspaces — each is a corpus-isolated panel (migration 043,
    // PANEL_ISOLATION_SPEC.md), not a filtered view of Acme's pipeline.
    label: "Clients",
    items: [
      { href: "/grants/riverside", label: "Riverside", icon: ICON.riverside },
      { href: "/grants/northstar", label: "Northstar Training Institute", icon: ICON.northstar },
    ],
  },
  {
    // Surfaces that exist for the agents' benefit, not the operator's daily use:
    // the content library agents draft from, their state/audit logs, and the
    // score-calibration record. Grouped so a human glance can skip them.
    label: "For AI Agents",
    items: [
      { href: "/drafts", label: "Drafts", icon: ICON.drafts },
      { href: "/boilerplate", label: "Boilerplate", icon: ICON.boilerplate },
      { href: "/activity", label: "Activity", icon: ICON.activity },
      { href: "/learning", label: "Learning", icon: ICON.learning },
    ],
  },
];

const FOOTER: NavItem[] = [
  { href: "/cron-health", label: "Cron health", icon: ICON.cron },
  { href: "/calendar", label: "Calendar", icon: ICON.calendar },
  { href: "/settings", label: "Settings", icon: ICON.settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function useOpenDecisions(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/decisions?status=open");
        if (!r.ok) return;
        const data = (await r.json()) as { decisions: Array<unknown> };
        if (alive) setCount(data.decisions.length);
      } catch {
        // ignore — badge just stays at its last value
      }
    }
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return count;
}

function NavRow({
  item,
  active,
  collapsed,
  badge,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={item.href}
      className={`gs-nav-item ${active ? "gs-nav-item-active" : ""} ${
        collapsed ? "justify-center" : ""
      }`}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {item.icon}
      </svg>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {!collapsed && typeof badge === "number" && badge > 0 && (
        <span className="gs-nav-badge">{badge}</span>
      )}
      {collapsed && typeof badge === "number" && badge > 0 && <span className="gs-nav-dot" aria-hidden />}
    </Link>
  );
}

export function AppSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname() ?? "/";
  const openDecisions = useOpenDecisions();

  return (
    <aside
      className="gs-sidebar fixed inset-y-0 left-0 z-40 flex flex-col"
      style={{ width: collapsed ? 64 : 240 }}
      aria-label="Primary navigation"
    >
      {/* Collapse control lives up here: the old bottom placement sat exactly
          under Next.js's floating dev-tools button, which swallowed every
          click (operator-reported). Top-right of the brand row is also the
          conventional spot. */}
      <div className={`flex h-14 items-center border-b border-white/10 ${collapsed ? "justify-center px-0" : "px-4"}`}>
        <svg className="gs-logo-mark" viewBox="0 0 40 40" fill="none" aria-hidden>
          <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="2" />
          <path d="M12 18L18 24L28 14" stroke="#D4A853" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="20" cy="6" r="3" fill="#D4A853" />
          <line x1="20" y1="3" x2="20" y2="0" stroke="#D4A853" strokeWidth="1.5" />
        </svg>
        {!collapsed && (
          <span className="gs-wordmark ml-2.5">
            Gov<span className="gs-wordmark-accent">Scout</span>
          </span>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="ml-auto rounded-md p-1.5 text-stone-400 transition hover:bg-white/10 hover:text-white"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          className="mx-auto mt-2 rounded-md p-1.5 text-stone-400 transition hover:bg-white/10 hover:text-white"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      )}

      <nav className="gs-scroll flex-1 overflow-y-auto px-2.5 py-3">
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && <div className="gs-nav-group-label px-2.5 pb-1.5">{group.label}</div>}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavRow
                  key={item.href}
                  item={item}
                  active={isActive(pathname, item.href)}
                  collapsed={collapsed}
                  badge={item.href === "/decisions" ? openDecisions : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 px-2.5 py-3">
        <div className="flex flex-col gap-0.5">
          {FOOTER.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              active={isActive(pathname, item.href)}
              collapsed={collapsed}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

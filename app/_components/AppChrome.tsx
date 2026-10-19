"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "./AppSidebar";

const COLLAPSE_KEY = "gs.sidebar.collapsed";

// Routes that render full-bleed without the app shell.
const BARE_ROUTES = ["/login"];

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  // Always expanded on first paint so server and client HTML match; the stored
  // preference is applied after mount to avoid a hydration mismatch.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      // Intentional post-mount read: SSR has no localStorage, so we must apply
      // the stored preference here (not via a lazy initializer) to keep the
      // first client paint identical to the server HTML and avoid a hydration
      // mismatch. The synchronous setState is the point, not a mistake.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
    } catch {
      // ignore — default expanded
    }
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore — preference just won't persist
      }
      return next;
    });
  };

  if (BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))) {
    return <>{children}</>;
  }

  // Wrap in a single element so the global `.gs-canvas > *` rule targets this
  // wrapper rather than the fixed sidebar (which it would otherwise force into
  // normal flow, pushing all page content down).
  return (
    <div className="gs-shell">
      <AppSidebar collapsed={collapsed} onToggle={toggle} />
      <div className="gs-shell-main" style={{ paddingLeft: collapsed ? 64 : 240 }}>
        {children}
      </div>
    </div>
  );
}

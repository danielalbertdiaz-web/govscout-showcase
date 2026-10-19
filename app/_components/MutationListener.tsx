"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// Listens to /api/events SSE and triggers a soft refresh on each mutation
// event so any pane in the foreground updates without a hard reload.
// Throttled so a burst of tool calls doesn't slam router.refresh().
export function MutationListener() {
  const router = useRouter();
  const lastRefresh = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let es: EventSource | null = null;
    let cancelled = false;

    function refresh() {
      const now = Date.now();
      if (now - lastRefresh.current < 600) return;
      lastRefresh.current = now;
      router.refresh();
    }

    function connect() {
      if (cancelled) return;
      try {
        es = new EventSource("/api/events");
        es.addEventListener("hello", () => {
          // no-op; just confirms the connection
        });
        es.addEventListener("tool_call", refresh);
        es.addEventListener("decision_created", refresh);
        es.addEventListener("decision_resolved", refresh);
        es.addEventListener("draft_status_changed", refresh);
        es.addEventListener("pool_status_changed", refresh);
        es.addEventListener("suggestion_created", refresh);
        es.onerror = () => {
          // Browser auto-reconnects on EventSource error; nothing to do.
        };
      } catch {
        // ignore: not all browsers support EventSource (every modern one does)
      }
    }
    connect();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [router]);

  return null;
}

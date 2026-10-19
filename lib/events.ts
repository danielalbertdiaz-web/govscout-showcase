/**
 * Tiny in-process pub/sub for cross-pane mutation events.
 *
 * Sprint 6 ships an SSE channel at /api/events. The publisher writes via
 * emitMutation(); the SSE route subscribes per connection. No external
 * dependency — this is a single-user app on one Node process.
 */

export type MutationEvent = {
  type:
    | "tool_call"
    | "decision_created"
    | "decision_resolved"
    | "draft_status_changed"
    | "pool_status_changed"
    | "suggestion_created"
    | "activity";
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
  userEmail: string;
  at: number;
  [k: string]: unknown;
};

type Listener = (event: MutationEvent) => void;

const listeners = new Set<Listener>();

export function emitMutation(ev: MutationEvent): void {
  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      // listener errors must not break the publisher
    }
  }
}

export function subscribeMutations(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

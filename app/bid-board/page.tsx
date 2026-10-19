import { redirect } from "next/navigation";

// The board is per-client panels now (migration 043, PANEL_ISOLATION_SPEC.md):
// /bid-board/el, /bid-board/riverside, /bid-board/northstar. There is deliberately no
// all-clients board view — a blended panel is the leak the isolation spec
// exists to prevent. Bare /bid-board lands on Acme's panel, GovScout's own
// operating history, so every pre-043 bookmark and sidebar link keeps working.
export default function BidBoardIndex() {
  redirect("/bid-board/el");
}

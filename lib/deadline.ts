// The deadline vocabulary — ONE definition (D-1).
//
// Both /bid-board and /opportunities render deadlines. Each once carried its
// own copy of these helpers; a U-3 fix changed the bid-board copy ("past
// due", because "closed" collides with the closed_* statuses on the same
// card) while the unified view kept the stale wording. Duplicates kept in
// sync by hand is what produced that, so the helpers live here and the views
// import them. Do not copy these back into a view.
//
// parseDeadlineMs supplies the parsing rule: empty/garbage input is "no
// deadline", never epoch 0.

import { parseDeadlineMs } from "./pipeline-summary";

const HOUR_MS = 60 * 60 * 1000;

export function hoursLeft(deadline: string | null): number | null {
  const t = parseDeadlineMs(deadline);
  return t == null ? null : (t - Date.now()) / HOUR_MS;
}

/** red <48h, amber <7d, quiet otherwise — the spec's urgency ramp. */
export function deadlineTone(h: number | null): string {
  if (h === null) return "text-stone-400";
  if (h < 0) return "text-stone-400 line-through";
  if (h < 48) return "text-red-600 font-semibold";
  if (h < 7 * 24) return "text-amber-600 font-medium";
  return "text-stone-500";
}

/** "past due", not "closed" — "closed" belongs to the closed_* statuses. */
export function deadlineText(deadline: string | null): string {
  const h = hoursLeft(deadline);
  if (h === null) return "no deadline";
  if (h < 0) return "past due";
  if (h < 1) return "due <1h";
  if (h < 48) return `due in ${Math.floor(h)}h`;
  return `due in ${Math.floor(h / 24)}d`;
}

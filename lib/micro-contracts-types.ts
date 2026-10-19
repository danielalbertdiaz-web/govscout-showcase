// Pure types for micro contracts — no Node.js / DB dependencies so the client
// bundle can import freely without dragging in better-sqlite3.

export const MICRO_CONTRACT_DISPOSITIONS = [
  "new",
  "reviewing",
  "drafting",
  "submitted",
  "passed",
  "won",
] as const;
export type MicroContractDisposition = (typeof MICRO_CONTRACT_DISPOSITIONS)[number];

export function isMicroContractDisposition(s: unknown): s is MicroContractDisposition {
  return typeof s === "string" && (MICRO_CONTRACT_DISPOSITIONS as readonly string[]).includes(s);
}

export const MICRO_CONTRACT_DISPOSITION_LABELS: Record<MicroContractDisposition, string> = {
  new: "New",
  reviewing: "Reviewing",
  drafting: "Drafting response",
  submitted: "Submitted",
  passed: "Passed",
  won: "Won",
};

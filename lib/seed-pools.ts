// Seed the funding_pools table with sample demo pools.
// Run via `pnpm tsx lib/seed-pools.ts` OR auto-seeded on first /pools load.

import { createPool, countPoolsForUser, type CreatePoolInput } from "./db";

type SeedPool = Omit<CreatePoolInput, "userEmail">;

const SEED_POOLS: SeedPool[] = [
  {
    rank: 1,
    name: "Example County Opioid Settlement — FY27",
    source: "Example County Health Dept",
    agency: "Example County",
    jurisdiction: "Example County, ST",
    status: "discovered",
    playType: "Direct + RFP shaping",
    allocatedAmount: "$1.2M",
    unspentAmount: "$1.1M (92%)",
    deadlineLabel: "FY27 RFP not yet released",
    fitSummary:
      "Direct fit: Riverside partnership + behavioral health platform experience.",
    wedge: "County lacks RFP-design capacity; offer scoping support early.",
    nextAction: "Request FY27 timeline from county health department.",
    tags: ["opioid", "county", "behavioral-health", "high-priority"],
  },
  {
    rank: 2,
    name: "State Workforce Innovation Fund",
    source: "State Dept. of Labor",
    agency: "State DOL",
    jurisdiction: "Statewide",
    status: "discovered",
    playType: "Training partner",
    allocatedAmount: "$8M FY26",
    unspentAmount: "Multi-round underspend signal",
    deadlineLabel: "Fall 2026 prep window",
    fitSummary: "Register as an eligible training provider for digital-skills programs.",
    wedge: "Provider registration + training partner identification.",
    nextAction: "Complete provider registration before the next round opens.",
    tags: ["workforce", "state", "training"],
  },
  {
    rank: 3,
    name: "Community Health Foundation Grants",
    source: "Example Community Foundation",
    agency: "Example Community Foundation",
    jurisdiction: "Regional",
    status: "discovered",
    playType: "Direct via Riverside sponsor",
    allocatedAmount: "$2M annual",
    unspentAmount: "Rolling cycles",
    deadlineLabel: "Quarterly cycles",
    fitSummary: "Sponsor-backed applications for community health programming.",
    wedge: "Queue sponsor-backed applications across program lanes.",
    nextAction: "Draft concept note with sponsor sign-off.",
    tags: ["foundation", "health", "sponsor"],
  },
];

export function seedPoolsForUser(userEmail: string, force = false): { seeded: number; existing: number } {
  const existing = countPoolsForUser(userEmail);
  if (existing > 0 && !force) return { seeded: 0, existing };
  let seeded = 0;
  for (const pool of SEED_POOLS) {
    createPool({ ...pool, userEmail });
    seeded += 1;
  }
  return { seeded, existing };
}

// P9 — SCOUT PROFILES: the cron/scout rewrite. Discovery used to be hardwired
// to one mission (behavioral health). A profile is a VERTICAL — its keywords,
// NAICS codes, and foundation themes — and every scanner lane runs once per
// enabled profile. Adding a market = adding one entry here; nothing else in
// the pipeline changes.
//
// Three verticals ship enabled (operator 2026-06-11):
//   behavioral_health — Acme Consulting's core SUD/recovery practice
//   tech_it           — Atlas Insights: IT modernization, data platforms, telehealth tech
//   awareness         — Brightline: public awareness, health communication, media campaigns

import type { GrantTheme } from "./ntee-themes";

export type ScoutProfile = {
  id: string;
  label: string;
  enabled: boolean;
  /** Lead partner this vertical exists for — shown in digests. */
  champion: string;
  /** Free-text keywords: foundation lane, underspend lane, search bias. */
  keywords: string[];
  /** NAICS codes: teaming lane + search filters. */
  naics: string[];
  /** NTEE-mapped themes for the foundation/non-profit lanes (may be empty). */
  themes: GrantTheme[];
};

export const SCOUT_PROFILES: ScoutProfile[] = [
  {
    id: "behavioral_health",
    label: "Behavioral health & SUD",
    enabled: true,
    champion: "Acme Consulting",
    keywords: [
      "substance use",
      "substance abuse",
      "opioid",
      "overdose",
      "recovery",
      "behavioral health",
      "mental health",
      "addiction",
      "prevention",
      "harm reduction",
      "treatment",
      "reentry",
    ],
    naics: ["621330", "621420", "623220", "624190", "541720"],
    themes: ["substance_use", "behavioral_health", "reentry"],
  },
  {
    id: "tech_it",
    label: "Technology & IT (Atlas Insights)",
    enabled: true,
    champion: "Atlas Insights",
    keywords: [
      "information technology",
      "it modernization",
      "data platform",
      "telehealth",
      "health information technology",
      "cybersecurity",
      "broadband",
      "digital services",
      "software development",
      "data dashboard",
      "interoperability",
    ],
    naics: ["541511", "541512", "541513", "541519", "518210"],
    themes: [],
  },
  {
    id: "awareness",
    label: "Public awareness & campaigns (Brightline)",
    enabled: true,
    champion: "Brightline",
    keywords: [
      "public awareness",
      "awareness campaign",
      "media campaign",
      "health communication",
      "outreach campaign",
      "public education",
      "multilingual outreach",
      "marketing campaign",
      "community engagement",
      "stigma reduction",
    ],
    naics: ["541810", "541820", "541613", "541910"],
    themes: [],
  },
];

export function enabledProfiles(): ScoutProfile[] {
  return SCOUT_PROFILES.filter((p) => p.enabled);
}

export function getProfile(id: string): ScoutProfile | null {
  return SCOUT_PROFILES.find((p) => p.id === id) ?? null;
}

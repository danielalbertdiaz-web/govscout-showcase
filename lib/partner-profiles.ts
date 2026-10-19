// Item 4.2 — structured per-partner profile (load-bearing, pure + thin fs shell).
//
// WHY A DEDICATED PROFILE (vs. the lean partner index): the index is the
// orchestrator's auto-match table. Partner-fit ranking and pre-drafted intros
// need richer, *version-controlled* facts (certifications, geography, past
// performance, a named human contact, deal posture) AND a hard 1.6 boundary:
//
//   - PARTNER-FACING fields (introBlurb, capabilities, certifications,
//     pastPerformance, dealStructure) may appear in a generated intro/export.
//   - INTERNAL-ONLY fields (redLines, internalNotes) are operator guardrails;
//     they must NEVER render to a partner surface.
//
// The split is structural, not a post-hoc filter: the two classes live in
// different keys, and `partnerFacingProfile()` returns only the safe ones with
// `sanitizePartnerCopy` applied as a second layer of defense. Profiles live in
// version-controlled `data/partner-profiles/<id>.json`; when one is absent we
// derive a minimal profile from the partner index so ranking still works.

import { promises as fs } from "fs";
import path from "path";
import { sanitizePartnerCopy } from "./partner-copy";
import type { Partner } from "./partners";

export type PastPerformance = {
  client: string;
  scope: string;
  year: string | null;
};

export type PartnerProfile = {
  id: string;
  name: string;
  type: string;
  status: string;
  // ---- Partner-FACING (1.6-safe; may appear in intros/exports) ----
  capabilities: string[];
  certifications: string[];
  geography: { states: string[]; footprint: string };
  pastPerformance: PastPerformance[];
  contact: { human: string | null; email: string | null };
  dealStructure: string; // partner-safe commercial framing
  introBlurb: string; // partner-safe one-liner used to open an intro
  // ---- INTERNAL-ONLY (never rendered to a partner) ----
  redLines: string[]; // operator deal constraints / guardrails
  internalNotes: string | null; // private relationship framing
};

// The subset of a profile that is safe to render to a partner. Every string is
// run through the 1.6 sanitizer so even a mis-authored facing field can't leak
// banned copy. This is the ONLY shape the intro composer / exports should read.
export type PartnerFacingProfile = {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  certifications: string[];
  geography: { states: string[]; footprint: string };
  pastPerformance: PastPerformance[];
  contact: { human: string | null; email: string | null };
  dealStructure: string;
  introBlurb: string;
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.trim() : fallback;
}

function coercePastPerformance(v: unknown): PastPerformance[] {
  if (!Array.isArray(v)) return [];
  const out: PastPerformance[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const client = asString(o.client);
    const scope = asString(o.scope);
    if (!client && !scope) continue;
    out.push({ client, scope, year: o.year != null ? String(o.year).trim() : null });
  }
  return out;
}

// Coerce arbitrary JSON into a valid PartnerProfile. Total: never throws; fills
// every field with a safe default so downstream code can rely on the shape.
export function normalizePartnerProfile(raw: unknown, idHint?: string): PartnerProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id) || asString(idHint);
  if (!id) return null;
  const geoRaw = (r.geography ?? {}) as Record<string, unknown>;
  const contactRaw = (r.contact ?? {}) as Record<string, unknown>;
  return {
    id,
    name: asString(r.name) || id,
    type: asString(r.type),
    status: asString(r.status) || "active",
    capabilities: asStringArray(r.capabilities),
    certifications: asStringArray(r.certifications),
    geography: {
      states: asStringArray(geoRaw.states).map((s) => s.toUpperCase()),
      footprint: asString(geoRaw.footprint),
    },
    pastPerformance: coercePastPerformance(r.pastPerformance),
    contact: {
      human: contactRaw.human != null ? asString(contactRaw.human) || null : null,
      email: contactRaw.email != null ? asString(contactRaw.email) || null : null,
    },
    dealStructure: asString(r.dealStructure),
    introBlurb: asString(r.introBlurb),
    redLines: asStringArray(r.redLines),
    internalNotes: r.internalNotes != null ? asString(r.internalNotes) || null : null,
  };
}

// Derive a minimal profile from the lean partner index when no version-controlled
// JSON exists. CRITICAL 1.6 BOUNDARY: the index's `integration_notes` carry
// internal framing (e.g. "Will greenlight whatever Acme proposes", "not a PG/debt
// scenario"), so they route to `internalNotes` ONLY — never to a facing field.
// The facing `introBlurb` is built from the neutral public `description`.
export function deriveProfileFromPartner(p: Partner): PartnerProfile {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    status: p.status || "active",
    capabilities: p.capabilities ?? [],
    certifications: [],
    geography: { states: [], footprint: "" },
    pastPerformance: [],
    contact: { human: p.contact || null, email: null },
    dealStructure: p.commission_structure || "",
    introBlurb: p.description || "",
    redLines: [],
    internalNotes: p.integration_notes || null, // internal-only by construction
  };
}

// Project a full profile to its partner-safe view, sanitizing every facing
// string through the 1.6 chokepoint. redLines / internalNotes are dropped here.
export function partnerFacingProfile(profile: PartnerProfile): PartnerFacingProfile {
  const clean = (s: string) => sanitizePartnerCopy(s).clean;
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    capabilities: profile.capabilities.map(clean),
    certifications: profile.certifications.map(clean),
    geography: {
      states: profile.geography.states,
      footprint: clean(profile.geography.footprint),
    },
    pastPerformance: profile.pastPerformance.map((pp) => ({
      client: clean(pp.client),
      scope: clean(pp.scope),
      year: pp.year,
    })),
    contact: profile.contact,
    dealStructure: clean(profile.dealStructure),
    introBlurb: clean(profile.introBlurb),
  };
}

// ---- Thin fs shell --------------------------------------------------------

const DEFAULT_PROFILES_DIR = path.join(process.cwd(), "data", "partner-profiles");

export function profilesDir(): string {
  return process.env.PARTNER_PROFILES_DIR?.trim() || DEFAULT_PROFILES_DIR;
}

// Load one profile by id from the version-controlled JSON, falling back to a
// derived profile when no file exists (or it's malformed). `fallback` is the
// index partner used for the derive path.
export async function loadPartnerProfile(
  id: string,
  fallback?: Partner,
): Promise<PartnerProfile | null> {
  const file = path.join(profilesDir(), `${id}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = normalizePartnerProfile(JSON.parse(raw), id);
    if (parsed) return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // Malformed JSON shouldn't crash ranking — fall through to derive.
    }
  }
  return fallback ? deriveProfileFromPartner(fallback) : null;
}

// Load every profile for the given index partners. Each partner gets either its
// version-controlled JSON or a derived profile — so the roster is always whole.
export async function loadAllPartnerProfiles(partners: Partner[]): Promise<PartnerProfile[]> {
  const out: PartnerProfile[] = [];
  for (const p of partners) {
    const profile = await loadPartnerProfile(p.id, p);
    if (profile) out.push(profile);
  }
  return out;
}

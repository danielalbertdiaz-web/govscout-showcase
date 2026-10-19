// Track L (Earmarked Awareness Radar) — schema, idempotent upserts, and §3
// scoring against a fresh temp DB (same isolation pattern as
// federal-pipeline.test.ts: chdir to a mkdtemp dir before dynamic import).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let tl: typeof import("../lib/track-l");

function isoMonthsAgo(months: number): string {
  return new Date(Date.now() - months * 30.44 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isoMonthsAhead(months: number): string {
  return new Date(Date.now() + months * 30.44 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trackl-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  tl = await import("../lib/track-l");
});

describe("upsertAgency", () => {
  it("creates, then dedupes on (tenant, name, state) and preserves fields", () => {
    const a = tl.upsertAgency({
      name: "Franklin County Public Health",
      state: "oh",
      type: "LOCAL_HEALTH",
      website: "https://myfcph.org",
    });
    assert.equal(a.created, true);
    assert.equal(a.agency.state, "OH");
    const b = tl.upsertAgency({ name: "Franklin County Public Health", state: "OH", county: "Franklin" });
    assert.equal(b.created, false);
    assert.equal(b.agency.id, a.agency.id);
    assert.equal(b.agency.county, "Franklin");
    // absent fields survive (preserve-on-upsert)
    assert.equal(b.agency.website, "https://myfcph.org");
  });

  it("rejects bad state / blank name", () => {
    assert.throws(() => tl.upsertAgency({ name: "X", state: "Ohio" }));
    assert.throws(() => tl.upsertAgency({ name: "  ", state: "OH" }));
  });
});

describe("contacts", () => {
  it("dedupes on (agency, email), keeps strongest priority, fills name", () => {
    const { agency } = tl.upsertAgency({ name: "Summit County Public Health", state: "OH" });
    const a = tl.upsertContact({
      agencyId: agency.id,
      email: "INFO@scph.example.org",
      isGeneric: true,
      priority: "P4_GENERIC",
      source: "NACCHO",
    });
    assert.equal(a.created, true);
    assert.equal(a.contact.email, "info@scph.example.org"); // normalized
    const b = tl.upsertContact({
      agencyId: agency.id,
      email: "info@scph.example.org",
      name: "Health Commissioner Office",
      priority: "P2_HEALTH_OFFICER",
      source: "DEPT_SITE",
    });
    assert.equal(b.created, false);
    assert.equal(b.contact.priority, "P2_HEALTH_OFFICER");
    assert.equal(b.contact.name, "Health Commissioner Office");
    assert.throws(() =>
      tl.upsertContact({ agencyId: agency.id, email: "not-an-email", priority: "P4_GENERIC", source: "NACCHO" }),
    );
  });
});

describe("scoring (§3)", () => {
  it("recent award decays linearly 40→20 and sets DREAM at ≥50", () => {
    const { agency } = tl.upsertAgency({ name: "Cuyahoga County Board of Health", state: "OH" });
    tl.upsertFundingEvent({
      agencyId: agency.id,
      program: "HUD_LHC",
      amount: 2_400_000,
      awardDate: isoMonthsAgo(0.1),
      spendDeadline: isoMonthsAhead(12),
      sourceUrl: "https://www.usaspending.gov/award/x",
    });
    let a = tl.getAgencyById(agency.id)!;
    // fresh award ≈ +40, deadline within 18mo +10 → 50 → DREAM
    assert.equal(a.score, 50);
    assert.equal(a.tier, "DREAM");
    assert.ok(a.reasonCodes.length >= 2, `reason codes: ${JSON.stringify(a.reasonCodes)}`);
    assert.ok(a.reasonCodes.some((r) => r.includes("HUD LHC")));

    // ~12-month-old award on another agency decays to ≈ +20
    const { agency: old } = tl.upsertAgency({ name: "Old Award City Health Dept", state: "PA" });
    tl.upsertFundingEvent({
      agencyId: old.id,
      program: "HUD_HH",
      awardDate: isoMonthsAgo(11.8),
      sourceUrl: "https://www.usaspending.gov/award/y",
    });
    a = tl.getAgencyById(old.id)!;
    assert.ok(a.score >= 20 && a.score <= 21, `decayed score ${a.score}`);
    assert.equal(a.tier, "STANDARD");
  });

  it("housing + blood-lead + LSLR + news stack with reason codes", () => {
    const { agency } = tl.upsertAgency({
      name: "Lead Test County Health",
      state: "MI",
      housingPre1978Pct: 78,
      bloodLeadElevated: true,
    });
    tl.upsertSignal({ agencyId: agency.id, type: "LSLR_MANDATE", weight: 15, note: "DWSRF LSLR participant" });
    tl.upsertSignal({ agencyId: agency.id, type: "NEWS_EVENT", weight: 5, note: "Local lead coverage" });
    const a = tl.getAgencyById(agency.id)!;
    // 20 (≥75% housing) + 25 (blood lead) + 15 (LSLR) + 5 (news) = 65 → DREAM
    assert.equal(a.score, 65);
    assert.equal(a.tier, "DREAM");
    assert.equal(a.reasonCodes.length, 4);
    assert.ok(a.reasonCodes.some((r) => r.includes("pre-1980 proxy")));
  });

  it("zero-score agencies stay LOW with empty reason codes", () => {
    const { agency } = tl.upsertAgency({ name: "Quiet Township Health", state: "VT" });
    const a = tl.getAgencyById(agency.id)!;
    assert.equal(a.score, 0);
    assert.equal(a.tier, "LOW");
    assert.deepEqual(a.reasonCodes, []);
  });
});

describe("idempotent re-runs (§8 zero duplicates)", () => {
  it("funding events + signals dedupe on natural keys", () => {
    const { agency } = tl.upsertAgency({ name: "Rerun County Health", state: "NY" });
    const e1 = tl.upsertFundingEvent({
      agencyId: agency.id,
      program: "HUD_LHC",
      amount: 1_000_000,
      awardDate: "2026-03-15",
      sourceUrl: "https://example.gov/a",
    });
    const e2 = tl.upsertFundingEvent({
      agencyId: agency.id,
      program: "HUD_LHC",
      amount: 1_100_000, // refreshed amount
      awardDate: "2026-03-15",
      sourceUrl: "https://example.gov/a",
    });
    assert.equal(e1.created, true);
    assert.equal(e2.created, false);
    assert.equal(e2.event.id, e1.event.id);
    assert.equal(e2.event.amount, 1_100_000);

    const s1 = tl.upsertSignal({ agencyId: agency.id, type: "NEWS_EVENT", weight: 5, sourceUrl: "https://n.ews/1" });
    const s2 = tl.upsertSignal({ agencyId: agency.id, type: "NEWS_EVENT", weight: 5, sourceUrl: "https://n.ews/1" });
    assert.equal(s1.created, true);
    assert.equal(s2.created, false);
  });

  it("unmatched awards land in review queue and dedupe", () => {
    const a = tl.insertUnmatchedAward({
      granteeName: "Mystery Housing Authority",
      state: "TX",
      program: "HUD_LHC",
      amount: 500_000,
      awardDate: "2026-01-02",
      sourceUrl: "https://example.gov/u",
    });
    const b = tl.insertUnmatchedAward({
      granteeName: "Mystery Housing Authority",
      state: "TX",
      program: "HUD_LHC",
      awardDate: "2026-01-02",
      sourceUrl: "https://example.gov/u",
    });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(tl.listUnmatchedAwards().length, 1);
  });
});

describe("fuzzy grantee matching", () => {
  it("matches normalized county-health variants, misses stay null", () => {
    const { agency } = tl.upsertAgency({ name: "Erie County Department of Health", state: "NY" });
    const hit = tl.findAgencyByFuzzyName("ERIE COUNTY, DEPT OF HEALTH", "NY");
    assert.equal(hit?.id, agency.id);
    assert.equal(tl.findAgencyByFuzzyName("Totally Unrelated Org", "NY"), null);
  });
});

describe("list + detail (§6/§7)", () => {
  it("filters by state/tier/program/score and rolls up counts", () => {
    const { rows, total } = tl.listAgencies({ state: "OH" });
    assert.ok(total >= 3);
    assert.ok(rows.every((r) => r.state === "OH"));
    const dream = tl.listAgencies({ tier: "DREAM" });
    assert.ok(dream.rows.every((r) => r.tier === "DREAM"));
    const hud = tl.listAgencies({ program: "HUD_LHC" });
    assert.ok(hud.rows.length >= 1);
    assert.ok(hud.rows.every((r) => r.fundingEventCount >= 1));
    const ranged = tl.listAgencies({ scoreMin: 50 });
    assert.ok(ranged.rows.every((r) => r.score >= 50));

    const detail = tl.getAgencyDetail(hud.rows[0].id)!;
    assert.ok(detail.fundingEvents.length >= 1);
    assert.equal(detail.outreachStage, "COLD");
  });
});

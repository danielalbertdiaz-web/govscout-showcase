// The §5 counter-example (SCANNER_SCORING_DEFECT_PACKET): the Tier 1
// disqualifier must fire BEFORE the AI-deliverability number is computed.
//
// In this pipeline, scoring happens strictly downstream of staging — the
// scanning agent reasons only over rows persisted to micro_contracts. So the
// pre-score/post-score distinction is mechanically checkable: a sole-source
// notice must NEVER REACH THE STAGING TABLE AT ALL (it can then never receive
// a "100/100" verdict), and it must appear in the scan result's
// excludedIneligible report (never silently dropped). If the gate is ever
// moved after staging — the score-then-filter shape §5 explicitly rejects —
// the direct DB assertions here fail.
//
// Same temp-DB isolation pattern as tests/micro-contracts-scan.test.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let scan: typeof import("../lib/micro-contracts-scan");
let dbmod: typeof import("../lib/db");

const OWNER = "test@example.com";
const realFetch = globalThis.fetch;

// Real disqualifying text from FD2399-26-00126: the FAR citation and the
// reseller clause were in the notice text the scanner already had.
const AGI_STK = {
  noticeId: "agi-stk-1",
  title: "Ansys Government Initiatives (AGI) Systems Tool Kit (STK), Enterprise Collection Planner",
  description:
    "The Government intends to award on a brand name basis pursuant to FAR 16.505(a)(4)(i). " +
    "Only an authorized Ansys/AGI STK reseller may submit a quotation.",
};

// ACWS26-CFS-001 shape: enterprise-scale signals everywhere, but no
// string-detectable eligibility fact — Tier 2 territory, and Tier 2 must
// NEVER exclude at discovery (a large program can hold an Acme-shaped carve-out).
const ACWS = {
  noticeId: "acws-1",
  title: "Army Contract Writing System (ACWS) Sustainment, Support, and Enhancement",
  description:
    "Final Call for Solutions under a Commercial Solutions Opening (CSO): Agentic AI/automation, " +
    "IL-6 secure cloud hosting, Virtual Contracting Enterprise (VCE) integration, Tier 3 ops support.",
};

const CLEAN = {
  noticeId: "clean-1",
  title: "AI chatbot pilot, firm fixed price",
  description: "Single deliverable, 90-day period of performance.",
};

function samBody(notices: Array<{ noticeId: string; title: string; description: string }>) {
  return {
    opportunitiesData: notices.map((n) => ({
      noticeId: n.noticeId,
      title: n.title,
      description: n.description,
      type: "Solicitation",
      naicsCode: "541519",
      fullParentPathName: "TEST DEPT",
      postedDate: "2026-08-01",
      responseDeadLine: "2026-09-01",
      uiLink: `https://sam.gov/opp/${n.noticeId}/view`,
    })),
  };
}

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "micro-scan-tier1-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  process.env.SAM_GOV_API_KEY = "test-key";
  scan = await import("../lib/micro-contracts-scan");
  dbmod = await import("../lib/db");
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => samBody([AGI_STK, ACWS, CLEAN]),
  })) as unknown as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

describe("Tier 1 discovery gate (pre-score exclusion)", () => {
  it("a sole-source notice is excluded BEFORE staging — it can never be scored — and is reported, not dropped", async () => {
    const result = await scan.runMicroContractScan(OWNER);
    assert.equal(result.available, true);

    // The DB is what the scoring agent reads. The sole-source notice must not
    // be in it — this is the assertion that fails if the gate ever moves to
    // a post-staging (post-score) filter.
    const staged = dbmod.listMicroContracts(OWNER).map((r) => r.noticeId);
    assert.ok(!staged.includes(AGI_STK.noticeId), "sole-source notice must never reach the staging table");

    // Never silently dropped: the exclusion is in the scan report, typed, with
    // the matched evidence.
    assert.equal(result.excludedIneligible.length, 1);
    const excluded = result.excludedIneligible[0];
    assert.equal(excluded.noticeId, AGI_STK.noticeId);
    assert.equal(excluded.reason, "sole_source_brand_name");
    assert.match(excluded.evidence, /16\.505/);
  });

  it("Tier 2 scale signals do NOT exclude at discovery — the ACWS-shaped notice is staged", async () => {
    const staged = dbmod.listMicroContracts(OWNER).map((r) => r.noticeId).sort();
    assert.deepEqual(staged, [ACWS.noticeId, CLEAN.noticeId].sort());
  });

  it("counts stay honest: found counts admitted notices only", async () => {
    const result = await scan.runMicroContractScan(OWNER);
    assert.equal(result.found, 2); // AGI STK is not an admitted candidate
    assert.equal(result.excludedIneligible.length, 1);
  });
});

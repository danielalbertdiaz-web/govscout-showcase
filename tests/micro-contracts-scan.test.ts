// Micro Contracts scan counting — tombstone skips must be visible.
//
// Migration 036 made upsertMicroContract return { skippedDeleted: true } for
// permanently deleted notices instead of writing anything. The scan used to
// count that as "persisted" — a silent skip reported as a success, the exact
// pattern that produced "295 triaged while GovScout held 0". These tests pin
// the corrected counting against a real temp DB with a real tombstone.
//
// Same isolation pattern as tests/federal-pipeline.test.ts: chdir to a
// mkdtemp dir (with lib/migrations symlinked) BEFORE the dynamic import so
// lib/db.ts opens a fresh SQLite file, never the production database.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let scan: typeof import("../lib/micro-contracts-scan");
let dbmod: typeof import("../lib/db");

const OWNER = "test@example.com";
const realFetch = globalThis.fetch;

// Minimal SAM.gov v2 search body accepted by parseSamResponse. The scan
// queries 2 notice types x 4 NAICS codes; returning the same body every time
// is fine — the scanner dedupes on noticeId.
function samBody(notices: Array<{ noticeId: string; title: string }>) {
  return {
    opportunitiesData: notices.map((n) => ({
      noticeId: n.noticeId,
      title: n.title,
      type: "Solicitation",
      naicsCode: "541611",
      fullParentPathName: "TEST DEPT",
      postedDate: "2026-07-01",
      responseDeadLine: "2026-09-01",
      uiLink: `https://sam.gov/opp/${n.noticeId}/view`,
    })),
  };
}

function mockFetch(notices: Array<{ noticeId: string; title: string }>) {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => samBody(notices),
  })) as unknown as typeof fetch;
}

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "micro-scan-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  process.env.SAM_GOV_API_KEY = "test-key";
  scan = await import("../lib/micro-contracts-scan");
  dbmod = await import("../lib/db");

  // Create a notice, then permanently delete it — deleteMicroContract writes
  // the tombstone that a later scan must never resurrect.
  const { record } = dbmod.upsertMicroContract({
    userEmail: OWNER,
    noticeId: "tomb-1",
    solNumber: null,
    title: "Deleted forever",
    agency: "TEST DEPT",
    noticeType: "Solicitation",
    naics: "541611",
    description: null,
    postedDate: null,
    responseDeadline: null,
    setAside: null,
    url: null,
  });
  dbmod.deleteMicroContract(record.id, OWNER, { reason: "test", by: OWNER });
});

after(() => {
  globalThis.fetch = realFetch;
});

describe("runMicroContractScan counting", () => {
  it("counts a tombstoned notice as skippedDeleted, not persisted", async () => {
    mockFetch([
      { noticeId: "tomb-1", title: "Deleted forever" },
      { noticeId: "live-1", title: "Real new notice" },
    ]);
    const result = await scan.runMicroContractScan(OWNER);
    assert.equal(result.available, true);
    assert.equal(result.found, 2);
    assert.equal(result.persisted, 1); // live-1 only — the tombstoned notice wrote nothing
    assert.equal(result.newCount, 1);
    assert.equal(result.skippedDeleted, 1);
    // And the DB agrees: the deleted notice was NOT recreated.
    const rows = dbmod.listMicroContracts(OWNER);
    assert.deepEqual(rows.map((r) => r.noticeId).sort(), ["live-1"]);
  });

  it("still counts a real update as persisted, and newCount stays create-only", async () => {
    mockFetch([
      { noticeId: "tomb-1", title: "Deleted forever" },
      { noticeId: "live-1", title: "Real new notice (amended)" },
    ]);
    const result = await scan.runMicroContractScan(OWNER);
    assert.equal(result.persisted, 1); // live-1 updated — a real write
    assert.equal(result.newCount, 0); // nothing newly created this pass
    assert.equal(result.skippedDeleted, 1); // tombstone skip is still reported
  });

  it("reports zero skippedDeleted when no notice is tombstoned", async () => {
    mockFetch([{ noticeId: "live-2", title: "Another clean notice" }]);
    const result = await scan.runMicroContractScan(OWNER);
    assert.equal(result.persisted, 1);
    assert.equal(result.newCount, 1);
    assert.equal(result.skippedDeleted, 0);
  });

  it("includes skippedDeleted in the unavailable (no API key) shape", async () => {
    const saved = process.env.SAM_GOV_API_KEY;
    delete process.env.SAM_GOV_API_KEY;
    try {
      const result = await scan.runMicroContractScan(OWNER);
      assert.deepEqual(result, {
        available: false,
        found: 0,
        persisted: 0,
        newCount: 0,
        skippedDeleted: 0,
        excludedIneligible: [],
      });
    } finally {
      process.env.SAM_GOV_API_KEY = saved;
    }
  });
});

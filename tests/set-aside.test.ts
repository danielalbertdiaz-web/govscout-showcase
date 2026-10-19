// Controlled set-aside vocabulary (improvement #2). Live fp_opportunities
// spelled "total small business" four ways and "no set-aside" three ways;
// six of the 82 Bid Board merge conflicts were on this field.
//
// The cardinal rule pinned hardest here: unrecognised or absent input maps to
// "unknown", NEVER to "none" — "I could not classify this" and "this is open
// to everyone" are opposite claims, and defaulting to none would silently
// widen eligibility.
//
// Pure tests first; then a temp-db round trip proving both upserts stamp the
// canonical column at ingest while the raw string survives byte-identical.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { normaliseSetAside, isSetAsideCanonical, SET_ASIDE_CANONICAL } from "../lib/set-aside";

let fp: typeof import("../lib/federal-pipeline");
let dbmod: typeof import("../lib/db");

before(async () => {
  // Same temp-cwd harness as federal-pipeline.test.ts.
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "set-aside-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  fp = await import("../lib/federal-pipeline");
  dbmod = await import("../lib/db");
});

describe("normaliseSetAside — vocabulary", () => {
  it("all four live 'Total Small Business' spellings map to the same canonical", () => {
    for (const raw of [
      "Total Small Business Set-Aside",
      "Total Small Business",
      "SBA",
      "SBA Total Small Business",
    ]) {
      assert.equal(normaliseSetAside(raw).canonical, "small_business", raw);
    }
  });

  it("all three 'no set-aside' spellings map to none", () => {
    for (const raw of ["None", "None (full & open)", "No Set-Aside"]) {
      assert.equal(normaliseSetAside(raw).canonical, "none", raw);
    }
  });

  it("unrecognised input maps to unknown and NOT to none — the cardinal rule", () => {
    for (const raw of ["Category 7 Preferred Vendors", "see attachment", "??"]) {
      const { canonical } = normaliseSetAside(raw);
      assert.equal(canonical, "unknown", raw);
      assert.notEqual(canonical, "none", raw);
    }
  });

  it("NULL/empty maps to unknown, not none — absence is not a declaration", () => {
    // All 295 micro rows have NULL set_aside because the importer never
    // captures the field. Mapping that to "none" would declare the entire
    // micro table open-to-everyone on no evidence. Deliberate deviation from
    // reading "(null)" as a none-spelling; flagged in the report.
    assert.equal(normaliseSetAside(null).canonical, "unknown");
    assert.equal(normaliseSetAside("").canonical, "unknown");
    assert.equal(normaliseSetAside("   ").canonical, "unknown");
  });

  it("the raw string always survives, byte-identical", () => {
    for (const raw of ["SBA", "None (full & open)", "TBD — RFI states may be small-business set-aside or full & open", "gibberish"]) {
      assert.equal(normaliseSetAside(raw).raw, raw);
    }
    assert.equal(normaliseSetAside(null).raw, null);
  });

  it("the TBD/RFI speculation lands on unknown, not on either specific reading", () => {
    for (const raw of [
      "TBD — RFI states may be small-business set-aside or full & open",
      "Sources Sought (may set aside SB or full/open)",
      "RFI/Sources Sought (SB incl 8a invited)",
      "RFI/Sources Sought",
    ]) {
      const { canonical } = normaliseSetAside(raw);
      assert.equal(canonical, "unknown", raw);
    }
  });

  it("specific programs map, and beat the generic small-business family", () => {
    assert.equal(normaliseSetAside("8(a) competitive").canonical, "8a");
    assert.equal(normaliseSetAside("SDVOSB Total Small Business Set-Aside").canonical, "sdvosb");
    assert.equal(normaliseSetAside("HUBZone Set-Aside").canonical, "hubzone");
    assert.equal(normaliseSetAside("Women-Owned Small Business (WOSB)").canonical, "wosb");
    assert.equal(normaliseSetAside("EDWOSB set-aside").canonical, "edwosb");
    assert.equal(normaliseSetAside("Indian Small Business Economic Enterprise").canonical, "isbee");
  });

  it("every canonical output is a member of the vocabulary", () => {
    for (const raw of ["SBA", "None", "8(a)", "whatever", null]) {
      assert.ok(isSetAsideCanonical(normaliseSetAside(raw).canonical));
    }
    assert.ok((SET_ASIDE_CANONICAL as readonly string[]).includes("bicIv"), "reserved value stays in the vocabulary");
  });
});

describe("set-aside at ingest", () => {
  it("upsertFpOpportunity stamps the canonical and preserves the raw byte-identical", () => {
    const { opp } = fp.upsertFpOpportunity({ clientId: "el",
      title: "Set-Aside Ingest",
      solNumber: "SETASIDE-FP-1",
      setAside: "SBA Total Small Business",
    });
    assert.equal(opp.setAside, "SBA Total Small Business");
    const rec = fp.findFpOpportunity(opp.id)!;
    assert.equal(rec.setAsideCanonical, "small_business");
    assert.equal(rec.setAside, "SBA Total Small Business", "raw must survive untouched");
    // and an update re-normalises
    fp.upsertFpOpportunity({ clientId: "el", solNumber: "SETASIDE-FP-1", title: "Set-Aside Ingest", setAside: "None (full & open)" });
    const after = fp.findFpOpportunity(opp.id)!;
    assert.equal(after.setAsideCanonical, "none");
    assert.equal(after.setAside, "None (full & open)");
  });

  it("upsertMicroContract stamps the canonical; NULL set-aside lands on unknown", () => {
    const owner = "daniel@test";
    const withValue = dbmod.upsertMicroContract({
      userEmail: owner,
      noticeId: "setaside-micro-1",
      solNumber: null,
      title: "Micro with set-aside",
      agency: null,
      noticeType: "micro-purchase",
      naics: null,
      description: null,
      postedDate: null,
      responseDeadline: null,
      setAside: "Total Small Business Set-Aside",
      url: null,
    });
    assert.equal(withValue.record.setAsideCanonical, "small_business");
    assert.equal(withValue.record.setAside, "Total Small Business Set-Aside");

    const withNull = dbmod.upsertMicroContract({
      userEmail: owner,
      noticeId: "setaside-micro-2",
      solNumber: null,
      title: "Micro without set-aside",
      agency: null,
      noticeType: "micro-purchase",
      naics: null,
      description: null,
      postedDate: null,
      responseDeadline: null,
      setAside: null,
      url: null,
    });
    assert.equal(withNull.record.setAsideCanonical, "unknown", "absence must never become none");
    assert.equal(withNull.record.setAside, null);
  });
});

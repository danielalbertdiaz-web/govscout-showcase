// §14.9 reuse-controls editor (lib side). Migration 033 shipped enforcement
// with no way to operate it — no UI, nothing writing content_hash — which is
// how a 38-byte capability-statement stub stayed approved and drafting-
// reachable for two months. These pin the update path the editor uses.
//
// The PUT route maps every validation failure asserted here to a 400; the
// enum/shape checks live in updateBoilerplate as well, so no caller can
// bypass the API layer.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let bp: typeof import("../lib/boilerplate");
let pm: typeof import("../lib/proposal-memory");

before(async () => {
  // Same temp-cwd harness as federal-pipeline.test.ts: lib/db.ts resolves the
  // sqlite file and migrations dir from process.cwd().
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bp-edit-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  bp = await import("../lib/boilerplate");
  pm = await import("../lib/proposal-memory");
});

function mkBlock(key: string, body = "Original body text."): void {
  bp.upsertBoilerplate({ key, title: `Block ${key}`, bodyMarkdown: body, actor: "test-setup" });
}

describe("boilerplate reuse-controls editing", () => {
  it("editing the body bumps version and updates content_hash", () => {
    mkBlock("edit-hash-1");
    const beforeEdit = bp.getBoilerplate("edit-hash-1")!;
    assert.equal(beforeEdit.version, 1);

    const after = bp.updateBoilerplate("edit-hash-1", { bodyMarkdown: "Rewritten body." }, "daniel@test");
    assert.equal(after.version, 2, "body change must bump version");
    assert.equal(after.contentHash, pm.contentHash("Rewritten body."));
    assert.notEqual(after.contentHash, beforeEdit.contentHash);
  });

  it("editing the body does NOT flip approval_status on its own — but re-attributes the approval", () => {
    mkBlock("edit-approval-1");
    bp.updateBoilerplate("edit-approval-1", { approvalStatus: "approved" }, "approver@test");
    const approved = bp.getBoilerplate("edit-approval-1")!;
    assert.equal(approved.approvalStatus, "approved");
    assert.equal(approved.approvedBy, "approver@test");

    const after = bp.updateBoilerplate("edit-approval-1", { bodyMarkdown: "New text entirely." }, "editor@test");
    assert.equal(after.approvalStatus, "approved", "an edit must not silently change approval");
    // ...but the record must show who approved THIS text.
    assert.equal(after.approvedBy, "editor@test");
    assert.ok(after.approvedAt != null && after.approvedAt >= approved.approvedAt!);
  });

  it("invalid approvalStatus / confidentiality values are rejected, never coerced (route maps these to 400)", () => {
    mkBlock("edit-enum-1");
    assert.throws(
      () => bp.updateBoilerplate("edit-enum-1", { approvalStatus: "blessed" as never }, "t"),
      /invalid approvalStatus/,
    );
    assert.throws(
      () => bp.updateBoilerplate("edit-enum-1", { confidentiality: "secret" as never }, "t"),
      /invalid confidentiality/,
    );
    const untouched = bp.getBoilerplate("edit-enum-1")!;
    assert.equal(untouched.approvalStatus, "unreviewed", "a rejected enum must not be coerced into a write");
    assert.equal(untouched.version, 1, "a rejected edit must write nothing");
  });

  it("setting doNotReuse withholds the block with a reason naming it", () => {
    mkBlock("edit-dnr-1");
    bp.updateBoilerplate("edit-dnr-1", { approvalStatus: "approved" }, "t");
    const withheld = bp.updateBoilerplate(
      "edit-dnr-1",
      { doNotReuse: true, doNotReuseReason: "stale award claim" },
      "t",
    );
    assert.equal(withheld.reuse.usable, false);
    assert.match(withheld.reuse.reason!, /DO_NOT_REUSE/);
    assert.match(withheld.reuse.reason!, /stale award claim/);
  });

  it("expiresAt in the past withholds with the expiry reason", () => {
    mkBlock("edit-exp-1");
    bp.updateBoilerplate("edit-exp-1", { approvalStatus: "approved" }, "t");
    const expired = bp.updateBoilerplate("edit-exp-1", { expiresAt: Date.now() - 1000 }, "t");
    assert.equal(expired.reuse.usable, false);
    assert.match(expired.reuse.reason!, /Expired/);
    // and clearing the expiry restores usability
    const cleared = bp.updateBoilerplate("edit-exp-1", { expiresAt: null }, "t");
    assert.equal(cleared.reuse.usable, true);
  });

  it("restrictedFunders round-trips through JSON", () => {
    mkBlock("edit-funders-1");
    const updated = bp.updateBoilerplate(
      "edit-funders-1",
      { restrictedFunders: ["HUD", "City of Centerville"] },
      "t",
    );
    assert.deepEqual(updated.restrictedFunders, ["HUD", "City of Centerville"]);
    assert.deepEqual(bp.getBoilerplate("edit-funders-1")!.restrictedFunders, ["HUD", "City of Centerville"]);
  });

  it("the Jane Barred hard block still rejects (regression)", () => {
    mkBlock("edit-banned-1");
    assert.throws(
      () => bp.updateBoilerplate("edit-banned-1", { bodyMarkdown: "Contact Jane Barred for details." }, "t"),
      /Jane Barred/,
    );
    assert.equal(bp.getBoilerplate("edit-banned-1")!.bodyMarkdown, "Original body text.");
  });

  it("supersededBy must name a real block and not the block itself", () => {
    mkBlock("edit-sup-1");
    mkBlock("edit-sup-2");
    assert.throws(() => bp.updateBoilerplate("edit-sup-1", { supersededBy: "no-such-key" }, "t"), /matches? no|does not match/);
    assert.throws(() => bp.updateBoilerplate("edit-sup-1", { supersededBy: "edit-sup-1" }, "t"), /supersede itself/);
    const ok = bp.updateBoilerplate("edit-sup-1", { supersededBy: "edit-sup-2" }, "t");
    assert.equal(ok.supersededBy, "edit-sup-2");
    assert.equal(ok.reuse.usable, false);
    assert.match(ok.reuse.reason!, /Superseded/);
  });
});

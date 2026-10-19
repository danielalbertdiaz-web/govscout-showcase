// Proposal Memory reuse controls (V4.1 §14.9).
//
// The risk: an indirect-rate paragraph or past-performance claim stays in the
// library after the agreement behind it expires, and a later draft cites it as
// current. Expiry has to be a property of the record, not a thing a human is
// expected to remember at 2am before a deadline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  eligibleForReuse,
  partitionForReuse,
  contentHash,
  type ReuseCandidate,
} from "../lib/proposal-memory";

const NOW = 1_800_000_000_000;

const approved = (over: Partial<ReuseCandidate> = {}): ReuseCandidate => ({
  key: "block",
  approvalStatus: "approved",
  effectiveFrom: null,
  expiresAt: null,
  confidentiality: "internal",
  restrictedFunders: [],
  doNotReuse: false,
  doNotReuseReason: null,
  supersededBy: null,
  ...over,
});

describe("approval gating", () => {
  it("allows an approved, unexpired block", () => {
    assert.equal(eligibleForReuse(approved(), { now: NOW }).eligible, true);
  });

  it("withholds anything not approved", () => {
    for (const s of ["unreviewed", "needs_review", "rejected"] as const) {
      const v = eligibleForReuse(approved({ approvalStatus: s }), { now: NOW });
      assert.equal(v.eligible, false, `${s} must not be reusable`);
    }
  });

  it("names rejection specifically", () => {
    const v = eligibleForReuse(approved({ approvalStatus: "rejected" }), { now: NOW });
    assert.match(v.eligible === false ? v.reason : "", /Rejected/);
  });
});

describe("time windows", () => {
  it("withholds an expired block", () => {
    const v = eligibleForReuse(approved({ expiresAt: NOW - 1 }), { now: NOW });
    assert.equal(v.eligible, false);
    assert.match(v.eligible === false ? v.reason : "", /Expired/);
  });

  it("allows a block expiring in the future", () => {
    assert.equal(eligibleForReuse(approved({ expiresAt: NOW + 1 }), { now: NOW }).eligible, true);
  });

  it("withholds a block that is not yet effective", () => {
    const v = eligibleForReuse(approved({ effectiveFrom: NOW + 1000 }), { now: NOW });
    assert.equal(v.eligible, false);
    assert.match(v.eligible === false ? v.reason : "", /Not yet effective/);
  });

  it("treats null dates as no constraint", () => {
    assert.equal(eligibleForReuse(approved({ expiresAt: null, effectiveFrom: null }), { now: NOW }).eligible, true);
  });
});

describe("DO_NOT_REUSE and supersession", () => {
  it("withholds a DO_NOT_REUSE block even when approved and current", () => {
    const v = eligibleForReuse(
      approved({ doNotReuse: true, doNotReuseReason: "Names a dead partner" }),
      { now: NOW },
    );
    assert.equal(v.eligible, false);
    assert.match(v.eligible === false ? v.reason : "", /DO_NOT_REUSE.*dead partner/);
  });

  it("DO_NOT_REUSE outranks every other reason", () => {
    // Worst consequence first: the human should see the most serious problem.
    const v = eligibleForReuse(
      approved({ doNotReuse: true, approvalStatus: "unreviewed", expiresAt: NOW - 1 }),
      { now: NOW },
    );
    assert.match(v.eligible === false ? v.reason : "", /DO_NOT_REUSE/);
  });

  it("withholds a superseded block and names its replacement", () => {
    const v = eligibleForReuse(approved({ supersededBy: "indirect-rates-v3" }), { now: NOW });
    assert.equal(v.eligible, false);
    assert.match(v.eligible === false ? v.reason : "", /Superseded by "indirect-rates-v3"/);
  });
});

describe("funder restrictions", () => {
  it("withholds a block restricted for the target funder", () => {
    const v = eligibleForReuse(approved({ restrictedFunders: ["Harbor County"] }), {
      now: NOW,
      funder: "Harbor County Board of Commissioners",
    });
    assert.equal(v.eligible, false);
    assert.match(v.eligible === false ? v.reason : "", /Restricted for this funder/);
  });

  it("matches regardless of case and punctuation", () => {
    const v = eligibleForReuse(approved({ restrictedFunders: ["HRSA"] }), { now: NOW, funder: "hrsa" });
    assert.equal(v.eligible, false);
  });

  it("allows the block for an unrelated funder", () => {
    const v = eligibleForReuse(approved({ restrictedFunders: ["Harbor County"] }), { now: NOW, funder: "HRSA" });
    assert.equal(v.eligible, true);
  });

  it("does not restrict when no funder is known", () => {
    assert.equal(eligibleForReuse(approved({ restrictedFunders: ["HRSA"] }), { now: NOW }).eligible, true);
  });
});

describe("confidentiality", () => {
  it("keeps confidential content out of an external document", () => {
    const v = eligibleForReuse(approved({ confidentiality: "confidential" }), { now: NOW, external: true });
    assert.equal(v.eligible, false);
    assert.match(v.eligible === false ? v.reason : "", /Confidential/);
  });

  it("permits confidential content internally", () => {
    assert.equal(
      eligibleForReuse(approved({ confidentiality: "confidential" }), { now: NOW, external: false }).eligible,
      true,
    );
  });

  it("permits internal and public content externally", () => {
    for (const c of ["internal", "public"] as const) {
      assert.equal(eligibleForReuse(approved({ confidentiality: c }), { now: NOW, external: true }).eligible, true);
    }
  });
});

describe("partitionForReuse", () => {
  it("separates usable from withheld and explains each withholding", () => {
    const blocks = [
      approved({ key: "good" }),
      approved({ key: "expired", expiresAt: NOW - 1 }),
      approved({ key: "dnr", doNotReuse: true }),
    ];
    const { usable, withheld } = partitionForReuse(blocks, { now: NOW });
    assert.deepEqual(usable.map((b) => b.key), ["good"]);
    assert.equal(withheld.length, 2);
    assert.ok(withheld.every((w) => w.reason.length > 0), "every withholding needs a reason");
  });
});

describe("contentHash", () => {
  it("ignores whitespace differences", () => {
    assert.equal(contentHash("a  b\n c"), contentHash("a b c"));
  });

  it("changes when the content changes", () => {
    assert.notEqual(contentHash("rate is 12%"), contentHash("rate is 14%"));
  });
});

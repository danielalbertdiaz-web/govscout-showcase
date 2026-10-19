import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readDraftRoster,
  upsertRosterEntry,
  removeFromRoster,
  setIncluded,
  setRole,
  includedPartnerIds,
  normalizeRosterInput,
  writeRosterToMeta,
  isPartnerRole,
} from "../lib/draft-partners";

test("readDraftRoster prefers a curated meta.partners[] and normalizes it", () => {
  const roster = readDraftRoster({
    partners: [
      { partnerId: "njcu", role: "prime", included: true },
      { partnerId: "riverside", role: "sub" }, // included defaults true
      { partnerId: "brightline", role: "referral", included: false },
      { partnerId: "", role: "sub" }, // dropped (no id)
      { role: "sub" }, // dropped (no id)
      "garbage", // dropped
      { partnerId: "njcu", role: "sub" }, // dup dropped (keeps first)
    ],
  });
  assert.deepEqual(roster, [
    { partnerId: "njcu", role: "prime", included: true },
    { partnerId: "riverside", role: "sub", included: true },
    { partnerId: "brightline", role: "referral", included: false },
  ]);
});

test("readDraftRoster migrates a legacy singleton partnerLead to one included prime", () => {
  const roster = readDraftRoster({
    partnerLead: { partnerId: "riverside", partnerName: "Riverside", decidedAt: 123 },
  });
  assert.deepEqual(roster, [{ partnerId: "riverside", role: "prime", included: true }]);
});

test("readDraftRoster migrates a legacy partnerSelection snapshot to included subs", () => {
  const roster = readDraftRoster({
    partnerSelection: { reason: "auto_match", ids: ["njcu", "riverside", "njcu"] },
  });
  assert.deepEqual(roster, [
    { partnerId: "njcu", role: "sub", included: true },
    { partnerId: "riverside", role: "sub", included: true },
  ]);
});

test("readDraftRoster prefers partners[] over legacy fields, and is total on junk", () => {
  // partners[] wins even when legacy fields are present.
  const roster = readDraftRoster({
    partners: [{ partnerId: "cfpc", role: "prime", included: true }],
    partnerLead: { partnerId: "riverside" },
    partnerSelection: { ids: ["njcu"] },
  });
  assert.deepEqual(roster, [{ partnerId: "cfpc", role: "prime", included: true }]);
  // Never throws on missing/garbage meta.
  assert.deepEqual(readDraftRoster(null), []);
  assert.deepEqual(readDraftRoster(undefined), []);
  assert.deepEqual(readDraftRoster({}), []);
});

test("upsertRosterEntry adds when absent and patches when present", () => {
  let roster = readDraftRoster({});
  roster = upsertRosterEntry(roster, { partnerId: "njcu", role: "prime" });
  assert.deepEqual(roster, [{ partnerId: "njcu", role: "prime", included: true }]);
  // patch role only, leave included
  roster = upsertRosterEntry(roster, { partnerId: "njcu", role: "sub" });
  assert.deepEqual(roster, [{ partnerId: "njcu", role: "sub", included: true }]);
  // add second
  roster = upsertRosterEntry(roster, { partnerId: "riverside" });
  assert.equal(roster.length, 2);
  assert.equal(roster[1].role, "sub"); // DEFAULT_ROLE
  // empty id is ignored
  assert.equal(upsertRosterEntry(roster, { partnerId: "  " }).length, 2);
});

test("include/exclude and role toggles are pure and targeted", () => {
  const base = [
    { partnerId: "a", role: "prime" as const, included: true },
    { partnerId: "b", role: "sub" as const, included: true },
  ];
  const excluded = setIncluded(base, "b", false);
  assert.equal(excluded[1].included, false);
  assert.equal(base[1].included, true); // original untouched (purity)
  assert.deepEqual(includedPartnerIds(excluded), ["a"]);

  const rerole = setRole(base, "b", "referral");
  assert.equal(rerole[1].role, "referral");
  assert.equal(base[1].role, "sub");
});

test("removeFromRoster drops only the named partner", () => {
  const base = readDraftRoster({
    partners: [
      { partnerId: "a", role: "prime", included: true },
      { partnerId: "b", role: "sub", included: true },
    ],
  });
  assert.deepEqual(removeFromRoster(base, "a"), [{ partnerId: "b", role: "sub", included: true }]);
});

test("normalizeRosterInput drops malformed rows and dedupes", () => {
  assert.deepEqual(normalizeRosterInput("nope"), []);
  assert.deepEqual(
    normalizeRosterInput([
      { partnerId: "a", role: "prime", included: false },
      { partnerId: "a", role: "sub" }, // dup dropped
      { partnerId: "b", role: "bogus-role" }, // role coerced to default
      { foo: 1 }, // dropped
    ]),
    [
      { partnerId: "a", role: "prime", included: false },
      { partnerId: "b", role: "sub", included: true },
    ],
  );
});

test("writeRosterToMeta preserves other keys and does not mutate input", () => {
  const meta = { autoDrafted: true, partnerLead: { partnerId: "old" } };
  const roster = [{ partnerId: "a", role: "prime" as const, included: true }];
  const next = writeRosterToMeta(meta, roster);
  assert.equal(next.autoDrafted, true);
  assert.deepEqual(next.partners, roster);
  // legacy field preserved for audit/back-compat
  assert.deepEqual(next.partnerLead, { partnerId: "old" });
  // input not mutated
  assert.equal("partners" in meta, false);
});

test("isPartnerRole guards the role union", () => {
  assert.equal(isPartnerRole("prime"), true);
  assert.equal(isPartnerRole("sub"), true);
  assert.equal(isPartnerRole("referral"), true);
  assert.equal(isPartnerRole("named"), true);
  assert.equal(isPartnerRole("lead"), false);
  assert.equal(isPartnerRole(7), false);
});

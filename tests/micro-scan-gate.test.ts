// The micro-scan discovery gate (admitSetAside). The old isEligibleSetAside
// made the conflation the data layer refused: `if (!setAside) return true`
// commented as "unrestricted" — absent data treated as a declaration of open
// eligibility — under a comment claiming the opposite of what the code did.
//
// The new gate reasons over the canonical vocabulary, stays PERMISSIVE on
// unknown (discovery breadth: an unclassifiable notice is collected for a
// human), is strict only on certification-required programs, and makes the
// admitted-because-open / admitted-because-unclassified distinction explicit.
//
// The packet's hardest constraint: NO notice collected under the old gate may
// stop being collected. The legacy gate is frozen below as an oracle and the
// parity sweep proves admitted-for-admitted agreement over live-shaped input.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { admitSetAside } from "../lib/micro-contracts-scan";

// The OLD gate, frozen verbatim as the parity oracle (do not "fix" this copy
// — its whole value is being exactly what shipped before).
const LEGACY_EXCLUDED = [
  "sdvosb",
  "service-disabled veteran",
  "wosb",
  "women-owned",
  "edwosb",
  "hubzone",
  "buy indian",
  "indian",
];
const LEGACY_ELIGIBLE = new Set([
  "total small business",
  "sba",
  "8(a)",
  "partial small business",
  "small business",
  "unrestricted",
  "",
]);
function legacyIsEligible(setAside: string | null): boolean {
  if (!setAside) return true;
  const lower = setAside.toLowerCase().trim();
  if (LEGACY_EXCLUDED.some((ex) => lower.includes(ex))) return false;
  if (LEGACY_ELIGIBLE.has(lower)) return true;
  return !LEGACY_EXCLUDED.some((ex) => lower.includes(ex));
}

// Live-shaped fixtures: every distinct live fp value, the micro NULL case,
// plus SAM phrasings the substring gate had opinions about.
const FIXTURES: Array<string | null> = [
  null,
  "",
  "Total Small Business Set-Aside",
  "Total Small Business",
  "SBA",
  "SBA Total Small Business",
  "None",
  "None (full & open)",
  "TBD — RFI states may be small-business set-aside or full & open",
  "Sources Sought (may set aside SB or full/open)",
  "RFI/Sources Sought (SB incl 8a invited)",
  "RFI/Sources Sought",
  "8(a) competitive",
  "8(a) Set-Aside",
  "Partial Small Business",
  "Unrestricted",
  "SDVOSB Sole Source",
  "Service-Disabled Veteran-Owned Small Business",
  "Women-Owned Small Business (WOSB)",
  "EDWOSB Set-Aside",
  "HUBZone Set-Aside",
  "BICiv Buy Indian Set-Aside",
  "Indian Small Business Economic Enterprise",
  "Sources Sought (may set aside WOSB)",
  "Category 7 Preferred Vendors",
];

describe("micro-scan set-aside gate", () => {
  it("PARITY: nothing collected under the legacy gate stops being collected (and vice versa)", () => {
    let admitted = 0;
    let legacyAdmitted = 0;
    for (const raw of FIXTURES) {
      const now = admitSetAside(raw).admitted;
      const before = legacyIsEligible(raw);
      if (now) admitted++;
      if (before) legacyAdmitted++;
      assert.equal(now, before, `admission changed for ${JSON.stringify(raw)}: legacy=${before} new=${now}`);
    }
    assert.equal(admitted, legacyAdmitted, "admitted count must not move");
  });

  it("explicitly excluded certification programs are still excluded", () => {
    for (const raw of [
      "SDVOSB Sole Source",
      "Service-Disabled Veteran-Owned Small Business",
      "Women-Owned Small Business (WOSB)",
      "EDWOSB Set-Aside",
      "HUBZone Set-Aside",
      "BICiv Buy Indian Set-Aside",
      "Indian Small Business Economic Enterprise",
    ]) {
      const verdict = admitSetAside(raw);
      assert.equal(verdict.admitted, false, raw);
      assert.equal(verdict.reason, "excluded", raw);
    }
  });

  it("NULL is still collected — but as 'unclassified', never as a declaration of openness", () => {
    for (const raw of [null, "", "   "]) {
      const verdict = admitSetAside(raw as string | null);
      assert.equal(verdict.admitted, true);
      assert.equal(verdict.reason, "unclassified", "absence is not 'open'");
      assert.equal(verdict.canonical, "unknown");
    }
  });

  it("a genuinely open notice is marked 'open'", () => {
    for (const raw of ["None", "None (full & open)", "Unrestricted"]) {
      const verdict = admitSetAside(raw);
      assert.equal(verdict.admitted, true, raw);
      assert.equal(verdict.reason, "open", raw);
      assert.equal(verdict.canonical, "none", raw);
    }
  });

  it("eligible programs are admitted as 'eligible' — including 8(a), deliberately", () => {
    // 8(a) has ALWAYS been admitted here (legacy listed it eligible), Acme's
    // 8(a) application is pending SBA review, and the Bid Board tracks an
    // "8(a) competitive" item. The packet listed 8a among the exclusions;
    // excluding it would violate the packet's own no-regression rule, so it
    // stays admitted — flagged in the report for a ruling.
    for (const raw of ["Total Small Business Set-Aside", "SBA", "8(a) competitive"]) {
      const verdict = admitSetAside(raw);
      assert.equal(verdict.admitted, true, raw);
      assert.equal(verdict.reason, "eligible", raw);
    }
  });

  it("speculative phrasing naming an excluded program is still excluded (the backstop)", () => {
    // Canonically "unknown" (speculation is not a set-aside), but the WOSB
    // mention means Acme cannot bid it — exactly what the legacy substring
    // exclusion caught, preserved via the backstop.
    const verdict = admitSetAside("Sources Sought (may set aside WOSB)");
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.reason, "excluded");
    assert.equal(verdict.canonical, "unknown");
  });

  it("unclassifiable strings are collected and marked as such", () => {
    const verdict = admitSetAside("Category 7 Preferred Vendors");
    assert.equal(verdict.admitted, true);
    assert.equal(verdict.reason, "unclassified");
  });
});

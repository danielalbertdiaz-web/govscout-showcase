// PRICING_CORRUPTION_2026-07-19 regression guard.
//
// Fixtures reproduce the actual sent artifacts (verified via the Gmail API):
// four federal quotations left contact@example.org on 2026-07-19 with every
// "$<digits>" token stripped — "$45,500" arrived as ",500" — because the
// quote bodies were interpolated into a double-quoted string executed by zsh,
// and zsh expands multi-digit positional parameters without braces
// ("$45,500" → ${45} + ",500", ${45} unset). bash would have left "5,500";
// the sent copies read ",500", which fingerprints zsh specifically.
//
// Two layers under test:
//   1. The detector (lib/pricing-integrity) recognises the corruption
//      signature in the artifact that actually leaves the system — the final
//      body text, not the pre-interpolation draft (the drafts were fine).
//   2. A live zsh reproduction pins the mechanism itself and proves the
//      class-eliminating fix: text passed via argv/stdin survives; text
//      interpolated into the command string does not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  findStrippedPriceArtifacts,
  pricingDocumentHasDollarFigure,
} from "../lib/pricing-integrity";

// What the agent composed (intact) — structure of the W912GB26QA008 quote.
const CLEAN_QUOTE = `PRICING:
Firm Fixed Price: $24,800
- Platform development and deployment: $14,000
- 3D engine integration and testing: $6,800
- User training and documentation: $2,000
- 90-day warranty support: $2,000

Blended rate reference: $135/hr`;

// What the contracting officer received (verified sent artifact shape).
const MANGLED_QUOTE = `PRICING:
Firm Fixed Price: ,800
- Platform development and deployment: ,000
- 3D engine integration and testing: ,800
- User training and documentation: ,000
- 90-day warranty support: ,000

Blended rate reference: /hr`;

describe("findStrippedPriceArtifacts — the sent-artifact detector", () => {
  it("flags the exact corruption signature that reached the agencies", () => {
    const hits = findStrippedPriceArtifacts(MANGLED_QUOTE);
    const kinds = new Set(hits.map((h) => h.kind));
    // Five orphaned comma-groups and one orphaned /hr in the fixture.
    assert.equal(
      hits.filter((h) => h.kind === "orphan_comma_group").length,
      5,
      `expected 5 orphan comma groups, got: ${JSON.stringify(hits, null, 2)}`,
    );
    assert.ok(kinds.has("orphan_rate_unit"), "stripped $135/hr must be flagged");
  });

  it("stays silent on the intact quote", () => {
    assert.deepEqual(findStrippedPriceArtifacts(CLEAN_QUOTE), []);
  });

  it("stays silent on healthy prose that uses commas and large figures", () => {
    const prose = `Congratulations on your $7.8M HUD lead-hazard award.
Total award: $7,750,000 (2026-04-01). We completed 12 projects, 500 units
audited, and, 90 days later, closed out. Rate: $135/hr. Fee: $1,500.`;
    assert.deepEqual(findStrippedPriceArtifacts(prose), []);
  });

  it("flags an empty pricing label left by a fully stripped figure", () => {
    const hits = findStrippedPriceArtifacts("Firm Fixed Price: ,500\n");
    assert.ok(hits.some((h) => h.kind === "empty_price_label"));
  });

  it("pricing documents must still contain at least one dollar figure", () => {
    assert.equal(pricingDocumentHasDollarFigure(CLEAN_QUOTE), true);
    assert.equal(pricingDocumentHasDollarFigure(MANGLED_QUOTE), false);
  });
});

// The mechanism, pinned executably. Skipped where zsh is absent (CI on
// linux images without zsh) — the detector tests above still run.
describe("zsh multi-digit positional expansion — mechanism + fix", () => {
  const zsh = "/bin/zsh";
  const haveZsh = existsSync(zsh);

  it("reproduces the corruption: double-quoted body through zsh -c", { skip: !haveZsh }, () => {
    // Body embedded in the command string, as the 2026-07-19 draft run did.
    const r = spawnSync(zsh, ["-c", `printf '%s' "Firm Fixed Price: $45,500"`], {
      encoding: "utf8",
    });
    assert.equal(r.stdout, "Firm Fixed Price: ,500");
    // And the detector catches what comes out the other side.
    assert.ok(findStrippedPriceArtifacts(r.stdout).length > 0);
  });

  it("bash would have left the trailing digits — the ',500' shape is zsh's", { skip: !existsSync("/bin/bash") }, () => {
    const r = spawnSync("/bin/bash", ["-c", `printf '%s' "Firm Fixed Price: $45,500"`], {
      encoding: "utf8",
    });
    // bash reads "$4" (unset) then literal "5,500" — a different, equally
    // broken artifact. Distinguishes the shells; documents the fingerprint.
    assert.equal(r.stdout, "Firm Fixed Price: 5,500");
  });

  it("the class fix: text passed as argv survives zsh untouched", { skip: !haveZsh }, () => {
    const body = "Firm Fixed Price: $45,500";
    // Positional parameters are exactly what argv sets — "$1" here is the
    // body itself, never re-expanded. This is why file/argv passing
    // eliminates the class instead of escaping around it.
    const r = spawnSync(zsh, ["-c", `printf '%s' "$1"`, "--", body], {
      encoding: "utf8",
    });
    assert.equal(r.stdout, body);
    assert.deepEqual(findStrippedPriceArtifacts(r.stdout), []);
  });

  it("the class fix: text passed via stdin survives zsh untouched", { skip: !haveZsh }, () => {
    const body = "Firm Fixed Price: $45,500\nBlended: $135/hr";
    const r = spawnSync(zsh, ["-c", "cat"], { input: body, encoding: "utf8" });
    assert.equal(r.stdout, body);
  });
});

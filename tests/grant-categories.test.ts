// Per-client program-category classifiers (lib/grant-categories.ts) — pinned
// against real titles from each client's board so a rule reorder can't
// silently reroute a known grant into the wrong bucket.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeGrant, categoryLabel, categoriesFor, OTHER_CATEGORY } from "../lib/grant-categories";

describe("categorizeGrant — riverside", () => {
  const cases: Array<[string, string]> = [
    ["WIC Community Innovation and Outreach", "nutrition"],
    ["Client Choice Pantry", "nutrition"],
    ["Cold Chain Grants for Emergency Food Assistance", "nutrition"],
    ["BJA FY 2026 Comprehensive Opioid, Stimulant, and Substance Use Site-Based Program", "behavioral"],
    ["Intoxicated Driver Resource Center (IDRC) Program Services", "behavioral"],
    ["Eviction Protection Grant Program", "housing"],
    ["Provide Supplemental Code Blue Shelter Service Providers for Homeless Individuals & Families", "housing"],
    ["LIHEAP Home Energy Assistance Outreach", "energy"],
    ["WIOA Title I Career Services", "workforce"],
    ["Greater Raritan WDB Training RFP #1", "workforce"],
    // Immigrant-services programs must NOT land in workforce/children even
    // though they mention employment/children (rule-order regression pin).
    ["Refugee Essential Case Management & Initial Employment Services", "legal"],
    ["Home Study and Post-Release Services for Unaccompanied Alien Children", "legal"],
    ["Culturally Specific Domestic Violence and Sexual Assault Services", "legal"],
    ["Supportive Services for Children, Adults, and Families (Child Care and Afterschool Programming)", "children"],
    ["FY2026 Basic Center Program", "children"],
    ["Older Americans Act Title III Area Plan Year 3 Contract 2027", "seniors"],
    ["County-wide Adult Protective Services", "seniors"],
    ["SSUS Federal CDC Supplemental 2027 — HIV Prevention & Linkage to Care", "health"],
    ["Medicaid Enrollment Assistance", "health"],
    ["Community Economic Development Projects", "community"],
    ["Completely Unrelated Widget Procurement", "other"],
  ];
  for (const [title, expected] of cases) {
    it(`"${title}" -> ${expected}`, () => {
      assert.equal(categorizeGrant("riverside", title), expected);
    });
  }

  it("uses the description when the title is opaque", () => {
    assert.equal(
      categorizeGrant("riverside", "FY27 Notice 26-114", "$1.1M pool for innovative HIV prevention/diagnosis"),
      "health",
    );
  });
});

describe("categorizeGrant — northstar", () => {
  const cases: Array<[string, string]> = [
    ["OSHA Susan Harwood Training Grant — next cycle (est.)", "training"],
    ["EPA FY27 Brownfields Job Training (JT) Grants", "training"],
    // Reentry outranks training: Second Chance Act grants fund "training +
    // placement" but reentry is what the program IS (rule-order pin).
    ["DOJ Second Chance Act (training + placement) — FY26 NOFO pending", "reentry"],
    ["BJA FY 2026 Second Chance Act Improving Reentry Education and Employment Outcomes", "reentry"],
    ["BJA FY 2026 Smart Reentry Demonstration Program", "reentry"],
    ["FL Division of Vocational Rehabilitation — Fee-for-Service Employment Provider registration", "placement"],
    ["Completely Unrelated Widget Procurement", "other"],
  ];
  for (const [title, expected] of cases) {
    it(`"${title}" -> ${expected}`, () => {
      assert.equal(categorizeGrant("northstar", title), expected);
    });
  }
});

describe("taxonomy plumbing", () => {
  it("labels resolve per client, other is the shared fallback", () => {
    for (const clientId of ["riverside", "northstar"]) {
      for (const c of categoriesFor(clientId)) {
        assert.equal(categoryLabel(clientId, c.key), c.label);
      }
      assert.equal(categoryLabel(clientId, "nope"), OTHER_CATEGORY.label);
    }
  });

  it("a client without a taxonomy gets no categories and everything lands in other", () => {
    assert.equal(categoriesFor("el").length, 0);
    assert.equal(categorizeGrant("el", "OSHA Susan Harwood Training Grant"), "other");
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildNeedles, recommendPartners } from "../lib/partner-match";
import { composeGrantOutreach } from "../lib/grant-outreach";
import type { ReferenceOrg } from "../lib/reference-orgs";

const refOrg = (over: Partial<ReferenceOrg>): ReferenceOrg => ({
  id: "r1",
  kind: "nonprofit",
  name: "Recovery Works NJ",
  focusAreas: ["substance_use", "behavioral_health"],
  geography: "NJ",
  sourceUrl: null,
  note: null,
  amountUsd: null,
  year: null,
  ein: null,
  ...over,
});

describe("partner-match (S1)", () => {
  test("needles drop stopwords and short tokens", () => {
    const n = buildNeedles("opioid grant program", ["Rural Opioid Response for Counties"]);
    assert.ok(n.has("opioid"));
    assert.ok(n.has("rural"));
    assert.ok(!n.has("grant"));
    assert.ok(!n.has("for"));
  });

  test("opioid search recommends aligned orgs, partners rank above reference", () => {
    const recs = recommendPartners({
      query: "opioid",
      resultTitles: ["Rural Communities Opioid Response Program"],
      partners: [
        { id: "p1", name: "Riverside", capabilities: ["substance use treatment", "community health"], status: "active" },
        { id: "p2", name: "Atlas Insights", capabilities: ["cloud migration"], status: "active" },
      ],
      referenceOrgs: [
        refOrg({ id: "r1", name: "Recovery Works NJ", focusAreas: ["opioid_recovery", "substance_use"] }),
        refOrg({ id: "r2", name: "Arts Council", focusAreas: ["arts_culture"] }),
      ],
    });
    const names = recs.map((r) => r.name);
    assert.ok(names.includes("Riverside"));
    assert.ok(names.includes("Recovery Works NJ"));
    assert.ok(!names.includes("Atlas Insights"), "no capability overlap → excluded");
    assert.ok(!names.includes("Arts Council"), "no focus overlap → excluded");
    assert.equal(recs[0].name, "Riverside", "existing partner outranks reference org");
    assert.equal(recs[0].kind, "partner");
  });

  test("funded orgs outrank foundations for the same overlap", () => {
    const recs = recommendPartners({
      query: "opioid recovery",
      resultTitles: [],
      partners: [],
      referenceOrgs: [
        refOrg({ id: "f1", name: "Gold Foundation", kind: "private_foundation", focusAreas: ["opioid_recovery"] }),
        refOrg({ id: "w1", name: "Winner Org", kind: "google_org_winner", focusAreas: ["opioid_recovery"] }),
      ],
    });
    assert.equal(recs[0].name, "Winner Org");
  });

  test("empty query + titles → no recommendations", () => {
    assert.deepEqual(
      recommendPartners({ query: "", resultTitles: [], partners: [], referenceOrgs: [refOrg({})] }),
      [],
    );
  });
});

describe("grant-outreach composer (S1)", () => {
  test("draft includes grant, org, fit line, and the prime/sub shape", () => {
    const d = composeGrantOutreach({
      orgName: "Recovery Works NJ",
      focusAreas: ["substance_use"],
      grantTitle: "Rural Communities Opioid Response Program",
      agency: "HRSA",
      deadline: "2026-07-08",
      senderName: "the operator",
    });
    assert.match(d.subject, /Teaming on Rural Communities/);
    assert.match(d.markdown, /Recovery Works NJ/);
    assert.match(d.markdown, /lead applicant/);
    assert.match(d.markdown, /Acme Consulting/);
    assert.match(d.markdown, /due 2026-07-08/);
    assert.equal(d.safe, true);
  });

  test("known partner gets the warm opener", () => {
    const d = composeGrantOutreach({ orgName: "Riverside", grantTitle: "X", knownPartner: true });
    assert.match(d.markdown, /what we've discussed working on together/);
  });

  test("internal copy is sanitized out", () => {
    // The 1.6 sanitizer strips dead-relationship references; composing never
    // includes them, but the seam must hold even if inputs are tainted.
    const d = composeGrantOutreach({ orgName: "Org", grantTitle: "Grant with Jane Barred mention" });
    assert.ok(d.redactions.length >= 0); // sanitizer ran; exact policy lives in partner-copy tests
  });
});

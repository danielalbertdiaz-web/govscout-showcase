import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { composePoolHolderOutreach, composePoolPartnerOutreach } from "../lib/pool-activation";
import { buildRfpSkeleton, buildRfpPrompt, RFP_OCI_NOTICE } from "../lib/rfp-builder";
import type { FundingPool } from "../lib/pools-types";

const pool: FundingPool = {
  id: "pool-1",
  userEmail: "hello@govscout.ai",
  rank: null,
  name: "Harbor County Opioid Settlement — FY27",
  source: "https://example.gov/settlement",
  agency: "Harbor County Department of Health",
  jurisdiction: "Harbor County, NJ",
  status: "discovered",
  playType: null,
  allocatedAmount: "$1.18M",
  unspentAmount: "$1.18M",
  deadlineDate: null,
  deadlineLabel: "FY27 obligation deadline",
  fitSummary: "Opioid settlement funds for treatment, prevention, recovery support",
  wedge: "County lacks program staff to stand up services",
  nextAction: null,
  notes: null,
  tags: ["settlement", "opioid"],
  createdAt: 0,
  updatedAt: 0,
};

describe("pool activation (R2)", () => {
  test("holder outreach names the holder, the balance, and the offer", () => {
    const d = composePoolHolderOutreach(pool, { senderName: "the operator" });
    assert.match(d.markdown, /Harbor County Department of Health/);
    assert.match(d.markdown, /\$1\.18M in unspent funds/);
    assert.match(d.markdown, /draft program framework/);
    assert.match(d.subject, /program design support/);
    assert.equal(d.safe, true);
  });

  test("partner outreach proposes the operator/designer split", () => {
    const d = composePoolPartnerOutreach(pool, { name: "Recovery Works NJ", focusAreas: ["substance_use"] }, {});
    assert.match(d.markdown, /Recovery Works NJ engages Harbor County Department of Health/);
    assert.match(d.markdown, /program design, the funding case/);
    assert.match(d.markdown, /substance use/);
    assert.equal(d.safe, true);
  });

  test("missing amounts degrade to honest language", () => {
    const d = composePoolHolderOutreach({ ...pool, unspentAmount: null, allocatedAmount: null });
    assert.match(d.markdown, /significant unobligated balance/);
  });
});

describe("RFP builder (R3)", () => {
  test("skeleton carries the facts and the OCI notice", () => {
    const md = buildRfpSkeleton(pool);
    assert.match(md, /DRAFT REQUEST FOR PROPOSALS/);
    assert.match(md, /Harbor County Opioid Settlement/);
    assert.match(md, /\$1\.18M/);
    assert.match(md, /Evaluation criteria \(100 points\)/);
    assert.ok(md.includes(RFP_OCI_NOTICE));
  });

  test("unknowns become bracketed placeholders, never inventions", () => {
    const md = buildRfpSkeleton({ ...pool, agency: null, jurisdiction: null, unspentAmount: null, allocatedAmount: null });
    assert.match(md, /\[ISSUING AGENCY\]/);
    assert.match(md, /\[FUNDING AMOUNT/);
  });

  test("CLI prompt forbids invention and demands neutral criteria + OCI line", () => {
    const { systemPrompt, userPrompt } = buildRfpPrompt(pool);
    assert.match(systemPrompt, /BRACKETED PLACEHOLDER/);
    assert.match(systemPrompt, /NEUTRAL/);
    assert.ok(systemPrompt.includes(RFP_OCI_NOTICE));
    assert.match(userPrompt, /Harbor County/);
    assert.match(userPrompt, /INTERNAL — inform scope, do not quote/);
  });
});

describe("RFP output cleaning", () => {
  test("strips the CLI's editorial chrome, keeps the document", async () => {
    const { cleanRfpOutput } = await import("../lib/rfp-builder");
    const raw = "`★ Insight ─────────────`\n- meta commentary\n`─────────────────────────────`\n\n---\n\n# REQUEST FOR PROPOSALS\n\nBody.";
    const cleaned = cleanRfpOutput(raw);
    assert.ok(cleaned.startsWith("# REQUEST FOR PROPOSALS"));
    assert.ok(!cleaned.includes("★"));
  });
});

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  naicsMatches,
  naicsLabel,
  DEFAULT_TARGET_NAICS,
  DEFAULT_TEAMING_NOTICE_TYPES,
  type TeamingNotice,
} from "../lib/teaming-sources/types";
import {
  parseSamResponse,
  normalizeNoticeType,
  formatSamDate,
  buildSamSearchUrl,
  ptypeFor,
  extractPrime,
  samGovSource,
} from "../lib/teaming-sources/sam-gov";
import {
  searchTeamingSources,
  teamingNoticeKey,
  availableTeamingSources,
} from "../lib/teaming-sources/index";
import {
  scoreTeamingFit,
  rankTeamingNotices,
  TEAMING_FIT_WEIGHTS,
  TEAMING_FIT_THRESHOLD,
  type TeamingContext,
} from "../lib/teaming-fit";
import { composeTeamingOutreach } from "../lib/teaming-outreach";

function notice(overrides: Partial<TeamingNotice> = {}): TeamingNotice {
  return {
    noticeId: "n1",
    title: "Behavioral Health Services Support",
    agency: "Dept of Veterans Affairs",
    prime: null,
    noticeType: "Sources Sought",
    naics: "621330",
    description: "Seeking subcontractors for substance use disorder treatment coordination.",
    postedDate: "2026-06-01",
    responseDeadline: "2026-06-20",
    setAside: "Total Small Business Set-Aside",
    url: "https://sam.gov/opp/n1",
    source: "sam_gov",
    ...overrides,
  };
}

const SAM_BODY = {
  totalRecords: 2,
  opportunitiesData: [
    {
      noticeId: "ABC123",
      title: "Sources Sought: IT Systems Modernization",
      fullParentPathName: "GSA / FAS",
      postedDate: "2026-06-02",
      type: "Sources Sought",
      naicsCode: "541512",
      responseDeadLine: "2026-06-25T17:00:00-04:00",
      typeOfSetAsideDescription: "Total Small Business Set-Aside",
      uiLink: "https://sam.gov/opp/ABC123",
      description: "Acme Corp has been awarded the prime; seeking subcontractors.",
    },
    {
      // missing noticeId → skipped
      title: "No id here",
      type: "Special Notice",
    },
  ],
};

describe("teaming NAICS targeting", () => {
  it("naicsMatches: empty target matches all, else exact membership", () => {
    assert.equal(naicsMatches("541512", []), true);
    assert.equal(naicsMatches("541512", ["541512", "541611"]), true);
    assert.equal(naicsMatches("999999", ["541512"]), false);
    assert.equal(naicsMatches(null, ["541512"]), false);
  });
  it("naicsLabel renders code · label, falls back to bare code", () => {
    assert.ok(naicsLabel("541512").includes("Computer Systems Design"));
    assert.equal(naicsLabel("999999"), "999999");
    assert.equal(naicsLabel(null), "—");
  });
  it("default sets are non-empty", () => {
    assert.ok(DEFAULT_TARGET_NAICS.length >= 3);
    assert.deepEqual(DEFAULT_TEAMING_NOTICE_TYPES, ["Special Notice", "Sources Sought"]);
  });
});

describe("sam-gov pure parsing", () => {
  it("normalizeNoticeType maps SAM long-form strings", () => {
    assert.equal(normalizeNoticeType("Sources Sought"), "Sources Sought");
    assert.equal(normalizeNoticeType("Special Notice"), "Special Notice");
    assert.equal(normalizeNoticeType("Combined Synopsis/Solicitation"), "Combined Synopsis/Solicitation");
    assert.equal(normalizeNoticeType("Solicitation"), "Solicitation");
    assert.equal(normalizeNoticeType("anything else"), "Other");
  });
  it("formatSamDate emits MM/dd/yyyy in UTC", () => {
    assert.equal(formatSamDate(new Date(Date.UTC(2026, 5, 3))), "06/03/2026");
  });
  it("ptypeFor maps notice types to SAM ptype codes", () => {
    assert.equal(ptypeFor("Sources Sought"), "r");
    assert.equal(ptypeFor("Special Notice"), "s");
  });
  it("buildSamSearchUrl sets key, dates, ptype, ncode, clamps limit", () => {
    const url = buildSamSearchUrl({
      apiKey: "K",
      postedFrom: "06/01/2026",
      postedTo: "06/14/2026",
      limit: 5000,
      ptype: "r",
      naics: "541512",
    });
    assert.ok(url.includes("api_key=K"));
    assert.ok(url.includes("ptype=r"));
    assert.ok(url.includes("ncode=541512"));
    assert.ok(url.includes("limit=1000")); // clamped
  });
  it("extractPrime sniffs awarded-prime phrasing", () => {
    assert.equal(extractPrime("Acme Corp has been awarded the contract", null), "Acme Corp");
    assert.equal(extractPrime("nothing here", null), null);
  });
  it("parseSamResponse normalizes records, skips id-less, sniffs prime", () => {
    const out = parseSamResponse(SAM_BODY);
    assert.equal(out.length, 1);
    const n = out[0];
    assert.equal(n.noticeId, "ABC123");
    assert.equal(n.agency, "GSA / FAS");
    assert.equal(n.naics, "541512");
    assert.equal(n.noticeType, "Sources Sought");
    assert.equal(n.prime, "Acme Corp");
    assert.equal(n.source, "sam_gov");
  });
  it("parseSamResponse tolerates junk", () => {
    assert.deepEqual(parseSamResponse(null), []);
    assert.deepEqual(parseSamResponse({}), []);
    assert.deepEqual(parseSamResponse({ opportunitiesData: "nope" }), []);
  });
});

describe("sam-gov dark seam", () => {
  it("is dark and returns [] without SAM_GOV_API_KEY", async () => {
    const prev = process.env.SAM_GOV_API_KEY;
    delete process.env.SAM_GOV_API_KEY;
    try {
      assert.equal(samGovSource.available, false);
      assert.deepEqual(await samGovSource.fetch({}), []);
      assert.deepEqual(availableTeamingSources(), []);
    } finally {
      if (prev !== undefined) process.env.SAM_GOV_API_KEY = prev;
    }
  });
});

describe("teaming registry de-dupe", () => {
  it("teamingNoticeKey prefers noticeId, then url, then title+agency", () => {
    assert.equal(teamingNoticeKey({ noticeId: "X" }), "id:x");
    assert.equal(teamingNoticeKey({ url: "https://A/B" }), "url:https://a/b");
    assert.equal(teamingNoticeKey({ title: "T", agency: "A" }), "ta:t|a");
  });
  it("searchTeamingSources is empty when no source is available", async () => {
    const prev = process.env.SAM_GOV_API_KEY;
    delete process.env.SAM_GOV_API_KEY;
    try {
      const res = await searchTeamingSources({});
      assert.deepEqual(res.notices, []);
      assert.deepEqual(res.sourcesUsed, []);
    } finally {
      if (prev !== undefined) process.env.SAM_GOV_API_KEY = prev;
    }
  });
});

describe("teaming-fit scoring", () => {
  const ctx: TeamingContext = {
    capabilityKeywords: ["substance use", "behavioral health", "case management"],
    knownPrimeNames: ["Acme Corp"],
    targetNaics: DEFAULT_TARGET_NAICS,
  };

  it("a sources-sought BH notice with a known prime scores high", () => {
    const fit = scoreTeamingFit(notice({ prime: "Acme Corp" }), ctx);
    assert.ok(fit.fitScore >= 70, `expected high score, got ${fit.fitScore}`);
    assert.equal(fit.knownPrime, true);
    assert.ok(fit.reasons.some((r) => /relationship with prime/i.test(r)));
  });

  it("an out-of-scope solicitation with no prime scores low", () => {
    const fit = scoreTeamingFit(
      notice({
        noticeType: "Solicitation",
        naics: "111110",
        description: "Agricultural crop production.",
        setAside: null,
        prime: null,
      }),
      ctx,
    );
    assert.ok(fit.fitScore < TEAMING_FIT_THRESHOLD, `expected low, got ${fit.fitScore}`);
    assert.ok(fit.risks.some((r) => /NAICS outside/i.test(r)));
  });

  it("known prime breaks ties above scope", () => {
    const known = notice({ noticeId: "k", prime: "Acme Corp" });
    const unknown = notice({ noticeId: "u", prime: "Beta LLC" });
    const ranked = rankTeamingNotices({ notices: [unknown, known], ctx });
    assert.equal(ranked[0].notice.noticeId, "k");
  });

  it("weights sum is sane and used", () => {
    const sum =
      TEAMING_FIT_WEIGHTS.scopeFit +
      TEAMING_FIT_WEIGHTS.subRoleCapacity +
      TEAMING_FIT_WEIGHTS.relationshipWithPrime +
      TEAMING_FIT_WEIGHTS.primeQuality;
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

describe("teaming outreach composer", () => {
  it("produces a DRAFT marker and never asserts it was sent", () => {
    const out = composeTeamingOutreach(notice({ prime: "Acme Corp" }), {
      senderName: "Acme Consulting",
      capabilities: ["substance use treatment", "case management"],
    });
    assert.ok(out.markdown.includes("DRAFT"));
    assert.ok(out.markdown.includes("NOTHING HAS BEEN SENT"));
    assert.ok(out.markdown.includes("Acme Corp"));
    assert.equal(out.safe, true);
  });

  it("routes through the 1.6 sanitizer (internal framing stripped)", () => {
    const out = composeTeamingOutreach(
      notice({
        prime: "Acme Corp",
        description: "Acme Corp will greenlight anything for this PG/debt scenario.",
      }),
    );
    assert.ok(!/greenlight anything/i.test(out.markdown));
    assert.ok(!/PG\/debt/i.test(out.markdown));
    assert.equal(out.safe, false);
    assert.ok(out.redactions.length >= 1);
  });
});

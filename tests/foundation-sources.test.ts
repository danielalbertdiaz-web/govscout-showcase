import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  parsePndRss,
  stripHtml,
  splitFunderFromTitle,
  extractDeadline,
} from "../lib/foundation-sources/pnd-rss";
import { foundationPagesFor, FOUNDATION_PAGES } from "../lib/foundation-sources/foundation-pages";
import { candidFoundationSource } from "../lib/foundation-sources/candid";
import {
  availableFoundationSources,
  foundationGrantKey,
  grantMatchesKeywords,
  FOUNDATION_FOCUS_KEYWORDS,
} from "../lib/foundation-sources/index";
import {
  looksLikeGrantmaker,
  parseFunderSearch,
  parseFunderAssets,
  funderStubToGrant,
  funderQueryPhrases,
  proPublicaFunderSearchUrl,
  propublicaFoundationSource,
  FOUNDATION_PAYOUT_RATE,
} from "../lib/foundation-sources/propublica";

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Acme Foundation Invites Applications for Opioid Recovery Programs]]></title>
    <link>https://philanthropynewsdigest.org/rfps/acme-opioid</link>
    <description><![CDATA[<p>The program supports substance use disorder treatment. Deadline is June 30, 2026.</p>]]></description>
    <category>Substance Abuse</category>
    <category>Health</category>
  </item>
  <item>
    <title>Widget Trust Seeks Proposals for Arts Education</title>
    <link>https://philanthropynewsdigest.org/rfps/widget-arts</link>
    <description>Supports K-12 arts programming nationwide.</description>
    <category>Arts</category>
  </item>
</channel></rss>`;

describe("pnd-rss pure parsing", () => {
  it("stripHtml removes tags and decodes entities", () => {
    assert.equal(stripHtml("<p>Hello&amp;&nbsp;world</p>"), "Hello& world");
  });

  it("splitFunderFromTitle pulls the funder before the verb", () => {
    assert.deepEqual(splitFunderFromTitle("Acme Foundation Invites Applications for X"), {
      funder: "Acme Foundation",
      title: "Acme Foundation Invites Applications for X",
    });
    assert.equal(splitFunderFromTitle("Standalone headline").funder, null);
  });

  it("extractDeadline finds a month-day-year phrase after a deadline cue", () => {
    assert.equal(extractDeadline("Deadline is June 30, 2026 for all applicants."), "June 30, 2026");
    assert.equal(extractDeadline("No date here."), null);
    assert.equal(extractDeadline(null), null);
  });

  it("parses items, splits funder, captures categories + deadline", () => {
    const grants = parsePndRss(SAMPLE_RSS);
    assert.equal(grants.length, 2);
    const acme = grants[0];
    assert.equal(acme.funder, "Acme Foundation");
    assert.equal(acme.url, "https://philanthropynewsdigest.org/rfps/acme-opioid");
    assert.deepEqual(acme.focusAreas, ["Substance Abuse", "Health"]);
    assert.equal(acme.deadlineText, "June 30, 2026");
    assert.equal(acme.source, "pnd_rss");
  });

  it("returns [] for empty / non-string input", () => {
    assert.deepEqual(parsePndRss(""), []);
    assert.deepEqual(parsePndRss(null), []);
    assert.deepEqual(parsePndRss(123), []);
  });
});

describe("grantMatchesKeywords", () => {
  const g = { title: "Opioid Recovery", summary: null, focusAreas: ["substance use"] };
  it("matches on any focus keyword", () => {
    assert.equal(grantMatchesKeywords(g, ["recovery"]), true);
    assert.equal(grantMatchesKeywords(g, ["substance use"]), true);
  });
  it("empty keyword list matches everything", () => {
    assert.equal(grantMatchesKeywords(g, []), true);
  });
  it("non-matching keywords return false", () => {
    assert.equal(grantMatchesKeywords({ title: "Arts", summary: null, focusAreas: ["music"] }, ["opioid"]), false);
  });
});

describe("foundation-pages registry", () => {
  it("every page carries the profile fields the brief requires", () => {
    for (const p of FOUNDATION_PAGES) {
      assert.ok(p.funder && p.title);
      assert.ok(Array.isArray(p.focusAreas) && p.focusAreas.length > 0);
      assert.ok(p.geography, `${p.funder} missing geography`);
      assert.ok(p.applicationCycle, `${p.funder} missing cycle`);
      assert.ok(p.decisionTimeline, `${p.funder} missing decision timeline`);
    }
  });

  it("filters to the focus keywords", () => {
    const out = foundationPagesFor({ keywords: ["opioid"] });
    assert.ok(out.length >= 1);
    assert.ok(out.every((g) => g.source === "foundation_pages"));
    // Bloomberg has 'opioid' in its focus areas.
    assert.ok(out.some((g) => g.funder.includes("Bloomberg")));
  });

  it("default focus keywords surface the SUD/BH funders", () => {
    const out = foundationPagesFor({ keywords: [...FOUNDATION_FOCUS_KEYWORDS] });
    assert.ok(out.length >= 3);
  });
});

describe("foundation source registry", () => {
  it("candid is dark without a key", async () => {
    const prev = process.env.CANDID_API_KEY;
    delete process.env.CANDID_API_KEY;
    try {
      assert.equal(candidFoundationSource.available, false);
      assert.deepEqual(await candidFoundationSource.fetch({}), []);
    } finally {
      if (prev !== undefined) process.env.CANDID_API_KEY = prev;
    }
  });

  it("pnd_rss + foundation_pages are always available (>= 2 free sources)", () => {
    const ids = availableFoundationSources().map((s) => s.id);
    assert.ok(ids.includes("pnd_rss"));
    assert.ok(ids.includes("foundation_pages"));
  });

  it("foundationGrantKey prefers url, falls back to funder+title", () => {
    assert.equal(
      foundationGrantKey({
        funder: "A",
        title: "B",
        url: "https://X/Y",
        summary: null,
        deadlineText: null,
        focusAreas: [],
        geography: null,
        fundingMin: null,
        fundingMax: null,
        applicationCycle: null,
        decisionTimeline: null,
        source: "s",
      }),
      "url:https://x/y",
    );
    assert.equal(
      foundationGrantKey({
        funder: "Acme",
        title: "Prog",
        url: null,
        summary: null,
        deadlineText: null,
        focusAreas: [],
        geography: null,
        fundingMin: null,
        fundingMax: null,
        applicationCycle: null,
        decisionTimeline: null,
        source: "s",
      }),
      "ft:acme|prog",
    );
  });
});

describe("Brave Search foundation source (N7)", () => {
  it("parseBraveResults maps results, drops aggregators + junk", async () => {
    const { parseBraveResults } = await import("../lib/foundation-sources/brave");
    const grants = parseBraveResults(
      {
        web: {
          results: [
            {
              title: "Grant Programs | New Jersey Health Foundation",
              url: "https://www.njhealthfoundation.org/research-grant-program",
              description: "Behavioral health research grants in New Jersey.",
              profile: { name: "New Jersey Health Foundation" },
            },
            { title: "25+ Grants", url: "https://www.instrumentl.com/browse-grants" }, // aggregator
            { title: "", url: "https://x.org" }, // no title
          ],
        },
      },
      "test query",
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0].funder, "New Jersey Health Foundation");
    assert.equal(grants[0].source, "brave_search");
    assert.match(grants[0].summary ?? "", /Behavioral health/);
  });

  it("funderFromUrl + isAggregator helpers", async () => {
    const { funderFromUrl, isAggregator } = await import("../lib/foundation-sources/brave");
    assert.equal(funderFromUrl("https://www.njhealthfoundation.org/x"), "njhealthfoundation.org");
    assert.equal(funderFromUrl("notaurl"), "web");
    assert.equal(isAggregator("https://newjersey.grantwatch.com/cat/23"), true);
    assert.equal(isAggregator("https://www.rwjf.org/grants"), false);
  });

  it("is dark without a key", async () => {
    const { braveFoundationSource } = await import("../lib/foundation-sources/brave");
    const prev = process.env.BRAVE_SEARCH_API_KEY;
    try {
      delete process.env.BRAVE_SEARCH_API_KEY;
      assert.equal(braveFoundationSource.available, false);
      assert.deepEqual(await braveFoundationSource.fetch({}), []);
    } finally {
      if (prev !== undefined) process.env.BRAVE_SEARCH_API_KEY = prev;
    }
  });
});

describe("ProPublica foundation source (PP-1)", () => {
  it("looksLikeGrantmaker keeps foundations/trusts/T-codes, drops service providers", () => {
    assert.equal(looksLikeGrantmaker("Smith Family Foundation", null), true);
    assert.equal(looksLikeGrantmaker("Acme Charitable Trust", null), true);
    assert.equal(looksLikeGrantmaker("Recovery Centers of NJ", "F22"), false); // service provider
    assert.equal(looksLikeGrantmaker("Generic Org", "T20"), true); // grantmaking NTEE
  });

  it("funderQueryPhrases returns short de-duped phrases (theme + keywords)", () => {
    const phrases = funderQueryPhrases(["substance_use", "behavioral_health"], ["naloxone"]);
    assert.ok(phrases.includes("naloxone"));
    assert.ok(phrases.includes("addiction"));
    assert.ok(phrases.includes("behavioral health"));
    // de-duped + lowercased
    assert.equal(phrases.length, new Set(phrases).size);
  });

  it("proPublicaFunderSearchUrl carries q + state filter", () => {
    const url = proPublicaFunderSearchUrl("nj", "recovery");
    assert.match(url, /search\.json\?/);
    assert.match(url, /state%5Bid%5D=NJ/);
    assert.match(url, /q=recovery/);
  });

  it("parseFunderSearch normalizes + filters to grantmakers only", () => {
    const stubs = parseFunderSearch({
      organizations: [
        { ein: 223344556, name: "Garden State Health Foundation", state: "NJ", city: "Centerville", ntee_code: "T20" },
        { ein: 990011223, name: "Sunrise Recovery Services", state: "FL", ntee_code: "F22" }, // dropped
        { name: "" }, // dropped (no name)
      ],
    });
    assert.equal(stubs.length, 1);
    assert.equal(stubs[0].ein, "223344556");
    assert.equal(stubs[0].name, "Garden State Health Foundation");
  });

  it("parseFunderAssets reads latest usable assets, tolerant of junk", () => {
    assert.equal(
      parseFunderAssets({ filings_with_data: [{ totassetsend: 40_000_000 }, { totassetsend: 10 }] }),
      40_000_000,
    );
    assert.equal(parseFunderAssets({ filings_with_data: [] }), null);
    assert.equal(parseFunderAssets(null), null);
  });

  it("funderStubToGrant builds a funder-prospect profile with est. giving", () => {
    const g = funderStubToGrant(
      { ein: "223344556", name: "Garden State Health Foundation", city: "Centerville", state: "NJ", nteeCode: "T20" },
      40_000_000,
    );
    assert.equal(g.funder, "Garden State Health Foundation");
    assert.equal(g.source, "propublica");
    assert.equal(g.deadlineText, null);
    assert.equal(g.geography, "New Jersey");
    // est. giving = 5% of $40M = $2.0M
    assert.equal(g.fundingMax, "$2.0M");
    assert.match(g.summary ?? "", /est\. annual giving ~\$2\.0M/);
    assert.match(g.applicationCycle ?? "", /invitation|direct inquiry/i);
    assert.ok(Math.abs(FOUNDATION_PAYOUT_RATE - 0.05) < 1e-9);
  });

  it("is registered + available (free, no key)", () => {
    assert.equal(propublicaFoundationSource.available, true);
    assert.ok(availableFoundationSources().map((s) => s.id).includes("propublica"));
  });
});

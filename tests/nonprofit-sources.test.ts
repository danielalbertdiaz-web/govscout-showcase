import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildProPublicaQueryText,
  proPublicaSearchUrl,
  proPublicaOrgUrl,
  proPublicaPublicUrl,
  parseProPublicaSearch,
  parseProPublicaRevenue,
} from "../lib/nonprofit-sources/propublica";
import { candidSource } from "../lib/nonprofit-sources/candid";
import { availableNonprofitSources, searchNonprofitSources } from "../lib/nonprofit-sources/index";

describe("propublica pure query builders", () => {
  it("joins theme terms and extra text, skipping empties", () => {
    const q = buildProPublicaQueryText(["substance_use", "reentry"], "Camden");
    assert.ok(q.includes("Camden"));
    assert.ok(q.includes("substance use disorder"));
    assert.ok(q.includes("reentry"));
  });

  it("returns empty string for no themes and no text", () => {
    assert.equal(buildProPublicaQueryText([]), "");
  });

  it("builds a search url with q and a single uppercased state[id]", () => {
    const url = proPublicaSearchUrl({ themes: ["youth"], states: ["nj"] });
    assert.ok(url.startsWith("https://projects.propublica.org/nonprofits/api/v2/search.json?"));
    assert.ok(url.includes("state%5Bid%5D=NJ"));
    assert.ok(url.includes("q="));
  });

  it("adds page param only when page > 0", () => {
    const p0 = proPublicaSearchUrl({ themes: ["youth"] }, 0);
    const p2 = proPublicaSearchUrl({ themes: ["youth"] }, 2);
    assert.equal(p0.includes("page="), false);
    assert.ok(p2.includes("page=2"));
  });

  it("strips non-digits from EIN in org and public urls", () => {
    assert.equal(
      proPublicaOrgUrl("22-1234567"),
      "https://projects.propublica.org/nonprofits/api/v2/organizations/221234567.json",
    );
    assert.equal(
      proPublicaPublicUrl("22-1234567"),
      "https://projects.propublica.org/nonprofits/organizations/221234567",
    );
  });
});

describe("parseProPublicaSearch", () => {
  it("normalizes orgs, coerces EIN to digit string, and builds source url", () => {
    const json = {
      organizations: [
        { ein: 221234567, name: "Prevention Links", city: "Roselle", state: "NJ", ntee_code: "F20" },
        { ein: "59-9999999", sub_name: "WestCare Florida", state: "FL", raw_ntee_code: "F22" },
        { name: "" }, // dropped: no name
      ],
    };
    const out = parseProPublicaSearch(json);
    assert.equal(out.length, 2);
    assert.equal(out[0].ein, "221234567");
    assert.equal(out[0].name, "Prevention Links");
    assert.equal(out[0].nteeCode, "F20");
    assert.equal(out[0].source, "propublica");
    assert.equal(out[0].sourceUrl, "https://projects.propublica.org/nonprofits/organizations/221234567");
    assert.equal(out[0].revenueUsd, null);
    assert.equal(out[1].ein, "599999999");
    assert.equal(out[1].name, "WestCare Florida");
  });

  it("returns [] for malformed payloads", () => {
    assert.deepEqual(parseProPublicaSearch(null), []);
    assert.deepEqual(parseProPublicaSearch({}), []);
    assert.deepEqual(parseProPublicaSearch({ organizations: "nope" }), []);
  });
});

describe("parseProPublicaRevenue", () => {
  it("picks the first usable revenue from filings_with_data", () => {
    const json = {
      filings_with_data: [
        { totrevenue: 0 }, // skipped: not > 0
        { totrevenue: 4200000 },
        { totrevenue: 9999 },
      ],
    };
    assert.equal(parseProPublicaRevenue(json), 4200000);
  });

  it("falls back across revenue fields and returns null when absent", () => {
    assert.equal(parseProPublicaRevenue({ filings_with_data: [{ totfuncexpns: 100 }] }), 100);
    assert.equal(parseProPublicaRevenue({ filings_with_data: [] }), null);
    assert.equal(parseProPublicaRevenue({}), null);
    assert.equal(parseProPublicaRevenue(null), null);
  });
});

describe("source registry", () => {
  it("candid is unavailable without an API key and returns []", async () => {
    const prev = process.env.CANDID_API_KEY;
    delete process.env.CANDID_API_KEY;
    try {
      assert.equal(candidSource.available, false);
      assert.deepEqual(await candidSource.search({ themes: ["health"] }), []);
    } finally {
      if (prev !== undefined) process.env.CANDID_API_KEY = prev;
    }
  });

  it("always includes propublica among available sources", () => {
    const ids = availableNonprofitSources().map((s) => s.id);
    assert.ok(ids.includes("propublica"));
  });

  it("searchNonprofitSources reports which sources were used", async () => {
    // ProPublica is live; with no network in CI fetchJson returns null -> []
    const { candidates, sourcesUsed } = await searchNonprofitSources({
      themes: ["substance_use"],
      states: ["NJ"],
      limit: 1,
    });
    assert.ok(Array.isArray(candidates));
    assert.ok(sourcesUsed.includes("propublica"));
  });
});

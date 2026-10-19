import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { parseSonarResponse, funderResearchConfigured } from "../lib/funder-research";

describe("funder research (Sonar) parsing", () => {
  it("extracts answer + deduped citations from both citation shapes", () => {
    const r = parseSonarResponse({
      choices: [{ message: { content: "RWJF funds health equity. [1]" } }],
      citations: ["https://rwjf.org/about", "https://rwjf.org/grants"],
      search_results: [{ url: "https://rwjf.org/grants" }, { url: "https://example.org/x" }],
    });
    assert.equal(r.answer, "RWJF funds health equity. [1]");
    assert.deepEqual(r.citations, [
      "https://rwjf.org/about",
      "https://rwjf.org/grants",
      "https://example.org/x",
    ]);
  });

  it("tolerates junk bodies", () => {
    assert.deepEqual(parseSonarResponse(null), { answer: null, citations: [] });
    assert.deepEqual(parseSonarResponse("nope"), { answer: null, citations: [] });
    assert.deepEqual(parseSonarResponse({}), { answer: null, citations: [] });
  });

  it("caps citations at 10", () => {
    const cites = Array.from({ length: 15 }, (_, i) => `https://x.org/${i}`);
    const r = parseSonarResponse({ choices: [{ message: { content: "a" } }], citations: cites });
    assert.equal(r.citations.length, 10);
  });

  it("configured() reflects the env seam", () => {
    const prev = process.env.PERPLEXITY_API_KEY;
    try {
      delete process.env.PERPLEXITY_API_KEY;
      assert.equal(funderResearchConfigured(), false);
      process.env.PERPLEXITY_API_KEY = "pplx-test";
      assert.equal(funderResearchConfigured(), true);
    } finally {
      if (prev !== undefined) process.env.PERPLEXITY_API_KEY = prev;
      else delete process.env.PERPLEXITY_API_KEY;
    }
  });
});

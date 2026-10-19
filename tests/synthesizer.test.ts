import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSynthesisSectionPrompt,
  describeNofoVoice,
  enumerateSynthesisSections,
  slugifySection,
  SYNTHESIS_SYSTEM_PROMPT,
} from "../lib/synthesizer";
import type { ExtractedNofo } from "../lib/extract";

test("slugifySection produces stable filename-safe slugs", () => {
  assert.equal(slugifySection("Project Narrative"), "project-narrative");
  assert.equal(slugifySection("Budget & Justification"), "budget-and-justification");
  assert.equal(slugifySection("  Letters of Support!!  "), "letters-of-support");
});

test("enumerate pulls the funder's required_sections, trimmed and de-duped", () => {
  const nofo: ExtractedNofo = {
    required_sections: ["Project Narrative", "  Project Narrative ", "Budget Justification", ""],
  };
  const out = enumerateSynthesisSections(nofo);
  assert.deepEqual(
    out.map((s) => s.slug),
    ["project-narrative", "budget-justification"],
  );
  assert.equal(out[0].title, "Project Narrative");
});

test("enumerate falls back to the standard sections when none are declared", () => {
  for (const nofo of [null, {}, { required_sections: [] } as ExtractedNofo]) {
    const out = enumerateSynthesisSections(nofo);
    assert.ok(out.length >= 4);
    assert.ok(out.some((s) => s.slug === "executive-summary"));
    assert.ok(out.some((s) => s.slug === "technical-approach"));
    // Reviewer Notes is internal QA — never a synthesized response section.
    assert.ok(!out.some((s) => s.slug === "reviewer-notes"));
  }
});

test("enumerate guards against titles that slug to nothing", () => {
  const out = enumerateSynthesisSections({ required_sections: ["!!!", "—"] });
  assert.ok(out.length >= 4, "should fall back rather than return empty");
});

test("describeNofoVoice assembles only the present structured fields", () => {
  const voice = describeNofoVoice({ agency: "SAMHSA", program: "State Opioid Response", summary: "Funds MAT expansion." });
  assert.match(voice, /SAMHSA/);
  assert.match(voice, /State Opioid Response/);
  assert.match(voice, /MAT expansion/);
  assert.match(describeNofoVoice(null), /neutral, formal/);
});

test("section prompt embeds evaluation criteria and demands criteria coverage", () => {
  const prompt = buildSynthesisSectionPrompt({
    sectionTitle: "Technical Approach",
    nofo: { evaluation_criteria: "Approach 40 pts; Past Performance 20 pts; Budget 15 pts" },
    business: "Acme Consulting",
    naics: "541611",
    opportunityText: "SAMHSA SOR grant",
    blocks: [{ id: "b1", title: "Org Overview", body: "We do public health." }],
  });
  assert.match(prompt, /## Technical Approach/);
  assert.match(prompt, /Approach 40 pts/);
  assert.match(prompt, /EVALUATION CRITERIA/);
  assert.match(prompt, /Block b1 — Org Overview/);
});

test("section prompt handles a NOFO with no stated criteria gracefully", () => {
  const prompt = buildSynthesisSectionPrompt({
    sectionTitle: "Project Narrative",
    nofo: {},
    business: "Acme Consulting",
    naics: "",
    opportunityText: "Some opportunity",
    blocks: [],
  });
  assert.match(prompt, /none stated/);
  assert.match(prompt, /none attached/);
});

test("section prompt threads the partners block through verbatim", () => {
  const partnersBlock = "# PARTNERSHIP CONTEXT\n\n### Riverside (FQHC)\n- Capabilities: clinical care";
  const prompt = buildSynthesisSectionPrompt({
    sectionTitle: "Capability Statement",
    nofo: {},
    business: "Acme",
    naics: "",
    opportunityText: "opp",
    blocks: [],
    partnersBlock,
  });
  assert.match(prompt, /PARTNERSHIP CONTEXT/);
  assert.match(prompt, /Riverside \(FQHC\)/);
});

test("synthesis system prompt enforces tone-matching and separated partner attribution", () => {
  assert.match(SYNTHESIS_SYSTEM_PROMPT, /MATCH THE FUNDER'S DEMANDED REGISTER/);
  assert.match(SYNTHESIS_SYSTEM_PROMPT, /OWN clearly separated/);
  assert.match(SYNTHESIS_SYSTEM_PROMPT, /ADDRESS THE EVALUATION CRITERIA/);
});

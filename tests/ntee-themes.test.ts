import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  GRANT_THEMES,
  isGrantTheme,
  THEME_LABELS,
  themesForNtee,
  nteeCodesForTheme,
  nteeMajorGroupsForTheme,
  inferThemesFromText,
} from "../lib/ntee-themes";

describe("ntee-themes", () => {
  it("every theme has a label and the guard round-trips", () => {
    for (const t of GRANT_THEMES) {
      assert.equal(typeof THEME_LABELS[t], "string");
      assert.ok(THEME_LABELS[t].length > 0);
      assert.equal(isGrantTheme(t), true);
    }
    assert.equal(isGrantTheme("nope"), false);
    assert.equal(isGrantTheme(null), false);
  });

  it("exact NTEE codes resolve to the right themes", () => {
    assert.deepEqual(themesForNtee("F22"), ["substance_use"]);
    assert.deepEqual(themesForNtee("F20"), ["substance_use", "behavioral_health"]);
    assert.deepEqual(themesForNtee("F30"), ["behavioral_health"]);
    assert.deepEqual(themesForNtee("I40"), ["reentry"]);
    assert.deepEqual(themesForNtee("I44"), ["reentry"]);
    assert.deepEqual(themesForNtee("O50"), ["youth"]);
    assert.deepEqual(themesForNtee("I21"), ["crime_prevention", "youth"]);
  });

  it("normalizes case/punctuation and trims whitespace", () => {
    assert.deepEqual(themesForNtee("  f22 "), ["substance_use"]);
    assert.deepEqual(themesForNtee("f-22"), ["substance_use"]);
  });

  it("falls back from a longer code to a known shorter exact code", () => {
    // F205 is not exact, but F20 is -> should resolve to F20's themes.
    assert.deepEqual(themesForNtee("F205"), ["substance_use", "behavioral_health"]);
  });

  it("falls back to major-group letter for unknown specific codes", () => {
    // F99 unknown -> major group F = behavioral_health
    assert.deepEqual(themesForNtee("F99"), ["behavioral_health"]);
    // I99 unknown -> major group I = crime_prevention
    assert.deepEqual(themesForNtee("I99"), ["crime_prevention"]);
    // O99 unknown -> youth
    assert.deepEqual(themesForNtee("O99"), ["youth"]);
  });

  it("returns [] for empty / unknown major groups (distinct 'no signal')", () => {
    assert.deepEqual(themesForNtee(""), []);
    assert.deepEqual(themesForNtee(null), []);
    assert.deepEqual(themesForNtee("Z99"), []); // Z not in our map
  });

  it("reverse map: nteeCodesForTheme returns specific codes, sorted & deduped", () => {
    const sud = nteeCodesForTheme("substance_use");
    assert.ok(sud.includes("F22"));
    assert.ok(sud.includes("F20"));
    // sorted
    assert.deepEqual([...sud].sort(), sud);
    const reentry = nteeCodesForTheme("reentry");
    assert.ok(reentry.includes("I40"));
    assert.ok(reentry.includes("I44"));
  });

  it("nteeMajorGroupsForTheme covers the right IRS letters", () => {
    assert.ok(nteeMajorGroupsForTheme("substance_use").includes("F"));
    assert.ok(nteeMajorGroupsForTheme("reentry").includes("I"));
    assert.ok(nteeMajorGroupsForTheme("youth").includes("O"));
  });

  it("inferThemesFromText extracts themes from opportunity prose", () => {
    assert.deepEqual(
      inferThemesFromText("Opioid use disorder treatment and recovery services"),
      ["substance_use"],
    );
    const multi = inferThemesFromText(
      "Behavioral health and reentry support for justice-impacted youth",
    );
    assert.ok(multi.includes("behavioral_health"));
    assert.ok(multi.includes("reentry"));
    assert.ok(multi.includes("youth"));
    // canonical order preserved
    assert.deepEqual(
      multi,
      GRANT_THEMES.filter((t) => multi.includes(t)),
    );
  });

  it("inferThemesFromText is empty when nothing matches", () => {
    assert.deepEqual(inferThemesFromText("Bridge and highway infrastructure repair"), []);
    assert.deepEqual(inferThemesFromText(null), []);
  });
});

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  OUTREACH_STATUSES,
  OUTREACH_STATUS_LABELS,
  DEFAULT_OUTREACH_STATUS,
  isOutreachStatus,
  linkedinConnectionToContactDraft,
  contactDedupeKey,
  composeColdIntro,
} from "../lib/contact-outreach";
import type { Connection } from "../lib/connections";

function conn(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "c1",
    name: "Jane Roe",
    title: "Director of Programs",
    company: "Community Health Org",
    description: "Runs grant-funded community health programs.",
    industry_keywords: ["healthcare", "community_health"],
    connection_date: "2024-03-01",
    potential_partnerships: ["healthcare", "federal_grants"],
    ...overrides,
  };
}

describe("contact-outreach", () => {
  it("isOutreachStatus accepts every declared status and rejects others", () => {
    for (const s of OUTREACH_STATUSES) assert.equal(isOutreachStatus(s), true);
    assert.equal(isOutreachStatus("invalid"), false);
    assert.equal(isOutreachStatus(""), false);
    assert.equal(isOutreachStatus(null), false);
    assert.equal(isOutreachStatus(42), false);
  });

  it("every status has a label; default is a valid status", () => {
    for (const s of OUTREACH_STATUSES) {
      assert.equal(typeof OUTREACH_STATUS_LABELS[s], "string");
      assert.ok(OUTREACH_STATUS_LABELS[s].length > 0);
    }
    assert.equal(isOutreachStatus(DEFAULT_OUTREACH_STATUS), true);
    assert.equal(DEFAULT_OUTREACH_STATUS, "not_contacted");
  });

  it("mapper routes company->agency, merges/dedupes tags, marks source linkedin", () => {
    const d = linkedinConnectionToContactDraft(conn());
    assert.equal(d.name, "Jane Roe");
    assert.equal(d.title, "Director of Programs");
    assert.equal(d.agency, "Community Health Org");
    assert.equal(d.source, "linkedin");
    // index carries no profile URL today
    assert.equal(d.linkedinUrl, null);
    assert.deepEqual([...d.tags].sort(), [
      "community_health",
      "federal_grants",
      "healthcare",
    ]);
    assert.equal(d.raw.connectionId, "c1");
    assert.equal(d.raw.connectionDate, "2024-03-01");
  });

  it("mapper coerces empty strings to null", () => {
    const d = linkedinConnectionToContactDraft(
      conn({ title: "", company: "", description: "" }),
    );
    assert.equal(d.title, null);
    assert.equal(d.agency, null);
    assert.equal(d.notes, null);
  });

  it("dedupe prefers linkedin url, case-insensitive", () => {
    const a = contactDedupeKey({ linkedinUrl: "https://LinkedIn.com/in/Jane", name: "Jane" });
    const b = contactDedupeKey({ linkedinUrl: "https://linkedin.com/in/jane", name: "Other" });
    assert.equal(a, b);
    assert.ok(a.startsWith("url:"));
  });

  it("dedupe falls back to name|org when no url", () => {
    const a = contactDedupeKey({ name: "Jane Roe", agency: "Community Health Org" });
    const b = contactDedupeKey({ name: "  jane roe ", agency: "COMMUNITY HEALTH ORG" });
    assert.equal(a, b);
    assert.ok(a.startsWith("nameorg:"));
    assert.notEqual(a, contactDedupeKey({ name: "Jane Roe", agency: "Other Org" }));
  });

  it("intro draft is generic with no opportunity context and never auto-sent", () => {
    const out = composeColdIntro(
      { name: "Jane Roe", title: "Director", agency: "Org", tags: ["healthcare"] },
      { senderName: "Dan Doe" },
    );
    assert.match(out.markdown, /NOTHING HAS BEEN SENT/);
    assert.match(out.markdown, /Hi Jane,/);
    assert.match(out.markdown, /Dan Doe/);
    assert.equal(out.safe, true);
    assert.equal(out.redactions.length, 0);
  });

  it("intro draft anchors on opportunity when provided", () => {
    const out = composeColdIntro(
      { name: "Jane Roe", title: "Director", agency: "Org", tags: ["healthcare"] },
      {
        opportunityTitle: "HRSA Community Health Grant",
        opportunitySummary: "Funds rural clinic expansion. Applications due in 60 days.",
        senderName: "Dan",
      },
    );
    assert.match(out.markdown, /HRSA Community Health Grant/);
    assert.match(out.markdown, /Funds rural clinic expansion\./);
  });

  it("intro draft routes through the 1.6 sanitizer (greenlight phrase stripped)", () => {
    const out = composeColdIntro({
      name: "Riverside",
      title: "Director",
      agency: "greenlight anything org",
      tags: [],
    });
    assert.equal(out.markdown.toLowerCase().includes("greenlight"), false);
  });

  it("intro draft redacts a blocklisted identity off a lead-facing surface", () => {
    const out = composeColdIntro(
      { name: "Jane Barred", title: "Principal", agency: "OldPartnerCo", tags: ["referrals"] },
      { senderName: "Dan" },
    );
    assert.equal(out.safe, false);
    assert.ok(out.redactions.length > 0);
    assert.doesNotMatch(out.markdown, /Jane Barred/);
    assert.doesNotMatch(out.markdown, /OldPartnerCo/);
  });
});

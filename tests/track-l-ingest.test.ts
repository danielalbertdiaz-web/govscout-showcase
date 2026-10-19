// Track L ingestion helpers — pure-function coverage (email extraction with
// conservative name attribution, priority mapping). Network-touching helpers
// (robots gate, firecrawl fallback) are exercised by the jobs themselves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEmails, contactPriority } from "../lib/track-l-ingest";

describe("extractEmails", () => {
  it("attributes a name from surrounding text and maps title keywords", () => {
    const text =
      "Contact our Health Officer: Jane Smith, MD (Health Commissioner)\n" +
      "Email: jane.smith@countyhealth.example.org or call 555-1234";
    const [e] = extractEmails(text);
    assert.equal(e.email, "jane.smith@countyhealth.example.org");
    assert.equal(e.name, "Jane Smith");
    assert.equal(e.isGeneric, false);
    assert.equal(contactPriority(e), "P2_HEALTH_OFFICER");
  });

  it("derives first.last names from the local part when context has none", () => {
    const [e] = extractEmails("reach us at maria.gonzalez@health.example.org today");
    assert.equal(e.name, "Maria Gonzalez");
  });

  it("flags generic inboxes and never invents a name for them", () => {
    const [e] = extractEmails("questions? info@townhealth.example.org");
    assert.equal(e.isGeneric, true);
    assert.equal(e.name, null);
    assert.equal(contactPriority(e), "P4_GENERIC");
  });

  it("maps CLPPP context to P1 priority", () => {
    const text = "Childhood Lead Poisoning Prevention Program coordinator — clppp.coordinator@doh.example.org";
    const [e] = extractEmails(text);
    assert.equal(contactPriority(e), "P1_CLPPP");
  });

  it("dedupes, lowercases, and drops asset/junk matches", () => {
    const emails = extractEmails(
      "Info@Example.org Info@example.org logo@2x.png hero.jpg@site.css sentry@sentry.wixpress.com",
    );
    assert.equal(emails.length, 1);
    assert.equal(emails[0].email, "info@example.org");
  });

  it("returns empty for pages with no addresses", () => {
    assert.deepEqual(extractEmails("no contacts on this page at all"), []);
  });
});

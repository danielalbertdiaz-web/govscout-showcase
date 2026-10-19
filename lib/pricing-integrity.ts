/**
 * Pricing-integrity detector for outbound artifacts (PRICING_CORRUPTION_2026-07-19).
 *
 * On 2026-07-19 five federal quotations were staged as Gmail drafts by an
 * openclaw agent whose exec tool runs commands through the user's login shell
 * (zsh). The quote bodies were embedded in double-quoted shell strings, and
 * zsh — unlike bash — expands multi-digit positional parameters without
 * braces: "$45,500" parses as ${45} + ",500", and ${45} is unset. Every
 * "$<digits>" token vanished wholesale, leaving artifacts like:
 *
 *     Firm Fixed Price: ,500
 *     - 3D engine integration and testing: ,800
 *     Blended rate: /hr
 *
 * Four of those drafts were sent to contracting officers as-is. GovScout's
 * ingest noticed ("price_basis = amount unverified — no total line found")
 * but only wrote a column; nothing raised.
 *
 * This module is the machine-readable form of that corruption signature, so
 * any send/stage path (and the fp submission logger) can fail loudly instead.
 * It is deliberately dependency-free and side-effect-free.
 *
 * NOTE: not yet wired into any production path — imported by
 * tests/pricing-integrity.test.ts only. Wiring points, when approved:
 *   - workspace send_guard.assert_sendable (Python twin of these regexes)
 *   - scripts/fp.mts log-event kind "submission" (reject/flag when the body
 *     or the stored row carries the signature)
 */

export interface PricingArtifact {
  /** Which pattern matched. */
  kind: "orphan_comma_group" | "orphan_rate_unit" | "empty_price_label";
  /** The matched text plus a little surrounding context. */
  excerpt: string;
  /** Character offset of the match in the input. */
  index: number;
}

// ",500" with no digit (or $) immediately before the comma. A healthy figure
// ("$45,500", "1,240,500") always has a digit touching the comma on the left.
// Word-boundary lookahead keeps "no. 1,5001" style runs from double-firing.
const ORPHAN_COMMA_GROUP = /(?<![\d$]),\d{3}(?!\d)/g;

// "/hr" or "/hour" with no digit before the slash — "$135/hr" stripped to
// "/hr". A healthy rate always has the number touching the slash.
const ORPHAN_RATE_UNIT = /(?<=^|[\s:])\/(?:hr|hour)\b/gim;

// A pricing label whose value begins with punctuation left behind by a
// stripped "$<digits>" token — "Firm Fixed Price: ,500". A bare section
// header ("PRICING:" at end of line) is healthy and must NOT match.
const EMPTY_PRICE_LABEL =
  /\b(price|pricing|total|rate|cost|fee|amount)\s*:\s*(?=[,.])/gim;

function excerptAround(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + matchLen + 20);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Scan an outbound artifact (email body, staged draft, quote text) for the
 * stripped-dollar corruption signature. Empty array = no signature found.
 */
export function findStrippedPriceArtifacts(text: string): PricingArtifact[] {
  const found: PricingArtifact[] = [];
  const patterns: [PricingArtifact["kind"], RegExp][] = [
    ["orphan_comma_group", ORPHAN_COMMA_GROUP],
    ["orphan_rate_unit", ORPHAN_RATE_UNIT],
    ["empty_price_label", EMPTY_PRICE_LABEL],
  ];
  for (const [kind, re] of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      found.push({
        kind,
        excerpt: excerptAround(text, m.index ?? 0, m[0].length),
        index: m.index ?? 0,
      });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Invariant for documents that claim to carry pricing: a body whose subject
 * or content says "quotation"/"quote"/"pricing" must contain at least one
 * intact dollar figure. Catches strippings the shape-detectors miss (e.g. a
 * body where every "$<digits>" token vanished cleanly, commas and all).
 */
export function pricingDocumentHasDollarFigure(text: string): boolean {
  return /\$\s?\d/.test(text);
}

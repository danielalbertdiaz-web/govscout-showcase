import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseCsvLine,
  parseBmfCsv,
  isPrivateFoundation,
  isThemeRelevant,
  bmfRowThemes,
  bmfRowToReferenceOrg,
  bmfToFoundations,
  titleCaseName,
  type BmfRow,
} from "../lib/foundation-sources/irs-bmf";

// The real BMF header (column order matters — the parser is header-driven).
const HEADER =
  "EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME";

// Build a 28-column BMF row from the few fields the parser reads.
function row(f: {
  ein: string;
  name: string;
  city?: string;
  state?: string;
  foundation: string;
  ntee?: string;
  asset?: string;
}): string {
  const cols = new Array(28).fill("");
  cols[0] = f.ein;
  cols[1] = f.name;
  cols[4] = f.city ?? "";
  cols[5] = f.state ?? "";
  cols[13] = f.foundation;
  cols[23] = f.asset ?? "";
  cols[26] = f.ntee ?? "";
  return cols.join(",");
}

function rec(over: Partial<BmfRow>): BmfRow {
  return {
    ein: "111111111",
    name: "Test Foundation",
    city: "Centerville",
    state: "NJ",
    foundation: "04",
    nteeCode: "F22",
    assetAmt: 1_000_000,
    incomeAmt: null,
    revenueAmt: null,
    ...over,
  };
}

describe("IRS BMF CSV parsing", () => {
  it("parseCsvLine handles plain + quoted-with-comma fields", () => {
    assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
    assert.deepEqual(parseCsvLine('1,"Smith, John Foundation",NJ'), ["1", "Smith, John Foundation", "NJ"]);
    assert.deepEqual(parseCsvLine('x,"a ""quoted"" b",y'), ["x", 'a "quoted" b', "y"]);
  });

  it("parseBmfCsv is header-driven and skips rows missing EIN/NAME", () => {
    const csv = [
      HEADER,
      row({ ein: "223344556", name: "GARDEN STATE RECOVERY FOUNDATION", state: "NJ", foundation: "04", ntee: "F22", asset: "5000000" }),
      row({ ein: "", name: "NO EIN ORG", foundation: "04" }), // skipped
      row({ ein: "999", name: "", foundation: "04" }), // skipped (no name)
    ].join("\n");
    const rows = parseBmfCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ein, "223344556");
    assert.equal(rows[0].foundation, "04");
    assert.equal(rows[0].nteeCode, "F22");
    assert.equal(rows[0].assetAmt, 5_000_000);
  });
});

describe("IRS BMF private-foundation + theme filters", () => {
  it("isPrivateFoundation accepts 02/03/04, rejects public-charity codes", () => {
    assert.equal(isPrivateFoundation(rec({ foundation: "04" })), true);
    assert.equal(isPrivateFoundation(rec({ foundation: "02" })), true);
    assert.equal(isPrivateFoundation(rec({ foundation: "10" })), false); // church / public charity
    assert.equal(isPrivateFoundation(rec({ foundation: "" })), false);
  });

  it("isThemeRelevant: NTEE theme OR mission name term", () => {
    assert.equal(isThemeRelevant(rec({ nteeCode: "F22" })), true); // SUD treatment
    assert.equal(isThemeRelevant(rec({ nteeCode: null, name: "OPIOID RECOVERY FUND" })), true); // name
    assert.equal(isThemeRelevant(rec({ nteeCode: "T20", name: "SMITH FAMILY FOUNDATION" })), false); // generic
  });

  it("bmfRowThemes prefers NTEE, falls back to name inference", () => {
    assert.ok(bmfRowThemes(rec({ nteeCode: "F22" })).includes("substance_use"));
    const inferred = bmfRowThemes(rec({ nteeCode: null, name: "MENTAL HEALTH SUPPORT FOUNDATION" }));
    assert.ok(inferred.includes("behavioral_health"));
  });
});

describe("IRS BMF → ReferenceOrg mapping", () => {
  it("maps a private foundation with assets + EIN + ProPublica link", () => {
    const o = bmfRowToReferenceOrg(
      rec({ ein: "223344556", name: "GARDEN STATE RECOVERY FOUNDATION", state: "NJ", nteeCode: "F22", assetAmt: 5_000_000 }),
    );
    assert.equal(o.kind, "private_foundation");
    assert.equal(o.ein, "223344556");
    assert.equal(o.id, "pf-223344556");
    assert.equal(o.geography, "New Jersey");
    assert.equal(o.amountUsd, 5_000_000);
    assert.match(o.sourceUrl ?? "", /propublica\.org\/nonprofits\/organizations\/223344556/);
    assert.match(o.note ?? "", /est\. annual giving ~\$250K/); // 5% of $5M
    assert.ok(o.focusAreas.length > 0);
    assert.equal(o.name, "Garden State Recovery Foundation"); // title-cased
  });

  it("bmfToFoundations: keeps private+on-theme, dedupes by EIN, sorts by assets", () => {
    const csv = [
      HEADER,
      row({ ein: "111", name: "SMALL RECOVERY FOUNDATION", state: "NJ", foundation: "04", ntee: "F20", asset: "2000000" }),
      row({ ein: "222", name: "BIG BEHAVIORAL HEALTH FOUNDATION", state: "FL", foundation: "03", ntee: "F30", asset: "9000000" }),
      row({ ein: "333", name: "SMITH FAMILY FOUNDATION", state: "NJ", foundation: "04", ntee: "T20", asset: "8000000" }), // off-theme
      row({ ein: "444", name: "NEWARK PUBLIC CHARITY", state: "NJ", foundation: "10", ntee: "F22", asset: "1000000" }), // not PF
      row({ ein: "222", name: "BIG BEHAVIORAL HEALTH FOUNDATION DUP", state: "FL", foundation: "03", ntee: "F30", asset: "9000000" }), // dup EIN
    ].join("\n");
    const res = bmfToFoundations(csv);
    assert.equal(res.total, 5);
    assert.equal(res.privateFoundations, 4); // excludes the public charity
    assert.equal(res.themeRelevant, 2); // excludes off-theme + dedupes
    assert.equal(res.orgs[0].ein, "222"); // biggest assets first
    assert.equal(res.orgs[1].ein, "111");
  });

  it("titleCaseName tidies BMF all-caps, keeps acronyms", () => {
    assert.equal(titleCaseName("GARDEN STATE FOUNDATION"), "Garden State Foundation");
    assert.equal(titleCaseName("ABC FOUNDATION OF NJ"), "Abc Foundation of NJ");
  });
});

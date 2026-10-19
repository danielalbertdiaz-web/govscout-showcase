import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  ALL_SETTLEMENT_BOARDS,
  NJ_COUNTIES,
  NJ_COUNTY_BOARDS,
  NJ_PRIORITY_COUNTIES,
  PRIORITY_STATES,
  STATE_BOARDS,
  coverageReport,
  geographyBiasRank,
  orderedBoards,
  priorityBoards,
  settlementNotes,
  isSettlementNotes,
  OPIOID_SETTLEMENT_FUNDING_SOURCE,
  type SettlementBoard,
} from "../lib/settlement-boards/catalogue";
import { boardToWatchTarget, settlementTargets } from "../lib/sources/apify-watcher";
import {
  classifyBoardProbe,
  reviewSettlementBoards,
  type BoardProbe,
} from "../lib/settlement-scan";

describe("5.3 settlement-board catalogue — coverage", () => {
  it("covers all 21 NJ counties exactly once", () => {
    const rep = coverageReport();
    assert.equal(rep.njCounties, 21, `missing: ${rep.njCountiesMissing.join(", ")}`);
    assert.deepEqual(rep.njCountiesMissing, []);
    // no duplicate county
    const counties = NJ_COUNTY_BOARDS.map((b) => b.county);
    assert.equal(new Set(counties).size, counties.length, "duplicate county board");
    assert.equal(NJ_COUNTIES.length, 21);
  });

  it("includes Harbor (the existing anchor) plus the 8 priority counties", () => {
    const covered = new Set(NJ_COUNTY_BOARDS.map((b) => b.county));
    assert.ok(covered.has("Hudson"), "Hudson must be monitored");
    for (const c of NJ_PRIORITY_COUNTIES) {
      assert.ok(covered.has(c), `priority county ${c} not covered`);
    }
    assert.ok(coverageReport().njPriorityCovered);
  });

  it("covers ≥10 priority states including all listed", () => {
    const rep = coverageReport();
    assert.ok(rep.states >= 10, `only ${rep.states} states`);
    assert.deepEqual(rep.statesMissing, [], `missing states: ${rep.statesMissing.join(", ")}`);
    assert.equal(PRIORITY_STATES.length, 10);
  });

  it("every board has the required monitoring fields", () => {
    for (const b of ALL_SETTLEMENT_BOARDS) {
      assert.ok(b.id && b.name, `board missing id/name`);
      assert.match(b.dashboardUrl, /^https?:\/\//, `${b.id} bad dashboardUrl`);
      assert.ok(b.cadence.length > 0, `${b.id} missing cadence`);
      assert.ok(Array.isArray(b.decisionMakers), `${b.id} decisionMakers not array`);
      assert.ok(["county", "state"].includes(b.level));
    }
    // ids are unique across the whole catalogue
    const ids = ALL_SETTLEMENT_BOARDS.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate board id");
  });
});

describe("5.3 geography bias (NJ → FL → rest)", () => {
  it("ranks home states ahead of others", () => {
    assert.equal(geographyBiasRank("NJ"), 0);
    assert.equal(geographyBiasRank("FL"), 1);
    assert.ok(geographyBiasRank("NY") > geographyBiasRank("FL"));
    assert.equal(geographyBiasRank("ny"), geographyBiasRank("NY"));
  });

  it("orders boards NJ-first then FL then rest, priority within", () => {
    const ordered = orderedBoards();
    // first board must be an NJ board
    assert.equal(ordered[0].state, "NJ");
    // all NJ boards precede every non-NJ board
    const lastNjIdx = ordered.map((b) => b.state).lastIndexOf("NJ");
    const firstNonNj = ordered.findIndex((b) => b.state !== "NJ");
    assert.ok(lastNjIdx < firstNonNj || firstNonNj === -1);
    // the first non-home-state board is reached only after FL
    const flIdx = ordered.findIndex((b) => b.state === "FL");
    const nyIdx = ordered.findIndex((b) => b.state === "NY");
    assert.ok(flIdx < nyIdx);
  });

  it("priorityBoards(1) returns only top-priority boards", () => {
    for (const b of priorityBoards(1)) assert.equal(b.priority, 1);
  });
});

describe("5.3 opioid_settlement tagging", () => {
  it("settlementNotes embeds the funding_source marker + provenance", () => {
    const board = STATE_BOARDS.find((b) => b.id === "nj_state_orrf") as SettlementBoard;
    const notes = settlementNotes(board, { item_url: "https://x/y" });
    const parsed = JSON.parse(notes);
    assert.equal(parsed.funding_source, OPIOID_SETTLEMENT_FUNDING_SOURCE);
    assert.equal(parsed.board_id, "nj_state_orrf");
    assert.equal(parsed.state, "NJ");
    assert.equal(parsed.item_url, "https://x/y");
    assert.ok(isSettlementNotes(notes));
  });

  it("isSettlementNotes rejects non-settlement notes", () => {
    assert.equal(isSettlementNotes(null), false);
    assert.equal(isSettlementNotes(JSON.stringify({ foo: 1 })), false);
    assert.equal(isSettlementNotes("just text"), false);
  });

  it("boardToWatchTarget stamps the settlement marker + county/state bucket", () => {
    const county = NJ_COUNTY_BOARDS[0];
    const wt = boardToWatchTarget(county);
    assert.equal(wt.sourceId, `settlement_${county.id}`);
    assert.equal(wt.source, "county");
    assert.ok(isSettlementNotes(wt.notes));
    const stateBoard = STATE_BOARDS.find((b) => b.level === "state") as SettlementBoard;
    assert.equal(boardToWatchTarget(stateBoard).source, "state");
  });

  it("settlementTargets() yields one WatchTarget per board, home-state-biased", () => {
    const targets = settlementTargets();
    assert.equal(targets.length, ALL_SETTLEMENT_BOARDS.length);
    assert.ok(targets.every((t) => isSettlementNotes(t.notes)));
    // unique dedup keys
    const ids = targets.map((t) => t.sourceId);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("5.3 quarterly board-health probe", () => {
  it("classifyBoardProbe maps HTTP status to health", () => {
    assert.equal(classifyBoardProbe({ ok: true, httpStatus: 200 }), "active");
    assert.equal(classifyBoardProbe({ ok: true, httpStatus: 204 }), "active");
    assert.equal(classifyBoardProbe({ ok: false, httpStatus: 301 }), "moved");
    assert.equal(classifyBoardProbe({ ok: false, httpStatus: 404 }), "dead");
    assert.equal(classifyBoardProbe({ ok: false, httpStatus: 500 }), "dead");
    assert.equal(classifyBoardProbe({ ok: false, httpStatus: null }), "dead");
  });

  it("reviewSettlementBoards tallies probe outcomes without touching the network or DB", async () => {
    const probeOverride = (board: SettlementBoard): BoardProbe => {
      // make NJ ORRF look moved, one county dead, rest active
      let status: BoardProbe["status"] = "active";
      let httpStatus: number | null = 200;
      if (board.id === "nj_state_orrf") {
        status = "moved";
        httpStatus = 301;
      } else if (board.id === "nj_atlantic") {
        status = "dead";
        httpStatus = 404;
      }
      return { boardId: board.id, url: board.dashboardUrl, httpStatus, status };
    };
    const res = await reviewSettlementBoards("tester@example.com", {
      probeOverride,
      fileSuggestions: false,
    });
    assert.equal(res.checked, ALL_SETTLEMENT_BOARDS.length);
    assert.equal(res.moved, 1);
    assert.equal(res.dead, 1);
    assert.equal(res.active, ALL_SETTLEMENT_BOARDS.length - 2);
    assert.ok(res.flagged.includes("nj_state_orrf"));
    assert.ok(res.flagged.includes("nj_atlantic"));
    assert.equal(res.flagged.length, 2);
  });
});

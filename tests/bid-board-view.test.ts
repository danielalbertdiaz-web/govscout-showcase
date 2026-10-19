// Bid Board view helpers — pure functions only, no rendering.
//
// deadlineText reads the clock, so inputs are built relative to Date.now()
// with a one-minute buffer so floor() can't straddle a boundary mid-test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deadlineText, dropStatusesFor, recordText, PipelineCard, PipelineColumn } from "../app/bid-board/view";
import { FP_BOARD_GROUPS } from "../lib/federal-pipeline-types";
import { deadlineText as deadlineTextFromLib } from "../lib/deadline";
import {
  deadlineText as deadlineTextFromOpportunities,
  PipelineCard as CardFromOpportunities,
  PipelineColumn as ColumnFromOpportunities,
} from "../app/opportunities/view";
import {
  PipelineCard as CardFromComponents,
  PipelineColumn as ColumnFromComponents,
} from "../app/_components/PipelineBoard";

const HOUR_MS = 60 * 60 * 1000;
const BUFFER_MS = 60 * 1000;

/** ISO timestamp `hours` from now (plus a small buffer in the same direction). */
function fromNow(hours: number): string {
  const sign = hours < 0 ? -1 : 1;
  return new Date(Date.now() + hours * HOUR_MS + sign * BUFFER_MS).toISOString();
}

describe("deadlineText", () => {
  it('returns "past due" (not "closed") for an elapsed deadline', () => {
    assert.equal(deadlineText(fromNow(-2)), "past due");
    assert.equal(deadlineText(fromNow(-24 * 30)), "past due");
  });

  it('returns "no deadline" for null', () => {
    assert.equal(deadlineText(null), "no deadline");
  });

  it('returns "no deadline" for an unparseable date', () => {
    assert.equal(deadlineText("not-a-date"), "no deadline");
  });

  it('returns "due <1h" inside the final hour', () => {
    assert.equal(deadlineText(fromNow(0.5)), "due <1h");
  });

  it('returns "due in Nh" under 48 hours', () => {
    assert.equal(deadlineText(fromNow(30)), "due in 30h");
  });

  it('returns "due in Nd" at 48 hours and beyond', () => {
    assert.equal(deadlineText(fromNow(5 * 24)), "due in 5d");
    assert.equal(deadlineText(fromNow(48)), "due in 2d");
  });

  it('never returns "closed" — that word belongs to the closed_* statuses', () => {
    for (const input of [fromNow(-1), fromNow(3), null]) {
      assert.notEqual(deadlineText(input), "closed");
    }
  });

  // D-1: the vocabulary regressed in /opportunities because each view carried
  // its own copy of this helper. There is now exactly ONE definition
  // (lib/deadline.ts); both views re-export it. Function identity proves the
  // definitions cannot drift — a copy would fail this immediately.
  it("is the SAME function in lib/deadline, /bid-board, and /opportunities", () => {
    assert.equal(deadlineText, deadlineTextFromLib);
    assert.equal(deadlineTextFromOpportunities, deadlineTextFromLib);
  });

  it('an elapsed deadline returns "past due" from BOTH views\' import path', () => {
    assert.equal(deadlineText(fromNow(-2)), "past due");
    assert.equal(deadlineTextFromOpportunities(fromNow(-2)), "past due");
  });

  // Fix 1b: the pinned failing case. A micro row carries a bare date; before
  // the end-of-day-local parse, "due tomorrow" rendered "past due" (or
  // "due in 7h") from 8pm Eastern the evening before.
  it("a micro row due tomorrow does not render 'past due' this evening", () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const bare = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    const label = deadlineText(bare);
    assert.notEqual(label, "past due");
    assert.notEqual(label, "no deadline");
    assert.match(label, /^due in \d+(h|d)$|^due <1h$/);
  });
});

// Cleanup task 3: the board card/column markup was extracted into
// app/_components/PipelineBoard.tsx after /opportunities had to mirror
// /bid-board's markup by hand (the U-2 contradiction). Same guard as
// deadlineText: function identity across every import path means a
// reintroduced copy — under ANY name — fails here immediately.
describe("PipelineBoard components", () => {
  it("PipelineCard is the SAME component in _components, /bid-board, and /opportunities", () => {
    assert.equal(PipelineCard, CardFromComponents);
    assert.equal(CardFromOpportunities, CardFromComponents);
  });

  it("PipelineColumn is the SAME component in _components, /bid-board, and /opportunities", () => {
    assert.equal(PipelineColumn, ColumnFromComponents);
    assert.equal(ColumnFromOpportunities, ColumnFromComponents);
  });
});

// Kanban drop targets (2026-08-13): a drop may only assign a status the
// target column itself displays — otherwise a card teleports on refresh.
describe("dropStatusesFor", () => {
  it("returns exactly the column's own status list for every board group", () => {
    for (const g of FP_BOARD_GROUPS) {
      assert.deepEqual(dropStatusesFor(g.key), g.statuses);
    }
  });

  it("single-status columns (auto-apply on drop) are exactly drafting/awaiting/submitted/qa", () => {
    const single = FP_BOARD_GROUPS.filter((g) => g.statuses.length === 1).map((g) => g.key);
    assert.deepEqual(single.sort(), ["awaiting", "drafting", "qa", "submitted"]);
  });

  it("an unknown column key yields no targets (drop is a no-op, never a guess)", () => {
    assert.deepEqual(dropStatusesFor("nope"), []);
  });
});

describe("recordText", () => {
  it("renders the honest phrase when no outcome has been recorded", () => {
    assert.equal(recordText(0, 0, 0), "no outcomes recorded yet");
  });

  it("renders the numeric form as soon as any outcome exists", () => {
    assert.equal(recordText(1, 0, 0), "record 1W–0L–0NA");
    assert.equal(recordText(0, 1, 0), "record 0W–1L–0NA");
    assert.equal(recordText(0, 0, 1), "record 0W–0L–1NA");
    assert.equal(recordText(3, 2, 1), "record 3W–2L–1NA");
  });
});

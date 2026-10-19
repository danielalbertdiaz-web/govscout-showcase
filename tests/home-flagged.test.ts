// The command center's Flagged section (migration 041 follow-up).
//
// The gap this closes: "Upcoming deadlines" is deadline-ordered, 30-day
// horizoned and slice(0,8)-truncated — deliberately flag-blind (pinned in
// tests/pipeline-summary.test.ts), so flagging an item ranked ~15th changed
// nothing on the surface the operator looks at first. The flag gets its OWN
// surface instead of corrupting the deadline ordering: flagged + still
// actionable, no horizon, no slice. Empty input drives the section to not
// render at all — no empty labelled box.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flaggedActionable, deadlineText } from "../app/page";
import { deadlineText as deadlineTextFromLib } from "../lib/deadline";

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

type Row = Parameters<typeof flaggedActionable>[0][number];

function fpRow(over: Partial<Row> & { id: string }): Row {
  return {
    title: over.id,
    agency: null,
    responseDeadline: null,
    status: "discovered",
    flaggedAt: null,
    ...over,
  };
}

describe("flaggedActionable", () => {
  it("a flagged item far beyond the 30-day horizon still surfaces", () => {
    const out = flaggedActionable([
      fpRow({ id: "far-60d", flaggedAt: Date.now(), responseDeadline: iso(60) }),
    ]);
    assert.deepEqual(out.map((i) => i.id), ["far-60d"], "the flag surface has no horizon");
  });

  it("unflagged items never appear, however urgent", () => {
    const out = flaggedActionable([
      fpRow({ id: "unflagged-tomorrow", responseDeadline: iso(1) }),
      fpRow({ id: "flagged-16d", flaggedAt: Date.now(), responseDeadline: iso(16) }),
    ]);
    assert.deepEqual(out.map((i) => i.id), ["flagged-16d"]);
  });

  it("a flagged item the operator already decided is not actionable and stays out", () => {
    const out = flaggedActionable([
      fpRow({ id: "nobid", flaggedAt: Date.now(), status: "triaged_nobid" }),
      fpRow({ id: "won", flaggedAt: Date.now(), status: "closed_won" }),
      fpRow({ id: "gone", flaggedAt: Date.now(), status: "withdrawn" }),
      fpRow({ id: "live", flaggedAt: Date.now(), status: "triaged_bid" }),
    ]);
    assert.deepEqual(out.map((i) => i.id), ["live"], "decided items are not a call to action");
  });

  it("a flagged item with NO deadline is still visible", () => {
    const out = flaggedActionable([fpRow({ id: "no-deadline", flaggedAt: Date.now() })]);
    assert.deepEqual(out.map((i) => i.id), ["no-deadline"]);
    assert.equal(out[0]!.deadline, null);
  });

  it("does not truncate — more than eight flagged items all surface", () => {
    const rows = Array.from({ length: 11 }, (_, n) =>
      fpRow({ id: `f${n}`, flaggedAt: Date.now(), responseDeadline: iso(n + 1) }),
    );
    assert.equal(flaggedActionable(rows).length, 11, "no slice(0,8) on the flag surface");
  });

  it("returns [] when nothing is flagged — the section renders nothing at all", () => {
    const out = flaggedActionable([
      fpRow({ id: "a", responseDeadline: iso(2) }),
      fpRow({ id: "b", responseDeadline: iso(5) }),
    ]);
    assert.deepEqual(out, []);
  });
});

describe("flagged rows' deadline vocabulary", () => {
  // D-1 guard, same as the board views: the home page re-exports
  // lib/deadline.ts's deadlineText and renders flagged deadlines with it.
  // Function identity means a locally-computed copy fails here immediately.
  it("deadlineText re-exported by the home page IS lib/deadline's", () => {
    assert.equal(deadlineText, deadlineTextFromLib);
  });
});

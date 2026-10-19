// Unified pipeline summary (UX audit packet U-1) — pure-function tests, no DB.
//
// The home page previously counted deadlines on saved_opportunities alone
// (2 rows) and showed "0 deadlines" against 572 tracked records. These pin
// the normalisation, the deadline window, and the defensive date parsing —
// especially that a malformed deadline string is "no deadline", never epoch 0.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  unifyPipeline,
  upcomingDeadlines,
  countBySource,
  parseDeadlineMs,
  isActionable,
  isPastDue,
  filterPipeline,
  sortByDeadline,
  type PipelineItem,
} from "../lib/pipeline-summary";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0); // 2026-08-04T12:00:00Z
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysFromNow: number) => new Date(NOW + daysFromNow * DAY_MS).toISOString();

function item(over: Partial<PipelineItem> & { id: string }): PipelineItem {
  return {
    title: over.id,
    source: "federal",
    deadline: null,
    agency: null,
    href: "/bid-board",
    status: null,
    ...over,
  };
}

describe("unifyPipeline", () => {
  it("normalises all three shapes and tags source correctly", () => {
    const items = unifyPipeline(
      [{ id: "fp1", title: "DHA Brief", agency: "DHA", responseDeadline: iso(5), status: "drafting" }],
      [{ id: "mc1", title: "NPS Signage", agency: "NPS", responseDeadline: iso(3), disposition: "new" }],
      [{ id: "sv1", title: "SAMHSA NOFO", agency: "SAMHSA", deadline: iso(9), pipelineStage: "development" }],
    );
    assert.equal(items.length, 3);

    const fp = items.find((i) => i.id === "fp1")!;
    assert.equal(fp.source, "federal");
    assert.equal(fp.href, "/bid-board");
    assert.equal(fp.deadline, iso(5));
    assert.equal(fp.status, "drafting");

    const mc = items.find((i) => i.id === "mc1")!;
    assert.equal(mc.source, "micro");
    assert.equal(mc.href, "/contracts");
    assert.equal(mc.status, "new");

    const sv = items.find((i) => i.id === "sv1")!;
    assert.equal(sv.source, "saved");
    assert.equal(sv.href, "/opportunities/sv1");
    assert.equal(sv.agency, "SAMHSA");
    assert.equal(sv.status, "development");
  });
});

describe("upcomingDeadlines", () => {
  it("excludes past deadlines — a passed deadline is not upcoming", () => {
    const out = upcomingDeadlines(
      [item({ id: "past", deadline: iso(-2) }), item({ id: "future", deadline: iso(2) })],
      { now: NOW, withinDays: 30 },
    );
    assert.deepEqual(out.map((i) => i.id), ["future"]);
  });

  it("excludes null, empty, and malformed deadlines", () => {
    const out = upcomingDeadlines(
      [
        item({ id: "null", deadline: null }),
        item({ id: "empty", deadline: "" }),
        item({ id: "blank", deadline: "   " }),
        item({ id: "garbage", deadline: "TBD — see amendment" }),
        item({ id: "ok", deadline: iso(1) }),
      ],
      { now: NOW, withinDays: 30 },
    );
    assert.deepEqual(out.map((i) => i.id), ["ok"]);
  });

  it("respects the window boundary — in at 29 days, out at 31", () => {
    const out = upcomingDeadlines(
      [item({ id: "in29", deadline: iso(29) }), item({ id: "out31", deadline: iso(31) })],
      { now: NOW, withinDays: 30 },
    );
    assert.deepEqual(out.map((i) => i.id), ["in29"]);
  });

  it("sorts soonest first", () => {
    const out = upcomingDeadlines(
      [
        item({ id: "d10", deadline: iso(10) }),
        item({ id: "d1", deadline: iso(1) }),
        item({ id: "d5", deadline: iso(5) }),
      ],
      { now: NOW, withinDays: 30 },
    );
    assert.deepEqual(out.map((i) => i.id), ["d1", "d5", "d10"]);
  });

  it("a malformed deadline does NOT sort to the top as a 1970 date", () => {
    // The bug most likely to slip through: a bad parse coercing to epoch 0
    // would rank the garbage row "soonest" (or, with a naive >= check against
    // epoch, show it as decades overdue at the head of the list).
    assert.equal(parseDeadlineMs("not-a-date"), null);
    const out = upcomingDeadlines(
      [item({ id: "garbage", deadline: "not-a-date" }), item({ id: "real", deadline: iso(7) })],
      { now: NOW, withinDays: 30 },
    );
    assert.deepEqual(out.map((i) => i.id), ["real"], "garbage must be excluded, not ranked");
    assert.notEqual(out[0]?.id, "garbage");
  });

  // Priority-flag non-regression (migration 041). listFpOpportunities now
  // emits flagged rows FIRST, so this strip receives flag-first input — but
  // the strip answers "what runs out first", and a flag must never hide
  // urgency. PipelineItem carries no flag field on purpose; this pins that a
  // flagged far-deadline item cannot jump an unflagged near-deadline one via
  // input order (the only channel a flag could leak through).
  it("stays strictly deadline-ordered when input arrives flag-first", () => {
    const flaggedFar = item({ id: "flagged-far-40d", deadline: iso(40) });
    const unflaggedNear = item({ id: "unflagged-due-tomorrow", deadline: iso(1) });
    const out = upcomingDeadlines([flaggedFar, unflaggedNear], { now: NOW, withinDays: 45 });
    assert.deepEqual(
      out.map((i) => i.id),
      ["unflagged-due-tomorrow", "flagged-far-40d"],
      "the deadline strip must not let a flag outrank tomorrow's deadline",
    );
  });
});

// The needs-action filter. ~93 of the first live run's 145 "deadlines" were
// items the operator had already decided (passed micro sweeps, no-bids) — a tile
// counting those trains him to ignore it, the same cry-wolf failure as the
// cron false alarms. Decided items are out; unknown statuses stay IN.
describe("actionable filtering", () => {
  const within = { now: NOW, withinDays: 30 };

  it("excludes a decided micro item (passed)", () => {
    const out = upcomingDeadlines(
      [
        item({ id: "passed", source: "micro", status: "passed", deadline: iso(3) }),
        item({ id: "live", source: "micro", status: "new", deadline: iso(4) }),
      ],
      within,
    );
    assert.deepEqual(out.map((i) => i.id), ["live"]);
  });

  it("excludes a decided federal item (triaged_nobid)", () => {
    const out = upcomingDeadlines(
      [
        item({ id: "nobid", source: "federal", status: "triaged_nobid", deadline: iso(3) }),
        item({ id: "watch", source: "federal", status: "triaged_watch", deadline: iso(4) }),
      ],
      within,
    );
    assert.deepEqual(out.map((i) => i.id), ["watch"]);
  });

  it("includes actionable items (micro new, federal triaged_watch)", () => {
    assert.equal(isActionable(item({ id: "a", source: "micro", status: "new" })), true);
    assert.equal(isActionable(item({ id: "b", source: "micro", status: "reviewing" })), true);
    assert.equal(isActionable(item({ id: "c", source: "federal", status: "triaged_watch" })), true);
    assert.equal(isActionable(item({ id: "d", source: "federal", status: "awaiting_approval" })), true);
  });

  it("an UNKNOWN status is INCLUDED — never silently hidden", () => {
    assert.equal(isActionable(item({ id: "a", source: "micro", status: "some_future_status" })), true);
    assert.equal(isActionable(item({ id: "b", source: "federal", status: "totally_new_state" })), true);
    assert.equal(isActionable(item({ id: "c", source: "federal", status: null })), true);
    const out = upcomingDeadlines(
      [item({ id: "mystery", source: "federal", status: "totally_new_state", deadline: iso(2) })],
      within,
    );
    assert.deepEqual(out.map((i) => i.id), ["mystery"], "unrecognised status must surface, not vanish");
  });

  it("actionableOnly: false returns the unfiltered set", () => {
    const items = [
      item({ id: "passed", source: "micro", status: "passed", deadline: iso(3) }),
      item({ id: "nobid", source: "federal", status: "triaged_nobid", deadline: iso(4) }),
      item({ id: "live", source: "micro", status: "new", deadline: iso(5) }),
    ];
    const all = upcomingDeadlines(items, { ...within, actionableOnly: false });
    assert.deepEqual(all.map((i) => i.id), ["passed", "nobid", "live"]);
  });

  it("the closed_ prefix rule catches closed_won / closed_lost / closed_no_award", () => {
    for (const status of ["closed_won", "closed_lost", "closed_no_award"]) {
      assert.equal(isActionable(item({ id: status, source: "federal", status })), false, status);
    }
    // but the prefix rule only applies to federal — a hypothetical micro
    // status starting closed_ is unknown there, hence actionable
    assert.equal(isActionable(item({ id: "m", source: "micro", status: "closed_won" })), true);
  });
});

describe("countBySource", () => {
  it("totals correctly across sources — a zero-row source still appears with 0", () => {
    // A missing key would make its filter chip vanish, which reads as a bug.
    const counts = countBySource([
      item({ id: "a", source: "federal" }),
      item({ id: "b", source: "federal" }),
      item({ id: "c", source: "micro" }),
    ]);
    assert.deepEqual(counts, { federal: 2, micro: 1, saved: 0, scout: 0, teaming: 0 });
  });
});

// U-2: the unified /opportunities view — five sources, one shape, filters
// that compose.
describe("unified pipeline (U-2)", () => {
  const fiveSourceItems = () =>
    unifyPipeline(
      [{ id: "fp1", title: "DHA Brief", agency: "DHA", responseDeadline: iso(5), status: "drafting" }],
      [{ id: "mc1", title: "NPS Signage", agency: "NPS", responseDeadline: iso(3), disposition: "new" }],
      [{ id: "sv1", title: "SAMHSA NOFO", agency: "SAMHSA", deadline: iso(9), pipelineStage: null }],
      [{ id: "sc1", title: "County reentry grant", agency: "Harbor DHHS", deadlineText: iso(4), status: "interested" }],
      [{ id: "tm1", title: "Prime seeking SUD sub", agency: "HHS", responseDeadline: iso(6), disposition: "pursuing" }],
    );

  it("normalises all five sources and tags each correctly", () => {
    const items = fiveSourceItems();
    assert.equal(items.length, 5);
    const bySource = Object.fromEntries(items.map((i) => [i.source, i]));
    assert.equal(bySource.federal.id, "fp1");
    assert.equal(bySource.micro.id, "mc1");
    assert.equal(bySource.saved.id, "sv1");
    assert.equal(bySource.scout.id, "sc1");
    assert.equal(bySource.scout.href, "/scouts");
    assert.equal(bySource.scout.status, "interested");
    assert.equal(bySource.teaming.id, "tm1");
    assert.equal(bySource.teaming.href, "/teaming");
    assert.equal(bySource.teaming.status, "pursuing");
  });

  it("filtering by a single source returns only that source", () => {
    const out = filterPipeline(fiveSourceItems(), { sources: ["scout"] });
    assert.deepEqual(out.map((i) => i.id), ["sc1"]);
  });

  it("multi-select returns the union", () => {
    const out = filterPipeline(fiveSourceItems(), { sources: ["federal", "teaming"] });
    assert.deepEqual(out.map((i) => i.id).sort(), ["fp1", "tm1"]);
  });

  it("the actionable toggle composes with source filters — both apply", () => {
    const items = [
      item({ id: "live-micro", source: "micro", status: "new", deadline: iso(2) }),
      item({ id: "dead-micro", source: "micro", status: "passed", deadline: iso(2) }),
      item({ id: "live-teaming", source: "teaming", status: "pursuing", deadline: iso(2) }),
      item({ id: "dead-teaming", source: "teaming", status: "teamed", deadline: iso(2) }),
    ];
    const out = filterPipeline(items, { sources: ["micro"], actionableOnly: true });
    assert.deepEqual(out.map((i) => i.id), ["live-micro"], "source filter and toggle must BOTH apply");
    // and the toggle alone still spans sources
    const toggledOnly = filterPipeline(items, { actionableOnly: true });
    assert.deepEqual(toggledOnly.map((i) => i.id).sort(), ["live-micro", "live-teaming"]);
  });

  it("scout/teaming rows with no deadline do not sort to the top", () => {
    const sorted = sortByDeadline([
      item({ id: "no-deadline-scout", source: "scout", deadline: null }),
      item({ id: "rolling-scout", source: "scout", deadline: "rolling — see notice" }),
      item({ id: "dated-teaming", source: "teaming", deadline: iso(3) }),
      item({ id: "dated-federal", source: "federal", deadline: iso(1) }),
    ]);
    assert.deepEqual(
      sorted.map((i) => i.id),
      ["dated-federal", "dated-teaming", "no-deadline-scout", "rolling-scout"],
      "parseable deadlines first (soonest leading); null/garbage last, never epoch 0",
    );
  });

  it("scout/teaming rows with no deadline do not sort to the top (D-2 guard)", () => {
    // duplicated intent from the sort test above, pinned against isPastDue:
    // no deadline is NOT past due — those rows stay visible by default.
    assert.equal(isPastDue(item({ id: "a", deadline: null }), NOW), false);
    assert.equal(isPastDue(item({ id: "b", deadline: "rolling — see notice" }), NOW), false);
  });

  it("scout dismissed/promoted and teaming passed/teamed count as decided", () => {
    assert.equal(isActionable(item({ id: "a", source: "scout", status: "dismissed" })), false);
    assert.equal(isActionable(item({ id: "b", source: "scout", status: "promoted" })), false);
    assert.equal(isActionable(item({ id: "c", source: "scout", status: "interested" })), true);
    assert.equal(isActionable(item({ id: "d", source: "teaming", status: "passed" })), false);
    assert.equal(isActionable(item({ id: "e", source: "teaming", status: "teamed" })), false);
    assert.equal(isActionable(item({ id: "f", source: "teaming", status: "outreach_drafted" })), true);
    // unknown stays actionable for the new sources too
    assert.equal(isActionable(item({ id: "g", source: "scout", status: "mystery" })), true);
  });
});

// D-2: past-due filtering. Live review found all 69 teaming notices expired
// and 126 of the 292 "actionable" rows carrying elapsed deadlines — status
// said "still open", time said "impossible". The two filters are separate
// questions and must compose; the exclusion is visible and reversible in the
// UI (the view surfaces the excluded count), never silent.
describe("past-due filtering (D-2)", () => {
  // Live-shaped fixture: expired teaming (the whole table, in miniature),
  // expired micro, a future item, and undated scout rows.
  const liveShaped = () => [
    item({ id: "tm-old-1", source: "teaming", status: "new", deadline: iso(-40) }),
    item({ id: "tm-old-2", source: "teaming", status: "pursuing", deadline: iso(-10) }),
    item({ id: "mc-old", source: "micro", status: "new", deadline: iso(-3) }),
    item({ id: "mc-live", source: "micro", status: "new", deadline: iso(3) }),
    item({ id: "sc-undated", source: "scout", status: "interested", deadline: null }),
    item({ id: "sc-rolling", source: "scout", status: "new", deadline: "rolling — see notice" }),
  ];

  it("past-due items are excluded from the default list", () => {
    const out = filterPipeline(liveShaped(), { actionableOnly: true, excludePastDueAsOf: NOW });
    assert.deepEqual(
      out.map((i) => i.id).sort(),
      ["mc-live", "sc-rolling", "sc-undated"],
      "elapsed deadlines drop; future stays",
    );
  });

  it("an item with a NULL (or unparseable) deadline is NOT excluded as past due", () => {
    const out = filterPipeline(liveShaped(), { excludePastDueAsOf: NOW });
    assert.ok(out.some((i) => i.id === "sc-undated"), "no deadline is not past due");
    assert.ok(out.some((i) => i.id === "sc-rolling"), "free-text deadline is not past due");
  });

  it("the past-due count is reported separately and is non-zero against live-shaped fixtures", () => {
    const items = liveShaped();
    const withPast = filterPipeline(items, { actionableOnly: true });
    const withoutPast = filterPipeline(items, { actionableOnly: true, excludePastDueAsOf: NOW });
    const pastDueCount = withPast.length - withoutPast.length;
    assert.equal(pastDueCount, 3, "the exclusion must be countable, not silent");
  });

  it("the status filter and the past-due filter compose — neither overrides the other", () => {
    const items = [
      item({ id: "past+decided", source: "micro", status: "passed", deadline: iso(-2) }),
      item({ id: "past+actionable", source: "micro", status: "new", deadline: iso(-2) }),
      item({ id: "future+decided", source: "micro", status: "passed", deadline: iso(2) }),
      item({ id: "future+actionable", source: "micro", status: "new", deadline: iso(2) }),
    ];
    const both = filterPipeline(items, { actionableOnly: true, excludePastDueAsOf: NOW });
    assert.deepEqual(both.map((i) => i.id), ["future+actionable"], "both filters must apply");
    // each filter alone removes a different pair
    assert.equal(filterPipeline(items, { actionableOnly: true }).length, 2);
    assert.equal(filterPipeline(items, { excludePastDueAsOf: NOW }).length, 2);
    // and the source filter still stacks on top
    const withSource = filterPipeline(items, {
      sources: ["teaming"],
      actionableOnly: true,
      excludePastDueAsOf: NOW,
    });
    assert.equal(withSource.length, 0);
  });

  it("isPastDue is strict: due exactly now is not past due", () => {
    assert.equal(isPastDue(item({ id: "a", deadline: new Date(NOW).toISOString() }), NOW), false);
    assert.equal(isPastDue(item({ id: "b", deadline: iso(-1) }), NOW), true);
    assert.equal(isPastDue(item({ id: "c", deadline: iso(1) }), NOW), false);
  });
});

// Fix 1b (2026-08-04): micro_contracts stores DATE-ONLY deadlines, and
// Date.parse pins a bare date to midnight UTC — 8pm Eastern the evening
// BEFORE the due date. That rendered "due in 7h" against a ~35-hour deadline
// and made D-2 hide micro notices for the whole of their real final day. A
// bare date now parses as end-of-day LOCAL; explicit timestamps are
// untouched. Fixtures below build local date strings from local components so
// the tests hold in every timezone.
describe("bare-date deadlines parse as end-of-day local (1b)", () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const bareLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  it("a bare date for TODAY is NOT past due at any hour of today", () => {
    // The actual user-facing bug: the final day of a micro notice.
    const today = new Date();
    const deadline = bareLocal(today);
    const y = today.getFullYear();
    const m = today.getMonth();
    const d = today.getDate();
    for (const hour of [0, 8, 12, 17, 20, 23]) {
      const at = new Date(y, m, d, hour, 30, 0).getTime();
      assert.equal(
        isPastDue(item({ id: `h${hour}`, deadline }), at),
        false,
        `a notice due today must not be past due at ${hour}:30 local`,
      );
    }
  });

  it("a bare date parses to end-of-day local, not midnight UTC", () => {
    const t = parseDeadlineMs("2026-08-05");
    assert.equal(t, new Date(2026, 7, 5, 23, 59, 59, 999).getTime());
    // and explicitly NOT the old midnight-UTC reading
    assert.notEqual(t, Date.parse("2026-08-05"));
  });

  it("a full ISO timestamp with offset is unchanged — exact epoch", () => {
    // fp_opportunities shape. 14:00 EDT == 18:00 UTC; a shift of even one
    // second fails loudly here.
    assert.equal(parseDeadlineMs("2026-08-06T14:00:00-04:00"), Date.UTC(2026, 7, 6, 18, 0, 0));
    assert.equal(parseDeadlineMs("2026-08-05T00:00:00Z"), Date.UTC(2026, 7, 5, 0, 0, 0));
  });

  it("a bare date for YESTERDAY is past due", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    assert.equal(isPastDue(item({ id: "y", deadline: bareLocal(yesterday) }), Date.now()), true);
  });

  it("garbage and empty still return null — never epoch 0", () => {
    for (const bad of [null, "", "   ", "not-a-date", "rolling — see notice", "2026-99-99"]) {
      assert.equal(parseDeadlineMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("isPastDue boundary", () => {
  it("due exactly now is not past due", () => {
    assert.equal(isPastDue(item({ id: "a", deadline: new Date(NOW).toISOString() }), NOW), false);
    assert.equal(isPastDue(item({ id: "b", deadline: iso(-1) }), NOW), true);
    assert.equal(isPastDue(item({ id: "c", deadline: iso(1) }), NOW), false);
  });
});

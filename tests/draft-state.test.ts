// Draft state machine (V4.1 §14.7).
//
// Before this, drafts.status took any of five values and any value could
// follow any other — a draft could be recorded as "won" without ever having
// been submitted, and a closed record could silently reopen.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  isTerminal,
  isDraftStatus,
  allowedTransitions,
  DRAFT_STATUSES,
  TERMINAL_STATUSES,
  REVIEW_STATUSES,
} from "../lib/draft-state";

describe("status vocabulary", () => {
  it("covers every state §14.7 requires", () => {
    for (const required of [
      "no_go",
      "needs_human_decision",
      "staged_for_review",
      "duplicate",
      "cancelled",
      "expired",
      "blocked_review_required",
      "failed_review_required",
    ]) {
      assert.ok(isDraftStatus(required), `missing required state: ${required}`);
    }
  });

  it("keeps the pre-existing states so old rows stay valid", () => {
    for (const legacy of ["drafting", "auto_drafted", "submitted", "won", "lost"]) {
      assert.ok(isDraftStatus(legacy), `dropped legacy state: ${legacy}`);
    }
  });

  it("rejects anything not in the vocabulary", () => {
    assert.equal(isDraftStatus("in_progress"), false);
    assert.equal(isDraftStatus(""), false);
  });
});

describe("outcomes require a submission", () => {
  it("refuses drafting -> won", () => {
    const r = canTransition("drafting", "won");
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /cannot become "won"/);
  });

  it("refuses staged_for_review -> won", () => {
    assert.equal(canTransition("staged_for_review", "won").ok, false);
  });

  it("allows submitted -> won and submitted -> lost", () => {
    assert.equal(canTransition("submitted", "won").ok, true);
    assert.equal(canTransition("submitted", "lost").ok, true);
  });

  it("still lets a human record a submission they made themselves", () => {
    // GovScout never submits. It records that a person did.
    assert.equal(canTransition("drafting", "submitted").ok, true);
    assert.equal(canTransition("staged_for_review", "submitted").ok, true);
  });
});

describe("terminal states", () => {
  it("classifies the closed outcomes as terminal", () => {
    for (const s of ["won", "lost", "no_go", "duplicate", "cancelled", "expired"] as const) {
      assert.ok(isTerminal(s), `${s} should be terminal`);
      assert.equal(allowedTransitions(s).length, 0);
    }
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ["cancelled", "duplicate", "expired", "lost", "no_go", "won"]);
  });

  it("refuses to leave a terminal state without an explicit reopen", () => {
    const r = canTransition("no_go", "drafting");
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /terminal/);
  });

  it("permits a deliberate reopen back into work", () => {
    assert.equal(canTransition("no_go", "drafting", { reopen: true }).ok, true);
  });

  it("refuses to reopen straight into another outcome", () => {
    // Reopening must return the record to work, not relabel the result.
    assert.equal(canTransition("lost", "won", { reopen: true }).ok, false);
  });

  it("treats re-setting the same status as a no-op, even when terminal", () => {
    assert.equal(canTransition("won", "won").ok, true);
  });
});

describe("review gates", () => {
  it("every review state can reach staged_for_review", () => {
    for (const s of REVIEW_STATUSES) {
      if (s === "staged_for_review") continue;
      assert.ok(
        allowedTransitions(s).includes("staged_for_review"),
        `${s} should be able to reach staged_for_review`,
      );
    }
  });

  it("any in-flight or review record can be closed out", () => {
    for (const s of DRAFT_STATUSES) {
      if (isTerminal(s)) continue;
      const allowed = allowedTransitions(s);
      if (s === "submitted") {
        assert.ok(allowed.includes("cancelled"), "submitted should still be cancellable");
        continue;
      }
      for (const close of ["no_go", "cancelled", "expired", "duplicate"] as const) {
        assert.ok(allowed.includes(close), `${s} should be able to become ${close}`);
      }
    }
  });

  it("a blocked draft cannot jump straight to submitted", () => {
    assert.equal(canTransition("blocked_review_required", "submitted").ok, false);
    assert.equal(canTransition("failed_review_required", "submitted").ok, false);
  });
});

describe("assertTransition", () => {
  it("throws with a reason naming the allowed targets", () => {
    assert.throws(() => assertTransition("drafting", "won"), /invalid status transition/);
    assert.throws(() => assertTransition("drafting", "won"), /Allowed:/);
  });

  it("stays quiet on a valid move", () => {
    assert.doesNotThrow(() => assertTransition("drafting", "staged_for_review"));
  });
});

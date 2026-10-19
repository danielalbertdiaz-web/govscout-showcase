import { test } from "node:test";
import assert from "node:assert/strict";
import { rateForModel, estimateCostUsd } from "../lib/usage";

test("rateForModel maps families by substring and bumps versions", () => {
  // Opus is the priciest.
  assert.equal(rateForModel("claude-opus-4-7").input, 15 / 1_000_000);
  assert.equal(rateForModel("claude-opus-4-8-future").output, 75 / 1_000_000);
  // Sonnet mid.
  assert.equal(rateForModel("claude-sonnet-4-6").input, 3 / 1_000_000);
  // Haiku cheapest.
  assert.equal(rateForModel("claude-haiku-4-5-20251001").input, 1 / 1_000_000);
  // Unknown falls back to Sonnet pricing (never $0).
  assert.equal(rateForModel("some-unknown-model").input, 3 / 1_000_000);
});

test("estimateCostUsd sums input/output at the model rate", () => {
  // Sonnet: 1M input @ $3 + 1M output @ $15 = $18.
  const cost = estimateCostUsd("claude-sonnet-4-6", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - 18) < 1e-9);
});

test("estimateCostUsd bills cache reads at 0.1x and writes at 1.25x input", () => {
  // Opus input rate = $15/M. cacheRead = $1.5/M, cacheWrite = $18.75/M.
  const cost = estimateCostUsd("claude-opus-4-7", {
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - (1.5 + 18.75)) < 1e-9);
});

test("estimateCostUsd is zero for missing usage and handles partial fields", () => {
  assert.equal(estimateCostUsd("claude-opus-4-7", undefined), 0);
  assert.equal(estimateCostUsd("claude-opus-4-7", {}), 0);
  const onlyOutput = estimateCostUsd("claude-haiku-4-5", { output_tokens: 2_000_000 });
  assert.ok(Math.abs(onlyOutput - 10) < 1e-9); // 2M * $5/M
});

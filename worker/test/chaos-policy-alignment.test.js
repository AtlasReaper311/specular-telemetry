import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_FAULTS,
  LIVE_FAULTS,
  TEST_ONLY_FAULTS,
} from "../src/chaos.js";

test("every chaos fault has exactly one capability class", () => {
  const overlap = [...LIVE_FAULTS].filter((fault) => TEST_ONLY_FAULTS.has(fault));
  assert.deepEqual(overlap, []);
  assert.deepEqual(
    [...ALLOWED_FAULTS].sort(),
    [...new Set([...LIVE_FAULTS, ...TEST_ONLY_FAULTS])].sort(),
  );
});

test("production live fault set matches the control-plane policy", () => {
  assert.deepEqual(
    [...LIVE_FAULTS].sort(),
    ["kv_write_reject", "latency", "status_503"],
  );
  assert.deepEqual(
    [...TEST_ONLY_FAULTS].sort(),
    ["stale_response", "webhook_drop"],
  );
});

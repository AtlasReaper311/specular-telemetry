import assert from "node:assert/strict";
import test from "node:test";

import { applyChaos, timingSafeEqual, validateFault } from "../src/chaos.js";

test("timingSafeEqual compares equal and unequal tokens", () => {
  assert.equal(timingSafeEqual("alpha", "alpha"), true);
  assert.equal(timingSafeEqual("alpha", "alpHa"), false);
  assert.equal(timingSafeEqual("short", "longer"), false);
});

test("validateFault rejects unbounded leases", () => {
  const result = validateFault({
    experiment_id: "route-test-001",
    fault: "status_503",
    duration_seconds: 301,
  });
  assert.equal(result.ok, false);
});

test("validateFault accepts a bounded latency experiment", () => {
  const result = validateFault({
    experiment_id: "latency-test-001",
    fault: "latency",
    duration_seconds: 30,
    latency_ms: 500,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.target, "specular-edge");
});

test("applyChaos creates a controlled 503", async () => {
  const result = await applyChaos({
    experiment_id: "route-test-001",
    fault: "status_503",
    expires_at: new Date(Date.now() + 30000).toISOString(),
  });
  assert.equal(result.response.status, 503);
  const body = await result.response.json();
  assert.equal(body.experiment_id, "route-test-001");
});

import assert from "node:assert/strict";
import test from "node:test";

import { handleChaosControl } from "../src/chaos.js";

class MemoryKV {
  constructor() {
    this.values = new Map();
  }

  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function request(fault) {
  return new Request("https://api.atlas-systems.uk/specular/__chaos", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      experiment_id: `${fault}-test-001`,
      fault,
      duration_seconds: 30,
    }),
  });
}

test("control endpoint admits a test-only fault only with the explicit switch", async () => {
  const tasks = [];
  const env = {
    CHAOS_ENABLED: "true",
    CHAOS_ALLOW_TEST_FAULTS: "true",
    CHAOS_TOKEN: "test-token",
    TELEMETRY_KV: new MemoryKV(),
  };
  const response = await handleChaosControl(request("stale_response"), env, {
    waitUntil(task) {
      tasks.push(task);
    },
  });
  await Promise.all(tasks);
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.active.fault, "stale_response");
});

import assert from "node:assert/strict";
import test from "node:test";

import { currentChaos } from "../src/chaos.js";

const CHAOS_KEY = "specular:chaos:active:v1";

test("invalid stored expiry is removed fail-closed", async () => {
  const values = new Map([
    [
      CHAOS_KEY,
      JSON.stringify({
        schema: "atlas-chaos-lease/v1",
        experiment_id: "invalid-expiry-001",
        fault: "status_503",
        expires_at: "not-a-timestamp",
        target: "specular-edge",
      }),
    ],
  ]);
  const notifications = [];
  const tasks = [];
  const env = {
    CHAOS_ENABLED: "true",
    NOTIFY_TOKEN: "notify-token",
    TELEMETRY_KV: {
      async get(key, type) {
        const value = values.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      async delete(key) {
        values.delete(key);
      },
    },
    ATLAS_NOTIFY: {
      async fetch(_url, init) {
        notifications.push(JSON.parse(init.body));
        return new Response(null, { status: 202 });
      },
    },
  };
  const ctx = {
    waitUntil(task) {
      tasks.push(task);
    },
  };

  assert.equal(await currentChaos(env, ctx), null);
  await Promise.all(tasks);
  assert.equal(values.has(CHAOS_KEY), false);
  assert.equal(notifications[0].fields.reason, "invalid_expiry");
});

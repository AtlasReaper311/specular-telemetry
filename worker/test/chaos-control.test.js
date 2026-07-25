import assert from "node:assert/strict";
import test from "node:test";

import {
  currentChaos,
  handleChaosControl,
  validateFault,
} from "../src/chaos.js";

const CHAOS_KEY = "specular:chaos:active:v1";

class MemoryKV {
  constructor() {
    this.values = new Map();
    this.putOptions = new Map();
  }

  async get(key, type) {
    await Promise.resolve();
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value, options = {}) {
    await Promise.resolve();
    this.values.set(key, value);
    this.putOptions.set(key, options);
  }

  async delete(key) {
    await Promise.resolve();
    this.values.delete(key);
  }
}

function createContext() {
  const tasks = [];
  return {
    tasks,
    waitUntil(task) {
      tasks.push(task);
    },
  };
}

function createEnvironment(overrides = {}) {
  const notifications = [];
  return {
    CHAOS_ENABLED: "true",
    CHAOS_TOKEN: "test-token",
    NOTIFY_TOKEN: "notify-token",
    TELEMETRY_KV: new MemoryKV(),
    ATLAS_NOTIFY: {
      async fetch(_url, init) {
        notifications.push(JSON.parse(init.body));
        return new Response(null, { status: 202 });
      },
    },
    notifications,
    ...overrides,
  };
}

function controlRequest(method, payload = null, token = "test-token") {
  const headers = { authorization: `Bearer ${token}` };
  const options = { method, headers };
  if (payload !== null) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  return new Request("https://api.atlas-systems.uk/specular/__chaos", options);
}

function faultPayload(experimentId = "route-test-001") {
  return {
    experiment_id: experimentId,
    fault: "status_503",
    duration_seconds: 30,
  };
}

async function settle(context) {
  await Promise.all(context.tasks);
}

test("control route is absent while chaos is disabled", async () => {
  const env = createEnvironment({ CHAOS_ENABLED: "false" });
  const response = await handleChaosControl(controlRequest("GET"), env, createContext());
  assert.equal(response.status, 404);
});

test("control route rejects unauthenticated requests", async () => {
  const env = createEnvironment();
  const response = await handleChaosControl(controlRequest("GET", null, "wrong-token"), env, createContext());
  assert.equal(response.status, 401);
});

test("control route rejects unsupported and unbounded faults", async () => {
  const env = createEnvironment();
  const unsupported = await handleChaosControl(
    controlRequest("POST", { ...faultPayload(), fault: "disk_destroy" }),
    env,
    createContext(),
  );
  assert.equal(unsupported.status, 422);

  const unbounded = await handleChaosControl(
    controlRequest("POST", { ...faultPayload(), duration_seconds: 301 }),
    env,
    createContext(),
  );
  assert.equal(unbounded.status, 422);
});

test("test-only faults require an explicit non-production switch", async () => {
  const rejected = validateFault({
    ...faultPayload("stale-test-001"),
    fault: "stale_response",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /test-only fault/);

  const accepted = validateFault(
    {
      ...faultPayload("stale-test-001"),
      fault: "stale_response",
    },
    { allowTestFaults: true },
  );
  assert.equal(accepted.ok, true);
});

test("an active lease cannot be overwritten", async () => {
  const env = createEnvironment();
  const firstContext = createContext();
  const first = await handleChaosControl(
    controlRequest("POST", faultPayload("route-test-001")),
    env,
    firstContext,
  );
  assert.equal(first.status, 202);
  await settle(firstContext);

  const second = await handleChaosControl(
    controlRequest("POST", faultPayload("route-test-002")),
    env,
    createContext(),
  );
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.active.experiment_id, "route-test-001");

  const active = await env.TELEMETRY_KV.get(CHAOS_KEY, "json");
  assert.equal(active.experiment_id, "route-test-001");
});

test("same-isolate concurrent activation admits only one lease", async () => {
  const env = createEnvironment();
  const leftContext = createContext();
  const rightContext = createContext();
  const [left, right] = await Promise.all([
    handleChaosControl(
      controlRequest("POST", faultPayload("route-race-001")),
      env,
      leftContext,
    ),
    handleChaosControl(
      controlRequest("POST", faultPayload("route-race-002")),
      env,
      rightContext,
    ),
  ]);

  assert.deepEqual([left.status, right.status].sort(), [202, 409]);
  await settle(leftContext);
  await settle(rightContext);

  const active = await env.TELEMETRY_KV.get(CHAOS_KEY, "json");
  assert.ok(["route-race-001", "route-race-002"].includes(active.experiment_id));
  assert.equal(env.TELEMETRY_KV.putOptions.get(CHAOS_KEY).expirationTtl, 3630);
});

test("passive expiry removes the lease and emits recovery evidence", async () => {
  const env = createEnvironment();
  const expired = {
    schema: "atlas-chaos-lease/v1",
    experiment_id: "route-expired-001",
    fault: "status_503",
    duration_seconds: 30,
    latency_ms: 0,
    activated_at: new Date(Date.now() - 60000).toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    target: "specular-edge",
  };
  await env.TELEMETRY_KV.put(CHAOS_KEY, JSON.stringify(expired));

  const context = createContext();
  const active = await currentChaos(env, context);
  assert.equal(active, null);
  assert.equal(await env.TELEMETRY_KV.get(CHAOS_KEY, "json"), null);
  await settle(context);

  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0].level, "success");
  assert.equal(env.notifications[0].fields.phase, "recovered");
  assert.equal(env.notifications[0].fields.reason, "lease_expired");
});

test("explicit rollback emits distinct recovery evidence", async () => {
  const env = createEnvironment();
  const context = createContext();
  const activated = await handleChaosControl(
    controlRequest("POST", faultPayload("route-delete-001")),
    env,
    context,
  );
  assert.equal(activated.status, 202);
  await settle(context);
  env.notifications.length = 0;

  const deleteContext = createContext();
  const rolledBack = await handleChaosControl(
    controlRequest("DELETE"),
    env,
    deleteContext,
  );
  assert.equal(rolledBack.status, 200);
  await settle(deleteContext);

  assert.equal(env.notifications.length, 1);
  assert.equal(env.notifications[0].fields.phase, "recovered");
  assert.equal(env.notifications[0].fields.reason, "explicit_delete");
});
